/**
 * Coalescing publication outbox.
 *
 * Physical writes remain FIFO, but queued partials are replaceable and a final
 * replaces any not-yet-started partial for the same utterance. Feed state is
 * separately coalesced and cannot be written more often than its configured
 * interval.
 *
 * The engine decides *when* to write; the sink decides where. This is the
 * "when": everything that reaches `writeSegment`/`writeState` has already been
 * throttled, coalesced and ordered.
 */

export interface PublicationOutboxOptions<T> {
  minStateIntervalMs: number
  now?: () => number
  writeSegment: (utteranceId: string, value: T, final: boolean) => Promise<void>
  writeState: () => Promise<void>
}

interface SegmentJob<T> {
  utteranceId: string
  value: T
  final: boolean
  order: number
}

const STANDARD_UTTERANCE_ID = /^u(\d+)$/
const MAX_NONSTANDARD_UTTERANCE_ORDERS = 128

export class PublicationOutbox<T> {
  private readonly now: () => number
  private readonly jobs: SegmentJob<T>[] = []
  private readonly queuedByUtterance = new Map<string, SegmentJob<T>>()
  /** Coordinator IDs carry their own order; this bounded fallback is defensive. */
  private readonly nonstandardOrderByUtterance = new Map<string, number>()
  private nextUtteranceOrder = 0
  private stateDirty = false
  /** Set by `requestState({immediate})`; consumed by the next drain pass. */
  private stateImmediate = false
  private lastStateWriteAt = -Infinity
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly options: PublicationOutboxOptions<T>) {
    this.now = options.now ?? (() => Date.now())
  }

  offerPartial(utteranceId: string, value: T): void {
    const existing = this.queuedByUtterance.get(utteranceId)
    if (existing) {
      if (!existing.final) existing.value = value
      return
    }
    this.enqueue({ utteranceId, value, final: false, order: this.orderFor(utteranceId) })
  }

  offerFinal(utteranceId: string, value: T): void {
    const existing = this.queuedByUtterance.get(utteranceId)
    if (existing) {
      existing.value = value
      existing.final = true
      return
    }
    // A final must not sit behind stale partials for later turns.
    const job = { utteranceId, value, final: true, order: this.orderFor(utteranceId) }
    this.insertOrdered(job)
    this.queuedByUtterance.set(utteranceId, job)
    this.kick()
  }

  /**
   * `immediate` bypasses the caption-state interval, the way
   * `WriteThrottle.acquireForFinal()` does for a completed turn.
   *
   * The interval exists to rate-limit caption *churn* while a feed is running.
   * A feed that has stopped is not churn, and the sink's surface may be the
   * only one there is: without this, both sockets closing in the same tick
   * wrote `degraded` and then left `unavailable` sitting behind the 500 ms
   * slot, so the surface reported a half-working feed for half a second after
   * it was dead.
   */
  requestState({ immediate = false }: { immediate?: boolean } = {}): Promise<void> {
    this.stateDirty = true
    if (immediate) {
      this.stateImmediate = true
      // A slot already scheduled would otherwise keep `whenIdle()` pending
      // until it fires, delaying the `stop()` that is awaiting this.
      if (this.stateTimer) {
        clearTimeout(this.stateTimer)
        this.stateTimer = null
      }
    }
    this.kick()
    return this.whenIdle()
  }

  discardSegments(): void {
    this.jobs.length = 0
    this.queuedByUtterance.clear()
    this.nonstandardOrderByUtterance.clear()
  }

  /**
   * Drops the queued (not-yet-started) write for one utterance, if any. Used
   * by retraction: a job already handed to `writeSegment` is the caller's to
   * unwind, but a queued one must never start.
   */
  discardSegment(utteranceId: string): void {
    const job = this.queuedByUtterance.get(utteranceId)
    if (!job) return
    this.queuedByUtterance.delete(utteranceId)
    const index = this.jobs.indexOf(job)
    if (index !== -1) this.jobs.splice(index, 1)
  }

  private enqueue(job: SegmentJob<T>): void {
    this.insertOrdered(job)
    this.queuedByUtterance.set(job.utteranceId, job)
    this.kick()
  }

  private insertOrdered(job: SegmentJob<T>): void {
    const index = this.jobs.findIndex((candidate) => candidate.order > job.order)
    if (index === -1) this.jobs.push(job)
    else this.jobs.splice(index, 0, job)
  }

  private orderFor(utteranceId: string): number {
    // The coordinator's IDs are ordered turn ordinals (`u0`, `u1`, …). Keep
    // that order even if an earlier turn first becomes displayable after a
    // later turn has already offered a partial.
    const ordinal = STANDARD_UTTERANCE_ID.exec(utteranceId)
    if (ordinal) {
      const order = Number(ordinal[1])
      this.nextUtteranceOrder = Math.max(this.nextUtteranceOrder, order + 1)
      return order
    }

    const existing = this.nonstandardOrderByUtterance.get(utteranceId)
    if (existing !== undefined) return existing

    const next = this.nextUtteranceOrder
    this.nextUtteranceOrder += 1
    if (this.nonstandardOrderByUtterance.size >= MAX_NONSTANDARD_UTTERANCE_ORDERS) {
      const oldest = this.nonstandardOrderByUtterance.keys().next().value as string | undefined
      if (oldest !== undefined) this.nonstandardOrderByUtterance.delete(oldest)
    }
    this.nonstandardOrderByUtterance.set(utteranceId, next)
    return next
  }

  private kick(): void {
    if (this.draining) return
    this.draining = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (true) {
        if (this.stateDirty) {
          const remaining = this.options.minStateIntervalMs - (this.now() - this.lastStateWriteAt)
          if (remaining <= 0 || this.stateImmediate) {
            this.stateDirty = false
            this.stateImmediate = false
            this.lastStateWriteAt = this.now()
            await this.options.writeState()
            // A segment or another state request may have arrived while the
            // state write was in flight. Check both again before continuing.
            continue
          }
          if (this.jobs.length === 0) {
            this.scheduleState(remaining)
            return
          }
        }

        if (this.jobs.length === 0) return
        const job = this.jobs.shift()!
        this.queuedByUtterance.delete(job.utteranceId)
        await this.options.writeSegment(job.utteranceId, job.value, job.final)
      }
    } finally {
      this.draining = false
      if (this.jobs.length > 0 || (this.stateDirty && !this.stateTimer)) this.kick()
      this.resolveIdleIfReady()
    }
  }

  private scheduleState(delay: number): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.kick()
    }, delay)
  }

  private whenIdle(): Promise<void> {
    if (!this.draining && this.jobs.length === 0 && !this.stateDirty && !this.stateTimer) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private resolveIdleIfReady(): void {
    if (this.draining || this.jobs.length > 0 || this.stateDirty || this.stateTimer) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}
