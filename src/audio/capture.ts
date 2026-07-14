import { loadCaptureWorklet } from './worklets'
import { Resampler, float32ToPcm16Bytes, bytesToBase64 } from './pcm'

const TARGET_RATE = 16000
const CHUNK_SAMPLES = 1600 // 100ms at 16kHz

// Muted (ducked) periods still send zeros to keep the realtime stream timed.
// No client-side noise gate: the model copes with a noise floor fine, and a
// fixed threshold silently swallows quiet microphones entirely.
const ZERO_CHUNK_B64 = bytesToBase64(new Uint8Array(CHUNK_SAMPLES * 2))

export interface MicCallbacks {
  /** base64-encoded 16-bit 16kHz mono PCM, ~100ms per chunk */
  onChunk(base64: string): void
  /** RMS input level 0..1, ~10x/sec */
  onLevel(level: number): void
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private resampler: Resampler | null = null
  private pending: Float32Array = new Float32Array(0)
  /** addModule() throws if 'capture' is re-registered on a reused context. */
  private workletLoaded = false
  /** When true, capture continues (level meter live) but silence is sent. */
  muted = false
  deviceLabel = ''
  contextRate = 0
  chunksSent = 0

  constructor(private cb: MicCallbacks) {}

  /**
   * Creates and resumes the AudioContext. MUST be called synchronously from the
   * user gesture that starts capture — iOS Safari creates contexts suspended and
   * only honours resume() while a gesture is active. start() is reached only
   * after awaiting a token fetch, a websocket connect and the mic permission
   * prompt, so a context created there would stay suspended forever: the worklet
   * never runs, no audio is ever sent, and the UI still reads "translating".
   * Safe to call more than once; start() calls it as a no-op fallback.
   */
  unlock(): void {
    if (!this.ctx) {
      // Ask for a 16kHz graph so the browser does properly anti-aliased
      // resampling. iOS typically refuses and pins the hardware rate (48k),
      // which is fine: the linear Resampler below covers it (verified to
      // transcribe identically to a native 16k graph).
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE })
      this.workletLoaded = false
    }
    void this.ctx.resume()
  }

  async start(deviceId?: string): Promise<void> {
    this.unlock()
    const ctx = this.ctx!
    this.stream = await this.openStream(deviceId)
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? '(unknown mic)'

    // Re-assert after the permission prompt: iOS suspends the context while the
    // prompt is up, and a suspended context silently captures nothing.
    await ctx.resume().catch(() => {})
    if (ctx.state !== 'running') {
      throw new Error(`audio context ${ctx.state} — tap the mic button again`)
    }
    this.contextRate = ctx.sampleRate
    this.chunksSent = 0
    if (!this.workletLoaded) {
      await loadCaptureWorklet(ctx)
      this.workletLoaded = true
    }
    this.resampler = ctx.sampleRate === TARGET_RATE ? null : new Resampler(ctx.sampleRate, TARGET_RATE)

    const source = ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(ctx, 'capture')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.handleFrame(e.data)

    // Keep the node pulled by the graph without echoing the mic to speakers.
    const sink = ctx.createGain()
    sink.gain.value = 0
    source.connect(this.node)
    this.node.connect(sink)
    sink.connect(ctx.destination)
  }

  /**
   * A stored deviceId goes stale whenever the device list changes — routine on
   * mobile, where a Bluetooth or wired headset connects and disconnects
   * constantly. `deviceId: {exact}` then throws OverconstrainedError and the
   * whole start fails, so fall back to the default mic instead of dying.
   */
  private async openStream(deviceId?: string): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
      // No playback in the app (text-only output), so AEC has nothing to
      // cancel — it only gates/attenuates the mic when other system audio
      // plays.
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    }
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...audio, deviceId: { exact: deviceId } },
        })
      } catch (err) {
        if ((err as Error)?.name !== 'OverconstrainedError') throw err
        console.warn('[lt] saved mic is gone; falling back to the default mic')
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio })
  }

  private handleFrame(frame: Float32Array): void {
    // stop() nulls the node; the context outlives it, so it cannot signal this.
    if (!this.node) return // stopped; ignore any straggler frames
    const resampled = this.resampler ? this.resampler.process(frame) : frame
    if (!resampled.length) return

    const merged = new Float32Array(this.pending.length + resampled.length)
    merged.set(this.pending)
    merged.set(resampled, this.pending.length)
    this.pending = merged

    while (this.pending.length >= CHUNK_SAMPLES) {
      const chunk = this.pending.slice(0, CHUNK_SAMPLES)
      this.pending = this.pending.slice(CHUNK_SAMPLES)

      let sum = 0
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
      this.cb.onLevel(Math.min(1, Math.sqrt(sum / chunk.length) * 4))

      // Always emit a chunk so the realtime stream stays continuous; ducked
      // audio goes out as digital silence.
      this.cb.onChunk(this.muted ? ZERO_CHUNK_B64 : bytesToBase64(float32ToPcm16Bytes(chunk)))
      this.chunksSent++
    }
  }

  /**
   * Releases the mic and the graph but keeps the AudioContext, suspended, so a
   * restart (mic change, direction swap, mode switch) can reuse the context the
   * user's tap unlocked. Those restarts happen after an await, where iOS Safari
   * would refuse to start a fresh one. Stopping the tracks is what drops the
   * mic indicator; an idle context holds no hardware. The context then lives for
   * the page's lifetime, which is the usual Web Audio pattern.
   */
  async stop(): Promise<void> {
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    await this.ctx?.suspend().catch(() => {})
    this.pending = new Float32Array(0)
    this.resampler = null
  }
}
