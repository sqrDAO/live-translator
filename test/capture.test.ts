import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AudioCapture,
  DEFAULT_DEVICE_STORAGE_KEY,
  type CaptureOptions,
} from '../src/audio/capture'

/**
 * `AudioCapture` against fake browser globals. The suite has no jsdom (see
 * vitest.config.ts: `environment: 'node'`), and none is needed — the race this
 * covers is settled before the graph is ever built, so the worklet module load
 * is parked and never resolves.
 */

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
  label: string
  getSettings: () => { deviceId: string }
}

interface FakeStream {
  tracks: FakeTrack[]
  getTracks: () => FakeTrack[]
  getAudioTracks: () => FakeTrack[]
}

function fakeStream(label: string): FakeStream {
  const tracks: FakeTrack[] = [
    { stop: vi.fn(), label, getSettings: () => ({ deviceId: `dev-${label}` }) },
  ]
  return { tracks, getTracks: () => tracks, getAudioTracks: () => tracks }
}

class FakeAudioContext {
  state = 'running'
  sampleRate = 48_000
  destination = {}
  // Parks every start just past the point this test cares about: the stream is
  // assigned, the graph is not yet built.
  audioWorklet: { addModule: () => Promise<void> } = {
    addModule: () => new Promise<void>(() => {}),
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.state = 'closed'
  }
  createMediaStreamSource(): unknown {
    return { connect: () => {} }
  }
  createGain(): unknown {
    return { gain: { value: 0 }, connect: () => ({ connect: () => {} }) }
  }
}

function installBrowserGlobals(getUserMedia: (c: unknown) => Promise<unknown>): void {
  vi.stubGlobal('window', {
    AudioContext: FakeAudioContext,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:worklet' })
}

const options = (): CaptureOptions => ({
  onChunk: () => {},
  onError: () => {},
})

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a superseded start never disposes the capture that replaced it', () => {
  it('releases its own stream when it is superseded AND throws', async () => {
    // The catch returned early on a stale generation without releasing. Start
    // #1 must therefore get past the first generation check (so it owns the
    // field), be superseded, and only then fail — a worklet that will not load
    // — leaving its tracks running while `this.stream` points at the winner.
    const first = fakeStream('first')
    const second = fakeStream('second')
    const getUserMedia = vi
      .fn<(c: unknown) => Promise<unknown>>()
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => second)

    // One controllable module load per start, so #1 can be failed after #2 has
    // taken over.
    const rejecters: Array<(reason: Error) => void> = []
    installBrowserGlobals(getUserMedia)
    class FailableContext extends FakeAudioContext {
      override audioWorklet = {
        addModule: () =>
          new Promise<void>((_resolve, reject) => {
            rejecters.push(reject)
          }),
      }
    }
    vi.stubGlobal('window', {
      AudioContext: FailableContext,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })

    const capture = new AudioCapture()
    void capture.start(options())
    await settle()
    expect(rejecters).toHaveLength(1) // #1 is parked past its stream assignment

    void capture.start(options())
    await settle()
    expect(rejecters).toHaveLength(2) // #2 has taken over

    rejecters[0]!(new Error('worklet failed to load'))
    await settle()

    expect(first.tracks[0]!.stop).toHaveBeenCalled()
    expect(second.tracks[0]!.stop).not.toHaveBeenCalled()

    await capture.stop()
    expect(second.tracks[0]!.stop).toHaveBeenCalled()
  })

  it('leaves the winning stream stoppable when the loser settles last', async () => {
    // The operator double-taps Begin (the case `generation` exists for).
    // `getUserMedia` settles in no guaranteed order, so start#1 comes back
    // AFTER start#2 has taken over. Writing the shared field before the
    // generation check let start#1 overwrite it, stop the winner's tracks and
    // null the field — the microphone stayed live with nothing holding it and
    // the browser's recording indicator stayed lit for the life of the page.
    const first = fakeStream('first')
    const second = fakeStream('second')
    let releaseFirst!: () => void

    const getUserMedia = vi
      .fn<(c: unknown) => Promise<unknown>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(first)
          }),
      )
      .mockImplementationOnce(async () => second)
    installBrowserGlobals(getUserMedia)

    const capture = new AudioCapture()
    void capture.start(options())
    void capture.start(options())
    await settle()

    releaseFirst()
    await settle()

    expect(first.tracks[0]!.stop).toHaveBeenCalled()
    expect(second.tracks[0]!.stop).not.toHaveBeenCalled()

    // The consequence that matters: the live capture is still reachable, so
    // stopping the session actually releases the microphone.
    await capture.stop()
    expect(second.tracks[0]!.stop).toHaveBeenCalled()
  })
})

/**
 * What the capture is allowed to remember.
 *
 * `deviceId` exists so a venue keeps the mic the operator picked. It was
 * being written on *every* successful start, from `track.getSettings()` —
 * including the start that asked for nothing and got the browser default.
 * That turned one machine's first-run default into a permanent pin: the id
 * still resolves, so the OverconstrainedError fallback never fires, and the
 * capture keeps opening a microphone nobody is speaking into while the host's
 * picker still reads "default microphone". The failure is silent by
 * construction — a live socket carrying digital silence.
 */
describe('the remembered microphone records a choice, never a coincidence', () => {
  function installWithStorage(
    getUserMedia: (c: unknown) => Promise<unknown>,
    store: Map<string, string>,
  ): void {
    vi.stubGlobal('window', {
      AudioContext: FakeAudioContext,
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:worklet' })
  }

  const constrainedId = (constraints: unknown): string | undefined =>
    (constraints as { audio?: { deviceId?: { exact?: string } } }).audio?.deviceId?.exact

  it('remembers nothing when the host asked for no particular device', async () => {
    const store = new Map<string, string>()
    installWithStorage(async () => fakeStream('built-in'), store)

    const capture = new AudioCapture()
    void capture.start(options())
    await settle()

    // The regression: `dev-built-in` used to land here, and every later start
    // then requested it with `{ exact }` instead of following the default.
    expect(store.size).toBe(0)
  })

  it('remembers a device the host explicitly selected', async () => {
    const store = new Map<string, string>()
    installWithStorage(async () => fakeStream('lectern'), store)

    const capture = new AudioCapture()
    void capture.start({ ...options(), deviceId: 'dev-lectern' })
    await settle()

    expect([...store.values()]).toEqual(['dev-lectern'])
  })

  it('keeps remembering a saved device that is still there', async () => {
    const store = new Map([[DEFAULT_DEVICE_STORAGE_KEY, 'dev-lectern']])
    const getUserMedia = vi.fn(async (c: unknown) => {
      expect(constrainedId(c)).toBe('dev-lectern')
      return fakeStream('lectern')
    })
    installWithStorage(getUserMedia, store)

    const capture = new AudioCapture()
    void capture.start(options())
    await settle()

    expect(store.get(DEFAULT_DEVICE_STORAGE_KEY)).toBe('dev-lectern')
  })

  it('does not re-pin the fallback when the saved device has gone', async () => {
    // The unplugged-interface path. Clearing the dead id and then immediately
    // saving whatever the unconstrained retry resolved to would swap one
    // silent pin for another — and this time for a device the operator has
    // never once chosen.
    const store = new Map([[DEFAULT_DEVICE_STORAGE_KEY, 'dev-unplugged']])
    const getUserMedia = vi.fn(async (c: unknown) => {
      if (constrainedId(c) === 'dev-unplugged') {
        throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' })
      }
      return fakeStream('built-in')
    })
    installWithStorage(getUserMedia, store)

    const capture = new AudioCapture()
    void capture.start(options())
    await settle()

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(0)
  })
})
