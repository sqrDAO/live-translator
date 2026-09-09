/**
 * Latency sampling.
 *
 * Operator diagnostics record the measured end-to-end latency per session,
 * because the engine does not control a venue's audio chain and latency is
 * reported rather than warranted. This is the instrument.
 *
 * Pure, with an injectable clock, following `./throttle` — the engine it
 * serves cannot be unit-tested without a live socket, and a measurement whose
 * own arithmetic is unverified is worse than none.
 *
 * p50 and worst, never a mean: the samples are known to contain occasional
 * overstatements (onset pairing: see `engine.ts`, `noteChunkArrival`), and a
 * mean lets one of those move a number that gets reported to a client.
 */

export interface LatencySnapshot {
  /** Median over the retained window, rounded to the millisecond. */
  p50: number
  /** Nearest-rank 95th percentile over the retained window. */
  p95: number
  /** Largest sample since the tracker was created. Not windowed. */
  worst: number
  /** Every sample ever recorded, not just the retained ones. */
  count: number
}

/** Enough to cover a session's speech runs without growing without bound. */
const DEFAULT_CAPACITY = 256

export class LatencyTracker {
  private readonly samples: number[] = []
  private worstMs = 0
  private total = 0

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) throw new Error('capacity must be positive')
  }

  /**
   * A negative or non-finite sample is dropped rather than recorded.
   *
   * `Date.now()` is wall clock: an NTP correction mid-session can make a later
   * timestamp read earlier than the one it is subtracted from. Recording the
   * negative result would drag p50 toward a latency no room ever saw.
   */
  record(ms: number): boolean {
    if (!Number.isFinite(ms) || ms < 0) return false

    this.total += 1
    // `worst` is all-time while p50 is windowed: the window keeps the median
    // representative of the room now, but the worst case is a fact about the
    // session and must not age out of the report.
    if (ms > this.worstMs) this.worstMs = ms

    this.samples.push(ms)
    if (this.samples.length > this.capacity) this.samples.shift()
    return true
  }

  /** `null` until a sample exists, so a panel shows "—" rather than "0 ms". */
  get snapshot(): LatencySnapshot | null {
    if (this.samples.length === 0) return null
    return {
      p50: median(this.samples),
      p95: Math.round([...this.samples].sort((a, b) => a - b)[Math.ceil(this.samples.length * 0.95) - 1]!),
      worst: Math.round(this.worstMs),
      count: this.total,
    }
  }

  reset(): void {
    this.samples.length = 0
    this.worstMs = 0
    this.total = 0
  }
}

/**
 * Lower median on an even count, rather than averaging the middle pair.
 *
 * Averaging would synthesise a figure no measurement produced, which is the
 * same objection that rules out a mean.
 */
function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b)
  return Math.round(ordered[Math.floor((ordered.length - 1) / 2)] ?? 0)
}
