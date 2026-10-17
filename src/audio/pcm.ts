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
 * Filter cutoff (the −6 dB point) as a fraction of the lower of the two
 * rates: 0.45 × 16 kHz = 7.2 kHz. Speech intelligibility lives below ~7 kHz;
 * the 0.8 kHz up to the 8 kHz Nyquist is the transition band.
 */
const RESAMPLER_CUTOFF_RATIO = 0.45

/**
 * Sinc zero crossings on each side of the kernel. This, not a tap count, is
 * what fixes the transition width relative to the cutoff, so every input rate
 * gets the same response: 24 crossings is 80 input samples per side at
 * 48 kHz (160 taps), 74 at 44.1 kHz, 40 at 24 kHz.
 *
 * Cost: 160 multiply-adds per 16 kHz output, ~2.6 M a second. Measured
 * 2026-10-17 in Node 24 on an Intel i5-8257U under heavy load (load average
 * ~90): ~21 ms per second of 48 kHz audio fed in 128-frame blocks, i.e.
 * ~0.06 ms per 2.7 ms callback, ~2% of one core. The previous linear
 * interpolator was cheaper, and wrong.
 */
const RESAMPLER_ZERO_CROSSINGS = 24

/**
 * Kaiser window shape: β = 8 puts the stopband ≥ 80 dB down. The measured
 * response is pinned in test/audio.test.ts.
 */
const RESAMPLER_KAISER_BETA = 8

/**
 * Most fractional phases a resampler precomputes. Real rate pairs need few
 * (48k→16k: 1, 24k→16k: 2, 44.1k→16k: 160); a pathological pair such as
 * 44 101 Hz would need 16 000, so beyond this the read position is rounded to
 * the nearest 1/512 of an input sample (≤ 1/1024 of a sample of timing
 * error, ~−60 dB relative to a 7 kHz signal, and only on such odd rates —
 * far below any venue room's noise).
 */
const RESAMPLER_MAX_PHASES = 512

/**
 * Streaming band-limited resampler: a Kaiser-windowed-sinc low-pass evaluated
 * at the fractional read position (polyphase decimation; Smith's
 * bandlimited-interpolation method).
 *
 * The browser decides the AudioContext sample rate. `capture.ts` asks for
 * 16 kHz so the browser does the (filtered) conversion itself, but that
 * request is not honoured everywhere: iOS is reported to pin 48 kHz, old
 * `webkitAudioContext` takes no options, and Firefox rejects a forced rate that
 * differs from the microphone's, so capture then runs at the hardware rate
 * (44.1 kHz, 48 kHz, 24 kHz on some iOS devices) and this class converts.
 *
 * Until 2026-10-17 this was a plain linear interpolator, on the assumption
 * that the path was a rarely-taken fallback. It was the live path: the
 * package spinout had dropped the `sampleRate` request, and Mac Chrome
 * diagnostics read `48kHz` on every microphone tried (built-in and a Razer
 * USB mic). Linear interpolation does no anti-alias filtering, so 8–24 kHz
 * energy folds straight into the speech band: an 11 kHz tone came out as a
 * 5 kHz tone at full strength.
 *
 * Whether that aliasing hurts recognition on real speech is not yet known.
 * The one clip available for an A/B on 2026-10-17 was football commentary
 * played through a speaker and re-recorded: band-limited (only ~−45 dB of
 * its energy above 8 kHz) and noisy, so it could not test aliasing either
 * way. The change rests on the offline tone measurements in
 * test/audio.test.ts: it is the correct way to decimate, and it keeps the
 * energy of wideband microphones, sibilants, hiss and fans above 8 kHz out
 * of the band the model listens to. Do not read it as the confirmed fix for
 * bad captions until a direct-mic recording has been compared.
 *
 * Each output at input position p is Σ x[k]·h(p − k), with h a windowed sinc
 * cut off at `RESAMPLER_CUTOFF_RATIO` of the lower rate. Evaluating h at the
 * fractional offset makes the low-pass and the fractional-delay interpolation
 * one pass, for any ratio (3 for 48 kHz, 2.75625 for 44.1 kHz, 1.5 for
 * 24 kHz). The coefficients for each distinct fractional offset are
 * precomputed, each normalised to unity DC gain, so the inner loop is a plain
 * dot product.
 *
 * "Streaming" is the important part: `process()` is called once per audio
 * callback and must not restart at each block boundary, or every ~3 ms of
 * audio acquires a discontinuity. The filter history (one kernel width of
 * input) and the read position are carried across calls. The position is an
 * exact integer plus a rational remainder, never an accumulated float, so any
 * split of the same input yields bit-identical output. The price is a fixed
 * latency of half a kernel (~1.7 ms at 48 kHz): an output is emitted once the
 * input to its right has arrived.
 */
export class StreamingResampler {
  private readonly passThrough: boolean
  /** Input samples advanced per output, as the exact fraction step / denominator. */
  private readonly step: number
  private readonly denominator: number
  private readonly halfTaps: number
  /** `phases + 1` rows of `2 · halfTaps` taps; row i is fractional offset i / phases. */
  private readonly phases: number
  private readonly coefficients: Float32Array

  /** Absolute input index of `history[0]`. */
  private historyStart = 0
  private history = new Float32Array(0)
  /** Read position: `index + remainder / denominator`, in absolute input samples. */
  private index = 0
  private remainder = 0

  constructor(
    readonly inputSampleRate: number,
    readonly outputSampleRate: number = TARGET_SAMPLE_RATE,
  ) {
    if (inputSampleRate <= 0) throw new Error('inputSampleRate must be positive')
    if (outputSampleRate <= 0) throw new Error('outputSampleRate must be positive')

    // Exact bookkeeping needs integer rates. Every real AudioContext rate is
    // one; rounding only guards a host passing 44100.0000001.
    const input = Math.round(inputSampleRate)
    const output = Math.round(outputSampleRate)
    const divisor = gcd(input, output)
    this.step = input / divisor
    this.denominator = output / divisor
    this.passThrough = input === output

    // Normalised cutoff: 1 is the input Nyquist.
    const cutoff = (2 * RESAMPLER_CUTOFF_RATIO * Math.min(input, output)) / input
    this.halfTaps = Math.ceil(RESAMPLER_ZERO_CROSSINGS / cutoff)
    this.phases = Math.min(this.denominator, RESAMPLER_MAX_PHASES)
    this.coefficients = this.passThrough
      ? new Float32Array(0)
      : buildPolyphase(cutoff, this.halfTaps, this.phases)
    this.reset()
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0)

    // Pass-through when the context already runs at the target rate.
    if (this.passThrough) return Float32Array.from(input)

    const history = new Float32Array(this.history.length + input.length)
    history.set(this.history)
    history.set(input, this.history.length)
    const end = this.historyStart + history.length

    const { halfTaps, coefficients, step, denominator, phases } = this
    const taps = 2 * halfTaps
    // Upper bound on outputs this call; trimmed to `count` on return.
    const output = new Float32Array(Math.ceil((input.length * denominator) / step) + 1)
    let count = 0

    // The output at index + fraction reads x[index − halfTaps + 1] through
    // x[index + halfTaps]; stop when that right edge has not arrived yet.
    while (this.index + halfTaps < end) {
      // Row `phases` is offset 1.0, i.e. the next sample at offset 0: rounding
      // up into it is exact, not an overrun.
      const row = Math.round((this.remainder * phases) / denominator) * taps
      const first = this.index - halfTaps + 1 - this.historyStart
      let sum = 0
      // Both reads are in bounds by construction (`first ≥ 0` because the
      // history keeps the left edge; the row has `taps` entries); the
      // assertions keep this hot loop free of `?? 0` branches.
      for (let j = 0; j < taps; j += 1) {
        sum += history[first + j]! * coefficients[row + j]!
      }
      output[count] = sum
      count += 1

      this.remainder += step
      const whole = Math.floor(this.remainder / denominator)
      this.index += whole
      this.remainder -= whole * denominator
    }

    // Keep only the history the next output's left edge can still reach.
    const keepFrom = this.index - halfTaps + 1
    this.history = history.slice(keepFrom - this.historyStart)
    this.historyStart = keepFrom

    return output.slice(0, count)
  }

  reset(): void {
    // Silence before the stream starts: the first outputs see zeros to their
    // left, a half-kernel fade-in rather than a spurious step.
    this.historyStart = 1 - this.halfTaps
    this.history = new Float32Array(Math.max(0, this.halfTaps - 1))
    this.index = 0
    this.remainder = 0
  }
}

/**
 * Row i, tap j holds h(t) for t = i / phases + halfTaps − 1 − j: the offset
 * from input sample `index − halfTaps + 1 + j` to the read position. h(t) =
 * sinc(cutoff · t) · kaiser(t / halfTaps), each row scaled to sum to 1 so
 * every phase passes DC at exactly unity gain.
 */
function buildPolyphase(cutoff: number, halfTaps: number, phases: number): Float32Array {
  const taps = 2 * halfTaps
  const table = new Float32Array((phases + 1) * taps)
  const norm = besselI0(RESAMPLER_KAISER_BETA)
  for (let i = 0; i <= phases; i += 1) {
    const fraction = i / phases
    let total = 0
    for (let j = 0; j < taps; j += 1) {
      const t = fraction + halfTaps - 1 - j
      const x = Math.PI * cutoff * t
      const sinc = x === 0 ? 1 : Math.sin(x) / x
      const edge = t / halfTaps
      const window =
        Math.abs(edge) >= 1
          ? 0
          : besselI0(RESAMPLER_KAISER_BETA * Math.sqrt(1 - edge * edge)) / norm
      const value = sinc * window
      table[i * taps + j] = value
      total += value
    }
    for (let j = 0; j < taps; j += 1) table[i * taps + j] = (table[i * taps + j] ?? 0) / total
  }
  return table
}

/** Zeroth-order modified Bessel function of the first kind, by its power series. */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const half = x / 2
  for (let k = 1; k < 64; k += 1) {
    term *= (half / k) * (half / k)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

function gcd(a: number, b: number): number {
  let x = a
  let y = b
  while (y !== 0) [x, y] = [y, x % y]
  return x
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
