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
  /** When true, capture continues (level meter live) but silence is sent. */
  muted = false
  deviceLabel = ''
  contextRate = 0
  chunksSent = 0

  constructor(private cb: MicCallbacks) {}

  async start(deviceId?: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // No playback in the app (text-only output), so AEC has nothing to
        // cancel — it only gates/attenuates the mic when other system audio
        // plays.
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    })
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? '(unknown mic)'
    // Run the graph at 16kHz so the browser does properly anti-aliased
    // resampling; the linear-interpolation Resampler (no low-pass) is only a
    // fallback if the browser refuses the rate.
    this.ctx = new AudioContext({ sampleRate: TARGET_RATE })
    await this.ctx.resume()
    this.contextRate = this.ctx.sampleRate
    await loadCaptureWorklet(this.ctx)
    this.resampler =
      this.ctx.sampleRate === TARGET_RATE ? null : new Resampler(this.ctx.sampleRate, TARGET_RATE)

    const source = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'capture')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.handleFrame(e.data)

    // Keep the node pulled by the graph without echoing the mic to speakers.
    const sink = this.ctx.createGain()
    sink.gain.value = 0
    source.connect(this.node)
    this.node.connect(sink)
    sink.connect(this.ctx.destination)
  }

  private handleFrame(frame: Float32Array): void {
    if (!this.ctx) return // stopped; ignore any straggler frames
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

  async stop(): Promise<void> {
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    await this.ctx?.close().catch(() => {})
    this.ctx = null
    this.pending = new Float32Array(0)
    this.resampler = null
  }
}
