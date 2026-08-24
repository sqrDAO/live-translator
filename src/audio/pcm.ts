/**
 * PCM conversion and streaming resampling.
 *
 * Descends from `sqrdao-intern/live-translator`
 *   commit 7273d39cf6c228f2445bbb0fbe3e17401f74412f
 *   files: src/audio/pcm.ts, src/audio/capture.ts
 * and was hardened over two live conference days after that (see README).
 *
 * Pure functions, deliberately free of Web Audio types, so the resampler and
 * the PCM16 conversion can be unit-tested in Node.
 */

/** Gemini Live expects 16 kHz mono PCM16. */
export const TARGET_SAMPLE_RATE = 16_000

/** 100 ms chunks, as in the reference implementation. */
export const CHUNK_MS = 100
export const SAMPLES_PER_CHUNK = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000 // 1600

/**
 * Float32 [-1, 1] to little-endian PCM16.
 *
 * Clamping before scaling matters: a browser's AudioWorklet can emit samples
 * marginally outside [-1, 1] after gain, and wrapping those would produce an
 * audible click that the voice detector then reads as speech.
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64')
}

/**
 * Streaming linear resampler.
 *
 * The browser decides the AudioContext sample rate (44.1 kHz, 48 kHz, and on
 * some iOS devices 24 kHz). It is never 16 kHz, so every capture path resamples.
 *
 * "Streaming" is the important part: `process()` is called once per audio
 * callback and must not restart interpolation at each block boundary, or every
 * ~3 ms of audio acquires a discontinuity. The fractional read position and the
 * final sample of the previous block are therefore carried across calls.
 */
export class StreamingResampler {
  private readonly ratio: number
  private position = 0
  private lastSample = 0
  private primed = false

  constructor(
    readonly inputSampleRate: number,
    readonly outputSampleRate: number = TARGET_SAMPLE_RATE,
  ) {
    if (inputSampleRate <= 0) throw new Error('inputSampleRate must be positive')
    this.ratio = inputSampleRate / outputSampleRate
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0)

    // Pass-through when the context already runs at the target rate.
    if (this.ratio === 1) return Float32Array.from(input)

    const output: number[] = []
    let position = this.position

    while (position < input.length) {
      const index = Math.floor(position)
      const fraction = position - index

      // The sample before the read head may live in the previous block.
      const previous =
        index === 0 ? (this.primed ? this.lastSample : (input[0] ?? 0)) : (input[index - 1] ?? 0)
      const current = input[index] ?? previous

      output.push(previous + (current - previous) * fraction)
      position += this.ratio
    }

    // Carry the fractional remainder into the next block.
    this.position = position - input.length
    this.lastSample = input[input.length - 1] ?? this.lastSample
    this.primed = true

    return Float32Array.from(output)
  }

  reset(): void {
    this.position = 0
    this.lastSample = 0
    this.primed = false
  }
}

/**
 * Accumulates resampled audio and emits fixed-size chunks.
 *
 * The Live API is sensitive to chunk cadence; emitting whatever length the
 * audio callback happened to produce degrades turn detection noticeably.
 */
export class ChunkAccumulator {
  private buffer: Float32Array
  private filled = 0

  constructor(private readonly samplesPerChunk: number = SAMPLES_PER_CHUNK) {
    this.buffer = new Float32Array(samplesPerChunk)
  }

  push(input: Float32Array): Float32Array[] {
    const chunks: Float32Array[] = []
    let offset = 0

    while (offset < input.length) {
      const space = this.samplesPerChunk - this.filled
      const take = Math.min(space, input.length - offset)
      this.buffer.set(input.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take

      if (this.filled === this.samplesPerChunk) {
        chunks.push(Float32Array.from(this.buffer))
        this.filled = 0
      }
    }

    return chunks
  }

  /** Emits a zero-padded final chunk when the stream stops mid-buffer. */
  flush(): Float32Array | null {
    if (this.filled === 0) return null
    const chunk = new Float32Array(this.samplesPerChunk)
    chunk.set(this.buffer.subarray(0, this.filled))
    this.filled = 0
    return chunk
  }

  reset(): void {
    this.filled = 0
  }
}

/**
 * The envelope the detector runs, exported so the tests can hold the release
 * hangover against the `SPEECH_RUN_GAP_MS` derivation instead of restating
 * the numbers.
 *
 * The bound `releaseFrames × CHUNK_MS < TURN_SILENCE_MS` no longer buys turn
 * detection: gated chunks stream as synthesized zeros (`capture.ts`), so
 * Gemini's own VAD hears the silence and ends turns on its own clock. What
 * the bound still guards is the derivation in `engine.ts` —
 * `SPEECH_RUN_GAP_MS = TURN_SILENCE_MS − releaseFrames × CHUNK_MS` must stay
 * positive, and the envelope test keeps it so. Do not raise
 * `releaseFrames` past 7 while that derivation stands: 7 leaves 100 ms, one
 * chunk cadence, and re-deriving the subtraction is the price of going
 * further.
 *
 * `maxHoldFrames` caps how long a latch may hold the gate open without a
 * release, so a transient train (applause tail, chair scrapes) cannot stream
 * room tone indefinitely. `subWindows` sets the onset resolution: loudness is
 * the maximum RMS over `subWindows` equal slices of the chunk, so a 10 ms
 * word onset at a chunk boundary is not diluted across 100 ms of silence.
 * `minRms` is the absolute privacy backstop under the adaptive floor.
 */
export const VAD_DEFAULTS = {
  marginRatio: 3,
  attackFrames: 2,
  releaseFrames: 6,
  maxHoldFrames: 100,
  subWindows: 5,
  minRms: 0.0005,
} as const

/**
 * Noise-floor EMA rates. The rate follows the *direction* of the update, not
 * the loud/quiet branch: the floor falls fast when the room quietens (or the
 * AV desk drops gain) and rises slowly everywhere else. The previous revision
 * tied a fast 0.05 rate to the quiet branch, so audible frames just under the
 * threshold (rms ≈ 3·floor) dragged the floor up 10% per frame — doubling it
 * in 730 ms and muting the room whenever background sat within ~9 dB of
 * speech. The behaviour was scale-invariant, so better hardware never fixed
 * it. The trade for the slow rise is a slower lock-on in a room whose ambient
 * starts far above the floor (~tens of seconds of streamed room tone at
 * capture start); the diagnostics panel's noiseFloor/threshold rows make that
 * visible to the operator.
 */
const FLOOR_FALL = 0.05
const FLOOR_RISE = 0.001
const INITIAL_NOISE_FLOOR = 0.0005

/**
 * Adaptive noise-floor voice detection.
 *
 * Venue rooms are noisy, and a fixed threshold either
 * misses quiet speech or feeds room tone to the model, which then hallucinates
 * text in a silent room. The floor tracks the quietest sub-window of each
 * chunk (a minimum-statistics estimate: speech is modulated, noise is not)
 * with a slow rise and a fast fall, and a chunk is loud when its *loudest*
 * sub-window exceeds the floor by `marginRatio`.
 *
 * Every loud frame streams; the latch governs the *quiet* frames around it.
 * `attackFrames` loud frames inside one release window latch the hangover on
 * — consecutive or not, because connected speech at a 4–7 Hz syllable rate
 * alternates chunk loudness every frame, and requiring consecutive loud
 * chunks left the latch permanently unarmed and zeroed every other chunk
 * mid-word (the defect todo.vad-drops-words exists for). Once latched, the
 * gate streams until `releaseFrames` *consecutive* quiet frames have passed:
 * any loud frame re-arms the countdown. The anti-applause guard is no longer
 * a refusal to re-arm but a cap — `maxHoldFrames` frames after the latch
 * armed, the gate closes regardless, so a transient train spaced under the
 * hangover cannot hold it open indefinitely. An isolated loud frame — a
 * door, a cough — still passes as that one frame and buys no hangover.
 *
 * The envelope reads `VAD_DEFAULTS` directly: retuning it means editing the
 * constant the envelope test holds against the `SPEECH_RUN_GAP_MS`
 * derivation, never a per-instance override that would bypass that test.
 */
export class VoiceActivityDetector {
  private noiseFloor = INITIAL_NOISE_FLOOR
  private speechFrames = 0
  private silenceFrames = 0
  private holdFrames = 0
  private speaking = false
  private lastRms = 0
  private lastGatedAudible = false

  static rms(frame: Float32Array, start = 0, end = frame.length): number {
    if (end <= start) return 0
    let sum = 0
    for (let i = start; i < end; i += 1) {
      const sample = frame[i] ?? 0
      sum += sample * sample
    }
    return Math.sqrt(sum / (end - start))
  }

  /**
   * RMS per sub-window: the peak detects a short onset the full-chunk mean
   * would dilute (a 10 ms onset at a chunk boundary reads 10 dB low over
   * 1600 samples, 3 dB over 320), the trough estimates the noise the onset
   * rides on.
   */
  static subWindowRms(
    frame: Float32Array,
    subWindows: number = VAD_DEFAULTS.subWindows,
  ): { peak: number; trough: number } {
    if (frame.length === 0) return { peak: 0, trough: 0 }
    const size = Math.max(1, Math.ceil(frame.length / subWindows))
    let peak = 0
    let trough = Number.POSITIVE_INFINITY
    for (let start = 0; start < frame.length; start += size) {
      const rms = VoiceActivityDetector.rms(frame, start, Math.min(frame.length, start + size))
      if (rms > peak) peak = rms
      if (rms < trough) trough = rms
    }
    return { peak, trough }
  }

  /** @returns true when this frame should stream to the model. */
  process(frame: Float32Array): boolean {
    const { peak, trough } = VoiceActivityDetector.subWindowRms(frame)
    this.lastRms = peak
    const threshold = this.currentThreshold
    const isLoud = peak > threshold
    const wasSpeaking = this.speaking

    // The rate follows the update's direction, never the loud/quiet branch:
    // fast fall when the room quietens, slow rise everywhere else. Feeding
    // the quietest sub-window keeps speech itself out of the estimate — its
    // inter-syllable dips sit near the true ambient — so a long utterance
    // cannot ratchet the threshold up to the speaker's own level (the
    // fast-release runaway this replaces).
    const rate = trough < this.noiseFloor ? FLOOR_FALL : FLOOR_RISE
    this.noiseFloor = this.noiseFloor * (1 - rate) + trough * rate

    if (isLoud) {
      this.speechFrames += 1
      // Any loud frame re-arms the release countdown; `silenceFrames` counts
      // *consecutive* quiet frames only. Holding the gate open through
      // recurring transients is now bounded by `maxHoldFrames` below, not by
      // refusing to re-arm.
      this.silenceFrames = 0
      if (!this.speaking && this.speechFrames >= VAD_DEFAULTS.attackFrames) {
        this.speaking = true
        this.holdFrames = 0
      }
    } else {
      this.silenceFrames += 1
      // Hold the gate through ordinary pauses; close it after releaseFrames
      // consecutive quiet frames. `speechFrames` resets only here — a single
      // quiet frame between two loud ones must not restart the attack, or
      // alternating-loudness speech never latches.
      if (this.silenceFrames >= VAD_DEFAULTS.releaseFrames) {
        this.speaking = false
        this.speechFrames = 0
      }
    }

    // The phantom-segment cap: a latch may hold the gate for at most
    // `maxHoldFrames` frames before it must re-earn the attack. Real speech
    // re-latches within a chunk or two (its loud frames stream regardless);
    // an applause tail of isolated spikes cannot, so its room tone stops
    // streaming here.
    if (this.speaking) {
      this.holdFrames += 1
      if (this.holdFrames >= VAD_DEFAULTS.maxHoldFrames) {
        this.speaking = false
        this.speechFrames = 0
        this.silenceFrames = 0
      }
    }

    // A loud frame always streams: an utterance whose voiced energy spans a
    // single chunk ("Đúng.") must not vanish because it never met the attack
    // threshold — the latch decides the fate of the quiet frames, not the
    // loud ones. `wasSpeaking` streams the hangover inclusive of its closing
    // frame, so exactly `releaseFrames` quiet frames follow the last loud one.
    const streams = isLoud || wasSpeaking

    // Diagnostics: a gated chunk within ~3.5 dB below the speech threshold is
    // audible energy the gate zeroed. Steady room tone sits at ~1× the floor
    // (well under 2×), so a quiet room reads 0 and a non-zero count means the
    // gate is eating real audio — the distinction the operator panel needs.
    this.lastGatedAudible =
      !streams && peak * VAD_DEFAULTS.marginRatio > threshold * 2

    return streams
  }

  get currentNoiseFloor(): number {
    return this.noiseFloor
  }

  /** The loudness a chunk's peak sub-window must exceed to read as speech. */
  get currentThreshold(): number {
    return Math.max(VAD_DEFAULTS.minRms, this.noiseFloor * VAD_DEFAULTS.marginRatio)
  }

  /** Peak sub-window RMS of the last processed chunk. */
  get lastChunkRms(): number {
    return this.lastRms
  }

  /** True when the last chunk was gated despite audible energy. */
  get lastFrameGatedWhileAudible(): boolean {
    return this.lastGatedAudible
  }

  reset(): void {
    this.noiseFloor = INITIAL_NOISE_FLOOR
    this.speechFrames = 0
    this.silenceFrames = 0
    this.holdFrames = 0
    this.speaking = false
    this.lastRms = 0
    this.lastGatedAudible = false
  }
}
