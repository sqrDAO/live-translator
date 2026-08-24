/**
 * Browser audio capture for the live translation engine. Browser only.
 *
 * Descends from `sqrdao-intern/live-translator`
 *   commit 7273d39cf6c228f2445bbb0fbe3e17401f74412f
 *   file: src/audio/capture.ts
 *
 * Behaviors preserved from the reference, each of which exists because a real
 * device broke without it:
 *   * synchronous AudioContext unlock inside the user's tap (iOS)
 *   * resume after the microphone permission prompt returns (iOS)
 *   * AudioWorklet capture rather than the deprecated ScriptProcessor
 *   * browser-rate to 16 kHz streaming resample, PCM16, 100 ms chunks
 *   * saved-microphone fallback after OverconstrainedError
 *   * echo cancellation disabled: the output is text, and AEC removes the
 *     room PA's own voice, which is exactly what we are transcribing
 *   * generation counter canceling superseded async starts
 */

import {
  ChunkAccumulator,
  SAMPLES_PER_CHUNK,
  StreamingResampler,
  TARGET_SAMPLE_RATE,
  VoiceActivityDetector,
  floatToPcm16,
  pcm16ToBase64,
} from './pcm'
import { WORKLET_SOURCE, WORKLET_NAME } from './worklet'

/** One 100 ms chunk of pure digital silence — what a gated chunk becomes. */
const SILENCE_CHUNK_BASE64 = pcm16ToBase64(new Int16Array(SAMPLES_PER_CHUNK))

/**
 * Diagnostics emitted at most every `DIAGNOSTICS_INTERVAL_MS` — the worklet
 * posts ~375 messages/s at 48 kHz, and forwarding each one meant a re-render
 * per message on the operator console (todo.vad-drops-words).
 */
const DIAGNOSTICS_INTERVAL_MS = 500

export interface CaptureDiagnostics {
  microphoneLabel: string
  contextSampleRate: number
  chunksSent: number
  droppedSilentChunks: number
  /** The detector's adaptive ambient estimate (peak sub-window RMS scale). */
  noiseFloor: number
  /** What a chunk's peak sub-window RMS must exceed to read as speech. */
  threshold: number
  /** Peak sub-window RMS of the most recent chunk. */
  lastChunkRms: number
  /** Highest `lastChunkRms` seen since this capture was constructed. */
  peakRms: number
  /**
   * Chunks gated despite audible energy (within ~3.5 dB below the speech
   * threshold). 0 over a quiet-room minute; non-zero when the gate is eating
   * real audio — how the operator tells the two apart.
   */
  gatedWhileAudible: number
  lastChunkAt?: string
}

export interface CaptureOptions {
  /** Preferred device, remembered across restarts. */
  deviceId?: string
  /**
   * `localStorage` key the remembered microphone is saved under. Namespaced
   * by default so two hosts on one origin cannot hand each other their
   * device; a host that runs several captures on one origin gives each its
   * own.
   */
  storageKey?: string
  onChunk: (base64Pcm16: string, hasVoice: boolean) => void
  onError: (error: Error) => void
  onDiagnostics?: (diagnostics: CaptureDiagnostics) => void
}

/** Package-namespaced, never a bare app key: see `CaptureOptions.storageKey`. */
export const DEFAULT_DEVICE_STORAGE_KEY = '@sqrdao/live-translate:deviceId'

export class AudioCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private worklet: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private resampler: StreamingResampler | null = null
  private accumulator = new ChunkAccumulator()
  private detector = new VoiceActivityDetector()

  /**
   * Cancels superseded async starts. Every await point re-checks this; a start
   * that was overtaken by a newer start (operator double-tapping "Begin", or a
   * device change mid-permission-prompt) unwinds instead of attaching a second
   * capture graph to the same context.
   */
  private generation = 0

  private diagnostics: CaptureDiagnostics = {
    microphoneLabel: '',
    contextSampleRate: 0,
    chunksSent: 0,
    droppedSilentChunks: 0,
    noiseFloor: 0,
    threshold: 0,
    lastChunkRms: 0,
    peakRms: 0,
    gatedWhileAudible: 0,
  }

  /** Throttles `onDiagnostics` to ~2 Hz; see `DIAGNOSTICS_INTERVAL_MS`. */
  private lastDiagnosticsAt = 0
  private storageKey = DEFAULT_DEVICE_STORAGE_KEY

  /**
   * MUST be called synchronously inside the user's tap handler.
   *
   * iOS Safari only unlocks an AudioContext during a user gesture. Awaiting
   * anything - including `getUserMedia` - before construction loses the gesture
   * and yields a permanently suspended context that produces silence with no
   * error.
   */
  unlockSync(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.context = new Ctor()
    }
    void this.context.resume()
    this.diagnostics.contextSampleRate = this.context.sampleRate
    return this.context
  }

  async start(options: CaptureOptions): Promise<void> {
    const generation = ++this.generation
    const context = this.unlockSync()
    this.storageKey = options.storageKey ?? DEFAULT_DEVICE_STORAGE_KEY

    try {
      const deviceId = options.deviceId ?? readSavedDevice(this.storageKey)
      this.stream = await requestMicrophone(deviceId, this.storageKey)
      if (generation !== this.generation) return void this.disposeStream()

      // iOS suspends the context while the permission sheet is up.
      if (context.state === 'suspended') await context.resume()
      if (generation !== this.generation) return void this.disposeStream()

      const track = this.stream.getAudioTracks()[0]
      if (track) {
        this.diagnostics.microphoneLabel = track.label || 'default'
        const settings = track.getSettings()
        if (settings.deviceId) saveDevice(this.storageKey, settings.deviceId)
      }

      await context.audioWorklet.addModule(workletUrl())
      if (generation !== this.generation) return void this.disposeStream()

      this.resampler = new StreamingResampler(context.sampleRate, TARGET_SAMPLE_RATE)
      this.accumulator.reset()
      this.detector.reset()

      this.source = context.createMediaStreamSource(this.stream)
      this.worklet = new AudioWorkletNode(context, WORKLET_NAME)
      this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (generation !== this.generation) return
        this.handleFrames(event.data, options)
      }

      this.source.connect(this.worklet)
      // The worklet emits nothing downstream. Connecting to a zero-gain node
      // keeps the graph alive in browsers that garbage-collect an unconnected
      // node, without routing the room PA back into the room.
      const sink = context.createGain()
      sink.gain.value = 0
      this.worklet.connect(sink).connect(context.destination)

      this.diagnostics.contextSampleRate = context.sampleRate
      this.emitDiagnostics(options, true)
    } catch (error) {
      if (generation !== this.generation) return
      options.onError(error instanceof Error ? error : new Error(String(error)))
      await this.stop()
    }
  }

  private handleFrames(frame: Float32Array, options: CaptureOptions): void {
    if (!this.resampler) return

    const resampled = this.resampler.process(frame)
    for (const chunk of this.accumulator.push(resampled)) {
      const hasVoice = this.detector.process(chunk)

      // Gate telemetry (todo.vad-drops-words): the rehearsal reads
      // noiseFloor/threshold off the operator panel to confirm the floor is
      // stable rather than creeping, and gatedWhileAudible is the over-gating
      // tell a listener cannot get from droppedSilentChunks alone.
      this.diagnostics.noiseFloor = this.detector.currentNoiseFloor
      this.diagnostics.threshold = this.detector.currentThreshold
      this.diagnostics.lastChunkRms = this.detector.lastChunkRms
      if (this.detector.lastChunkRms > this.diagnostics.peakRms) {
        this.diagnostics.peakRms = this.detector.lastChunkRms
      }
      if (this.detector.lastFrameGatedWhileAudible) {
        this.diagnostics.gatedWhileAudible += 1
      }

      // Silence handling. The room's own quiet audio is never
      // sent — a silent room streamed raw produces phantom segments, and the
      // gated content stays private. But the stream must not simply stop:
      // the Live API flushes transcript text only while audio arrives and
      // detects its end-of-turn from ~800 ms of heard silence, so a gated gap
      // left the tail of every sentence stuck in the model until the speaker
      // resumed (observed 2026-08-10, fix-caption-idle-turn-boundary). Gated
      // chunks are therefore replaced with synthesized zeros: same cadence,
      // no room audio.
      if (!hasVoice) {
        this.diagnostics.droppedSilentChunks += 1
        options.onChunk(SILENCE_CHUNK_BASE64, false)
        continue
      }

      options.onChunk(pcm16ToBase64(floatToPcm16(chunk)), hasVoice)
      this.diagnostics.chunksSent += 1
      this.diagnostics.lastChunkAt = new Date().toISOString()
    }
    this.emitDiagnostics(options)
  }

  private emitDiagnostics(options: CaptureOptions, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastDiagnosticsAt < DIAGNOSTICS_INTERVAL_MS) return
    this.lastDiagnosticsAt = now
    options.onDiagnostics?.({ ...this.diagnostics })
  }

  async stop(): Promise<void> {
    this.generation += 1

    const tail = this.accumulator.flush()
    void tail // Discarded: a partial chunk after stop adds nothing but latency.

    this.worklet?.port.close()
    this.worklet?.disconnect()
    this.source?.disconnect()
    this.worklet = null
    this.source = null
    this.resampler = null

    this.disposeStream()

    if (this.context && this.context.state !== 'closed') {
      await this.context.close()
    }
    this.context = null
  }

  private disposeStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  get currentDiagnostics(): CaptureDiagnostics {
    return { ...this.diagnostics }
  }
}

/** Releases a capture that a superseded UI start no longer owns. */
export async function stopSupersededCapture(
  capture: Pick<AudioCapture, 'stop'>,
  currentCapture: Pick<AudioCapture, 'stop'> | null,
): Promise<void> {
  if (capture === currentCapture) return
  await capture.stop()
}

/**
 * Requests the microphone, falling back when the saved device has gone.
 *
 * A USB interface unplugged between sessions makes an exact `deviceId`
 * constraint throw `OverconstrainedError`. The reference implementation retries
 * without the constraint rather than failing the room.
 */
async function requestMicrophone(deviceId: string | undefined, storageKey: string): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    // Text output, not playback: AEC would cancel the room PA we are here to
    // transcribe, and AGC pumps the noise floor between speakers.
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  }

  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...audio, deviceId: { exact: deviceId } },
      })
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error
      clearSavedDevice(storageKey)
    }
  }

  return navigator.mediaDevices.getUserMedia({ audio })
}

let cachedWorkletUrl: string | null = null

/** The worklet is inlined and served as a blob so it needs no static asset. */
function workletUrl(): string {
  if (cachedWorkletUrl) return cachedWorkletUrl
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  cachedWorkletUrl = URL.createObjectURL(blob)
  return cachedWorkletUrl
}

function readSavedDevice(storageKey: string): string | undefined {
  try {
    return window.localStorage.getItem(storageKey) ?? undefined
  } catch {
    return undefined
  }
}

function saveDevice(storageKey: string, deviceId: string): void {
  try {
    window.localStorage.setItem(storageKey, deviceId)
  } catch {
    // Private browsing; the device simply is not remembered.
  }
}

function clearSavedDevice(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey)
  } catch {
    // Ignored.
  }
}
