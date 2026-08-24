import { afterEach, describe, expect, it, vi } from 'vitest'

import { flush, liveMessage, makeHarness, start, StubSocket } from './support/harness'

afterEach(() => {
  StubSocket.reset()
  vi.useRealTimers()
})

describe('the engine drives audio and both sessions through the sink', () => {
  it('sends the same audio to both targets and each socket carries its pinned setup', async () => {
    const { engine, mint } = makeHarness()
    // A mint that returns a per-target marker so the setup frame is checkable.
    mint.calls.length = 0
    const [vi, en] = await start(engine)

    expect(vi.url).toContain('.GenerativeService.BidiGenerateContentConstrained?access_token=')
    expect(vi.url).not.toContain('BidiGenerateContent?')
    expect(JSON.parse(vi.sent[0]!)).toHaveProperty('setup')

    engine.pushAudio('pcm16-chunk')
    expect(JSON.parse(vi.sent[1]!).realtimeInput.audio.data).toBe('pcm16-chunk')
    expect(JSON.parse(en.sent[1]!).realtimeInput.audio.data).toBe('pcm16-chunk')
  })

  it('streams gated silence to both sessions without opening a speech run', async () => {
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)

    engine.pushAudio('silence-zeros', false)
    expect(JSON.parse(vi.sent[1]!).realtimeInput.audio.data).toBe('silence-zeros')
    expect(JSON.parse(en.sent[1]!).realtimeInput.audio.data).toBe('silence-zeros')

    vi.receive(liveMessage('Xin chào', 'Hello'))
    await flush()
    expect(engine.latency.captureToFirstText.vi).toBeNull()
    void sink
  })

  it('prepares the sink and announces itself live on start', async () => {
    // `onStatus` fires on every transition (in-memory); `publishStatus` fires
    // on state writes, which begin at 'live' — so 'connecting' reaches the
    // callback but not the sink, exactly as it did in production.
    const observed: string[] = []
    const { engine, sink } = makeHarness({ onStatus: (s) => observed.push(s) })
    await start(engine)
    await flush()
    expect(sink.prepared).toBe(1)
    expect(observed).toContain('connecting')
    expect(sink.statuses.at(-1)).toBe('live')
  })

  it('publishes a merged final from the translating session', async () => {
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)

    vi.receive(liveMessage('Hello', 'Xin chào', true))
    await flush()
    en.receive(liveMessage('Hello', 'Hello', true))
    await flush()

    const finals = sink.finals()
    expect(finals).toHaveLength(1)
    expect(finals[0]!.utterance).toMatchObject({
      utteranceId: 'u0',
      sourceLang: 'en',
      original: 'Hello',
      translated: 'Xin chào',
    })
  })

  it('preserves Vietnamese source text via the output transcription', async () => {
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)
    en.receive(liveMessage('Xin chào', 'Hello', true))
    await flush()
    vi.receive(liveMessage('Xin chào', 'Xin chào', true))
    await flush()
    expect(sink.finals()[0]!.utterance).toMatchObject({ sourceLang: 'vi', original: 'Xin chào', translated: 'Hello' })
  })

  it('never publishes a bubble until both display languages have text', async () => {
    const { engine, sink } = makeHarness()
    const [vi] = await start(engine)
    vi.receive({ serverContent: { inputTranscription: { text: 'Hello' } } })
    await flush()
    expect(sink.published).toHaveLength(0)
  })

  it('holds only the newest partial until the next 250 ms slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T03:00:00.000Z'))
    const { engine, sink } = makeHarness()
    const [viTarget] = await start(engine)

    viTarget.receive(liveMessage('Hello', 'Xin chào'))
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    viTarget.receive(liveMessage(' every', ' mọi'))
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    viTarget.receive(liveMessage('one', ' người'))
    await flush()
    expect(sink.partials()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)
    await flush()
    const partials = sink.partials()
    expect(partials).toHaveLength(2)
    expect(partials[1]!.utterance).toMatchObject({ original: 'Hello everyone', translated: 'Xin chào mọi người' })
  })

  it('finalizes an idle turn once, within one poll of the threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T03:00:00.000Z'))
    const { engine, sink } = makeHarness()
    const [viTarget] = await start(engine)

    await vi.advanceTimersByTimeAsync(251)
    viTarget.receive(liveMessage('Hello', 'Xin chào'))
    await flush()
    await vi.advanceTimersByTimeAsync(1_400)
    await flush()
    expect(sink.finals()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(350)
    await flush()
    expect(sink.finals()).toHaveLength(1)
    expect(sink.finals()[0]!.utterance).toMatchObject({ original: 'Hello', translated: 'Xin chào' })
  })

  it('lets a final supersede a pending partial immediately', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T03:00:00.000Z'))
    const { engine, sink } = makeHarness()
    const [viTarget, enTarget] = await start(engine)

    viTarget.receive(liveMessage('Hello', 'Xin chào'))
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    viTarget.receive(liveMessage(' everyone', ' mọi người', true))
    await flush()
    enTarget.receive(liveMessage('Hello everyone', 'Hello everyone', true))
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()

    expect(sink.finals()).toHaveLength(1)
    expect(sink.published.at(-1)!.utterance).toMatchObject({ original: 'Hello everyone', translated: 'Xin chào mọi người' })
    expect(sink.published.at(-1)!.final).toBe(true)
  })

  it('takes a published partial off the surface when its turn retires unpublishable', async () => {
    const { engine, sink } = makeHarness()
    const [viTarget, enTarget] = await start(engine)

    viTarget.receive(liveMessage('Blockchain blockchain', 'Karaoke karaoke'))
    await flush()
    expect(sink.partials()).toHaveLength(1)

    enTarget.receive(liveMessage('Blockchain blockchain', 'Karaoke karaoke', true))
    viTarget.receive({ serverContent: { turnComplete: true } })
    await flush()
    expect(sink.retracted).toEqual(['u0'])
  })

  it('a forced direction labels and publishes what Auto would retract', async () => {
    const { engine, sink } = makeHarness({ forcedSourceLang: 'vi' })
    const [viTarget, enTarget] = await start(engine)

    viTarget.receive(liveMessage('Blockchain blockchain', 'Karaoke karaoke'))
    enTarget.receive(liveMessage('Blockchain blockchain', 'Karaoke karaoke', true))
    viTarget.receive({ serverContent: { turnComplete: true } })
    await flush()

    expect(sink.finals()).toHaveLength(1)
    expect(sink.finals()[0]!.utterance.sourceLang).toBe('vi')
    expect(sink.retracted).toEqual([])
  })

  it('degrades rather than throwing when the sink refuses a write', async () => {
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)
    sink.acceptWrites = false

    vi.receive(liveMessage('Hello', 'Xin chào', true))
    en.receive(liveMessage('Hello', 'Hello', true))
    await flush()
    expect(engine.currentStatus).toBe('degraded')
  })

  it('recovers from a transient write failure instead of latching degraded', async () => {
    // A store timeout or a 503 is not a socket outage. Setting `degraded`
    // directly pinned the feed there for the rest of the session — nothing
    // re-derived once writes started landing again, and the 4 s heartbeat
    // republished it, so every surface read "one direction interrupted" while
    // both sockets were live and every write was landing.
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)
    expect(engine.currentStatus).toBe('live')

    const accept = sink.publish.bind(sink)
    let failing = true
    sink.publish = async (utterance, final) => {
      if (failing) throw new Error('store timeout')
      return accept(utterance, final)
    }

    vi.receive(liveMessage('Hello', 'Xin chào', true))
    en.receive(liveMessage('Hello', 'Hello', true))
    await flush()
    expect(engine.currentStatus).toBe('degraded')

    // The store comes back.
    failing = false
    vi.receive(liveMessage('Again', 'Lại nữa', true))
    en.receive(liveMessage('Again', 'Again', true))
    await flush()
    expect(engine.currentStatus).toBe('live')
  })

  it('does not let a landing write paper over a dropped direction', async () => {
    // The store's verdict only ever pulls `live` down; it can never report a
    // feed healthier than its sockets are.
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)
    sink.acceptWrites = false

    vi.receive(liveMessage('Hello', 'Xin chào', true))
    en.receive(liveMessage('Hello', 'Hello', true))
    await flush()
    expect(engine.currentStatus).toBe('degraded')

    en.close()
    await flush()
    sink.acceptWrites = true
    vi.receive(liveMessage('Again', 'Lại nữa', true))
    en.receive(liveMessage('Again', 'Again', true))
    await flush()
    expect(engine.currentStatus).toBe('degraded') // one socket, not recovered
  })

  it('publishes no device id or operator identifier in the utterance', async () => {
    const { engine, sink } = makeHarness()
    const [vi, en] = await start(engine)
    vi.receive(liveMessage('Hello', 'Xin chào', true))
    en.receive(liveMessage('Hello', 'Hello', true))
    await flush()
    const keys = Object.keys(sink.finals()[0]!.utterance).join(' ').toLowerCase()
    expect(keys).not.toContain('device')
    expect(keys).not.toContain('operator')
    expect(keys).not.toContain('lease')
  })
})

describe('latency measurement', () => {
  it('measures a run from its onset, one sample per run per target', async () => {
    const { engine } = makeHarness()
    const [viTarget] = await start(engine)

    const onset = Date.now() - 600
    engine.noteChunkArrival(onset)
    engine.noteChunkArrival(onset + 100)
    engine.noteChunkArrival(onset + 200)
    viTarget.receive(liveMessage('Xin', 'Hel'))
    viTarget.receive(liveMessage('Xin chào', 'Hello'))
    await flush()

    const sample = engine.latency.captureToFirstText.vi!
    expect(sample.count).toBe(1)
    expect(sample.p50).toBeGreaterThanOrEqual(500)
  })

  it('samples each target separately, so one slow socket is visible alone', async () => {
    const { engine } = makeHarness()
    const [vi, en] = await start(engine)
    engine.noteChunkArrival(Date.now() - 300)
    vi.receive(liveMessage('Xin chào', 'Hello'))
    await flush()
    expect(engine.latency.captureToFirstText.vi).not.toBeNull()
    expect(engine.latency.captureToFirstText.en).toBeNull()
    en.receive(liveMessage('Xin chào', 'Xin chào'))
    await flush()
    expect(engine.latency.captureToFirstText.en).not.toBeNull()
  })

  it('does not let a new speech run steal the sample an older one is owed', async () => {
    const { engine } = makeHarness()
    const [vi] = await start(engine)
    const first = Date.now() - 2_700
    engine.noteChunkArrival(first)
    engine.noteChunkArrival(first + 1_000)
    engine.noteChunkArrival(first + 2_200)
    vi.receive(liveMessage('Xin chào', 'Hello'))
    await flush()
    const sample = engine.latency.captureToFirstText.vi!
    expect(sample.p50).toBeGreaterThanOrEqual(2_500)
    expect(sample.worst).toBeGreaterThanOrEqual(2_500)
  })

  it('does not charge our own Blob decode to the model', async () => {
    class SlowBlob extends Blob {
      override async text(): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return super.text()
      }
    }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T03:00:00.000Z'))
    const { engine } = makeHarness()
    const [viTarget] = await start(engine)

    engine.noteChunkArrival(Date.now())
    viTarget.onmessage!({ data: new SlowBlob([JSON.stringify(liveMessage('Xin chào', 'Hello'))]) })
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(engine.latency.captureToFirstText.vi!.worst).toBeLessThan(300)
  })
})

describe('a restarted engine does not carry the last session forward', () => {
  it('does not publish the previous session\'s open turn into the next one', async () => {
    // The coordinator kept every turn still open at stop(), with its
    // fragments. On the next start the first idle poll found them quiet,
    // retired them as finals, and the new session opened with speech from
    // before the operator pressed stop, carrying pre-stop timestamps.
    vi.useFakeTimers()
    const { engine, sink } = makeHarness()
    const [first] = await start(engine)
    // An utterance left mid-flight: text arrived, no turnComplete, no idle gap.
    first.receive(liveMessage('Something said before stop', 'Điều gì đó', false))
    await flush()
    await engine.stop()
    sink.published.length = 0

    await start(engine)
    // Well past the idle threshold: anything the coordinator still held would
    // have retired by now.
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()

    const texts = sink.published.map((p) => p.utterance.original)
    expect(texts).not.toContain('Something said before stop')
    expect(sink.published).toHaveLength(0)
  })

  it('does not leave the previous run\'s heartbeat running after a second start', async () => {
    // start() twice with no stop orphaned both intervals: nothing held their
    // handles, so they ran for the life of the page — the status heartbeat
    // doubled and the idle poll ran twice per tick forever.
    vi.useFakeTimers()
    const { engine, sink } = makeHarness()
    await start(engine)
    await start(engine)
    sink.statuses.length = 0

    await vi.advanceTimersByTimeAsync(4_000)
    await flush()
    // One heartbeat per interval tick, not two.
    expect(sink.statuses).toHaveLength(1)

    await engine.stop()
    sink.statuses.length = 0
    await vi.advanceTimersByTimeAsync(20_000)
    await flush()
    // And stop() reaches every timer that survived the restart.
    expect(sink.statuses).toHaveLength(0)
  })
})

describe('isolation', () => {
  it('keeps two engines\' sinks and measurements apart', async () => {
    const a = makeHarness()
    const b = makeHarness()
    const [aVi, aEn] = await start(a.engine)
    const [bVi, bEn] = await start(b.engine)

    aVi.receive(liveMessage('Room A', 'Phòng A', true))
    aEn.receive(liveMessage('Room A', 'Room A', true))
    bVi.receive(liveMessage('Room B', 'Phòng B', true))
    bEn.receive(liveMessage('Room B', 'Room B', true))
    await flush()

    expect(a.sink.finals()).toHaveLength(1)
    expect(b.sink.finals()).toHaveLength(1)
    expect(a.sink.finals()[0]!.utterance.original).toBe('Room A')
    expect(b.sink.finals()[0]!.utterance.original).toBe('Room B')
  })
})
