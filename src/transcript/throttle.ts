/**
 * Publisher write throttling.
 *
 *   * merge incremental fragments by utterance ID (see ./merge)
 *   * write a partial no more often than the configured floor
 *   * write final segments when a turn retires, bypassing the floor
 *
 * Pure timing logic with an injectable clock so the unit tests do not sleep.
 *
 * `hasPendingWrite` was dropped in the port: it was reachable only from its
 * own test, and a public surface other projects hold us to must not carry
 * members nothing uses.
 */

export interface ThrottleOptions {
  /** Floor between writes. The engine uses 250 ms for partials. */
  minIntervalMs?: number
  now?: () => number
}

export class WriteThrottle {
  private lastWriteAt = -Infinity
  private readonly minIntervalMs: number
  private readonly now: () => number

  constructor(options: ThrottleOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 500
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * @returns true when a write may proceed now. A `false` result means the
   * caller should hold the value; `msUntilNextSlot()` says how long.
   */
  tryAcquire(): boolean {
    const now = this.now()
    if (now - this.lastWriteAt < this.minIntervalMs) return false
    this.lastWriteAt = now
    return true
  }

  /**
   * Final segments bypass the interval: a completed turn is written
   * immediately so the last line on a phone is never a stale partial.
   */
  acquireForFinal(): void {
    this.lastWriteAt = this.now()
  }

  msUntilNextSlot(): number {
    const elapsed = this.now() - this.lastWriteAt
    return Math.max(0, this.minIntervalMs - elapsed)
  }
}

/*
 * `SequenceCounter` used to live here. A monotonic write sequence is a
 * property of one host's store (it mirrors that store's write rules), so it
 * moved behind the `CaptionSink` port with the rest of the persistence half.
 */
