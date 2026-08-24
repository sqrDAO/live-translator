import { afterEach, describe, expect, it, vi } from 'vitest'

import { AudioCapture, type CaptureOptions } from '../src/audio/capture'

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
  audioWorklet = { addModule: () => new Promise<void>(() => {}) }
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
