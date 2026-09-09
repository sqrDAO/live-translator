import { describe, expect, it } from 'vitest'

import { LatencyTracker } from '../src/transcript/latency'
import { PublicationOutbox } from '../src/transcript/outbox'
import { WriteThrottle } from '../src/transcript/throttle'

describe('latency sampling', () => {
  it('reports nothing until a sample exists', () => {
    expect(new LatencyTracker().snapshot).toBeNull()
  })

  it('reports p50, worst and an all-time count', () => {
    const tracker = new LatencyTracker()
    for (const sample of [100, 900, 300, 200, 400]) tracker.record(sample)
    expect(tracker.snapshot).toEqual({ p50: 300, p95: 900, worst: 900, count: 5 })
  })

  it('keeps the worst case after it has aged out of the p50 window', () => {
    const tracker = new LatencyTracker(4)
    tracker.record(5_000)
    for (const sample of [10, 10, 10, 10]) tracker.record(sample)
    expect(tracker.snapshot).toMatchObject({ p50: 10, worst: 5_000, count: 5 })
  })

  it('computes a windowed p95 independently of the all-time worst', () => {
    const tracker = new LatencyTracker(20)
    tracker.record(10_000)
    for (let sample = 1; sample <= 20; sample++) tracker.record(sample)
    expect(tracker.snapshot).toEqual({ p50: 10, p95: 19, worst: 10_000, count: 21 })
    tracker.reset()
    expect(tracker.snapshot).toBeNull()
  })

  it('drops a negative sample (an NTP correction mid-session) rather than recording it', () => {
    const tracker = new LatencyTracker()
    tracker.record(-250)
    expect(tracker.snapshot).toBeNull()
  })
})

describe('write throttle', () => {
  it('rate-limits partials but never a final', () => {
    let clock = 0
    const throttle = new WriteThrottle({ minIntervalMs: 250, now: () => clock })
    expect(throttle.tryAcquire()).toBe(true)
    expect(throttle.tryAcquire()).toBe(false)
    clock += 125
    expect(throttle.tryAcquire()).toBe(false)
    clock += 150
    expect(throttle.tryAcquire()).toBe(true)
    throttle.acquireForFinal()
    expect(throttle.msUntilNextSlot()).toBe(250)
  })
})

describe('coalescing outbox', () => {
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }

  it('coalesces queued partials and lets a final replace them', async () => {
    const writes: Array<{ id: string; value: string; final: boolean }> = []
    const pending: Array<() => void> = []
    const outbox = new PublicationOutbox<string>({
      minStateIntervalMs: 500,
      writeSegment: (id, value, final) => {
        writes.push({ id, value, final })
        return new Promise<void>((resolve) => pending.push(resolve))
      },
      writeState: async () => {},
    })

    outbox.offerPartial('u0', 'in flight')
    await flush()
    outbox.offerPartial('u1', 'stale')
    outbox.offerPartial('u1', 'newest')
    outbox.offerFinal('u1', 'final')

    expect(writes).toEqual([{ id: 'u0', value: 'in flight', final: false }])
    pending.shift()!()
    await flush()
    expect(writes).toEqual([
      { id: 'u0', value: 'in flight', final: false },
      { id: 'u1', value: 'final', final: true },
    ])
    pending.shift()!()
  })

  it('does not retain an unbounded order map for completed standard ids', async () => {
    const outbox = new PublicationOutbox<string>({
      minStateIntervalMs: 500,
      writeSegment: async () => {},
      writeState: async () => {},
    })
    const internal = outbox as unknown as { nonstandardOrderByUtterance: Map<string, number> }
    for (let turn = 0; turn < 1_000; turn += 1) outbox.offerPartial(`u${turn}`, String(turn))
    expect(internal.nonstandardOrderByUtterance.size).toBe(0)
  })
})
