import { describe, expect, it } from 'vitest'

import {
  CHUNK_MS,
  ChunkAccumulator,
  SAMPLES_PER_CHUNK,
  StreamingResampler,
  TARGET_SAMPLE_RATE,
  VAD_DEFAULTS,
  VoiceActivityDetector,
  floatToPcm16,
  pcm16ToBase64,
} from '../src/audio/pcm'
import { TURN_SILENCE_MS } from '../src/gemini/config'

describe('PCM conversion and resampling', () => {
  it('converts float samples to PCM16 with clipping', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))
    expect(pcm[0]).toBe(0)
    expect(pcm[1]).toBe(32767)
    expect(pcm[2]).toBe(-32768)
    // Values beyond the range clamp rather than wrap, which would sound like a
    // loud click and confuse the model.
    expect(pcm[3]).toBe(32767)
    expect(pcm[4]).toBe(-32768)
    expect(pcm[5]!).toBeGreaterThan(16000)
  })

  it('base64-encodes PCM without loss of length', () => {
    const pcm = floatToPcm16(new Float32Array(160))
    const encoded = pcm16ToBase64(pcm)
    expect(typeof encoded).toBe('string')
    expect(Buffer.from(encoded, 'base64').byteLength).toBe(pcm.byteLength)
  })

  it('resamples 48 kHz to 16 kHz at roughly a third of the samples', () => {
    const resampler = new StreamingResampler(48_000, TARGET_SAMPLE_RATE)
    const input = new Float32Array(4800)
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 20)
    const output = resampler.process(input)
    expect(output.length).toBeGreaterThan(1500)
    expect(output.length).toBeLessThan(1700)
  })

  it('carries fractional position across blocks rather than restarting each one', () => {
    // The streaming property: two half-blocks must produce the same count as
    // one whole block, or every callback boundary acquires a discontinuity.
    const whole = new StreamingResampler(48_000).process(sine(4800))
    const streamed = (() => {
      const r = new StreamingResampler(48_000)
      return r.process(sine(2400, 0)).length + r.process(sine(2400, 2400)).length
    })()
    expect(Math.abs(whole.length - streamed)).toBeLessThanOrEqual(1)
  })

  it('passes the target rate through untouched', () => {
    const input = sine(480)
    expect(new StreamingResampler(TARGET_SAMPLE_RATE).process(input)).toEqual(input)
  })

  it('emits about a second of output per second of input, at 48k, 44.1k and 24k', () => {
    // A fixed half-kernel latency (< 2 ms) is the only shortfall; nothing is
    // dropped or duplicated per block.
    for (const rate of [48_000, 44_100, 24_000]) {
      const r = new StreamingResampler(rate)
      let total = 0
      for (let i = 0; i < 10; i += 1) total += r.process(tone(rate, 1000, 0.1, i * 0.1)).length
      expect(total).toBeLessThanOrEqual(TARGET_SAMPLE_RATE)
      expect(total).toBeGreaterThan(TARGET_SAMPLE_RATE - 32)
    }
  })

  it('splits arbitrary blocks without changing a single output sample', () => {
    // The streaming property, sample for sample: filter history and the read
    // position carry across calls, so 128-frame worklet blocks, odd-sized
    // blocks and one big block are bit-identical. 44.1 kHz is the hard case:
    // its read position never lands on a sample (ratio 2.75625).
    for (const rate of [48_000, 44_100, 24_000]) {
      const input = tone(rate, 1234, 0.25)
      const whole = new StreamingResampler(rate).process(input)
      const random = mulberry32(rate)
      const r = new StreamingResampler(rate)
      const parts: number[] = []
      for (let at = 0; at < input.length; ) {
        const size = 1 + Math.floor(random() * 300)
        parts.push(...r.process(input.subarray(at, at + size)))
        at += size
      }
      expect(Float32Array.from(parts)).toEqual(whole)
    }
  })

  it('keeps speech-band tones at unity gain', () => {
    for (const rate of [48_000, 44_100, 24_000]) {
      for (const frequency of [300, 1000, 4000, 6000]) {
        const gain = gainOf(new StreamingResampler(rate), rate, frequency)
        expect(gain, `${frequency} Hz at ${rate}`).toBeGreaterThan(0.99)
        expect(gain, `${frequency} Hz at ${rate}`).toBeLessThan(1.01)
      }
    }
  })

  it('removes energy above 8 kHz instead of folding it into the speech band', () => {
    // 2026-10-17: Mac Chrome captured at 48 kHz on every microphone, so every
    // chunk went through this class, and the linear interpolator it replaced
    // folded an 11 kHz tone to 5 kHz at full strength. `linearReference` is
    // that interpolator, verbatim in behaviour: asserting it fails the same
    // bound proves this test can tell the two apart.
    const rate = 48_000
    const fixed = gainOf(new StreamingResampler(rate), rate, 11_000)
    const old = gainOf({ process: (x) => linearReference(rate, x) }, rate, 11_000)
    expect(fixed).toBeLessThan(0.05)
    expect(old).toBeGreaterThan(0.9)
    // The measured figure is ~−100 dB; 0.05 (−26 dB) is the bound the issue
    // asked for, −60 dB the one that keeps a refactor honest.
    expect(fixed).toBeLessThan(0.001)

    for (const [inputRate, frequency] of [
      [48_000, 8_800],
      [48_000, 20_000],
      [44_100, 11_000],
      [44_100, 15_000],
      [24_000, 11_000],
    ] as const) {
      const gain = gainOf(new StreamingResampler(inputRate), inputRate, frequency)
      expect(gain, `${frequency} Hz at ${inputRate}`).toBeLessThan(0.001)
    }
  })

  it('emits exactly 100 ms chunks', () => {
    expect(SAMPLES_PER_CHUNK).toBe(1600)
    const accumulator = new ChunkAccumulator()
    const chunks = accumulator.push(new Float32Array(SAMPLES_PER_CHUNK * 2 + 5))
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) expect(chunk.length).toBe(SAMPLES_PER_CHUNK)
  })
})

function sine(length: number, offset = 0): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) out[i] = Math.sin((i + offset) / 20)
  return out
}

function tone(rate: number, frequency: number, seconds: number, startSeconds = 0): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  const start = Math.round(rate * startSeconds)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * frequency * (start + i)) / rate)
  }
  return out
}

/** RMS out / RMS in for one second of a pure tone, skipping the fade-in. */
function gainOf(
  resampler: { process: (input: Float32Array) => Float32Array },
  rate: number,
  frequency: number,
): number {
  const input = tone(rate, frequency, 1)
  const output = resampler.process(input)
  const settle = 200 // > half a kernel at 16 kHz
  return (
    VoiceActivityDetector.rms(output, settle) /
    VoiceActivityDetector.rms(input, Math.round((settle * rate) / TARGET_SAMPLE_RATE))
  )
}

/**
 * The pre-2026-10-17 `StreamingResampler` for a single block: linear
 * interpolation between the two samples around each read position, no
 * low-pass. Kept only so the aliasing test can show it would fail.
 */
function linearReference(rate: number, input: Float32Array): Float32Array {
  const ratio = rate / TARGET_SAMPLE_RATE
  const out: number[] = []
  for (let position = 0; position < input.length; position += ratio) {
    const index = Math.floor(position)
    const previous = index === 0 ? input[0]! : input[index - 1]!
    out.push(previous + (input[index]! - previous) * (position - index))
  }
  return Float32Array.from(out)
}

function speechFrame(): Float32Array {
  const speech = new Float32Array(SAMPLES_PER_CHUNK)
  for (let i = 0; i < speech.length; i += 1) speech[i] = Math.sin(i / 8) * 0.4
  return speech
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function noiseChunk(rms: number, rng: () => number): Float32Array {
  const amplitude = rms * Math.sqrt(3)
  const chunk = new Float32Array(SAMPLES_PER_CHUNK)
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = (rng() * 2 - 1) * amplitude
  return chunk
}

describe('the VAD gate contract', () => {
  const silence = new Float32Array(SAMPLES_PER_CHUNK)

  function speaking(): VoiceActivityDetector {
    const detector = new VoiceActivityDetector()
    for (let i = 0; i < VAD_DEFAULTS.attackFrames; i += 1) detector.process(speechFrame())
    return detector
  }

  it('drops silence so a quiet room cannot produce phantom segments', () => {
    const detector = new VoiceActivityDetector()
    for (let i = 0; i < 20; i += 1) detector.process(silence)
    expect(detector.process(silence)).toBe(false)
    for (let i = 0; i < VAD_DEFAULTS.attackFrames; i += 1) detector.process(speechFrame())
    expect(detector.process(speechFrame())).toBe(true)
  })

  it('an isolated spike streams one frame but buys no hangover', () => {
    const detector = new VoiceActivityDetector()
    for (let i = 0; i < 10; i += 1) detector.process(silence)
    // A single-chunk utterance ("Đúng.") is indistinguishable from a spike, so
    // the loud frame itself streams; what a lone frame must not buy is the
    // latch, so the quiet frame after it stays gated.
    expect(detector.process(speechFrame())).toBe(true)
    expect(detector.process(silence)).toBe(false)
  })

  it('holds the gate through a single quiet frame inside speech', () => {
    const detector = speaking()
    expect(detector.process(silence)).toBe(true)
    expect(detector.process(speechFrame())).toBe(true)
  })

  it('streams exactly releaseFrames quiet frames, then closes', () => {
    const detector = speaking()
    for (let i = 0; i < VAD_DEFAULTS.releaseFrames; i += 1) {
      expect(detector.process(silence)).toBe(true)
    }
    expect(detector.process(silence)).toBe(false)
  })

  it('a loud frame inside the hangover re-arms the countdown', () => {
    const detector = speaking()
    for (let i = 0; i < VAD_DEFAULTS.releaseFrames - 1; i += 1) expect(detector.process(silence)).toBe(true)
    expect(detector.process(speechFrame())).toBe(true)
    for (let i = 0; i < VAD_DEFAULTS.releaseFrames; i += 1) expect(detector.process(silence)).toBe(true)
    expect(detector.process(silence)).toBe(false)
  })

  it('a transient train cannot hold the gate past maxHoldFrames', () => {
    const detector = speaking()
    let firstGatedQuiet = -1
    for (let i = 0; i < VAD_DEFAULTS.maxHoldFrames + 12; i += 1) {
      const loud = i % 3 === 2
      const streamed = detector.process(loud ? speechFrame() : silence)
      if (loud) expect(streamed).toBe(true)
      else if (!streamed && firstGatedQuiet === -1) firstGatedQuiet = i
    }
    expect(firstGatedQuiet).toBeGreaterThanOrEqual(VAD_DEFAULTS.maxHoldFrames - 10)
    expect(firstGatedQuiet).toBeLessThanOrEqual(VAD_DEFAULTS.maxHoldFrames + 2)
  })

  it('alternating loud and quiet chunks stream continuously', () => {
    const detector = new VoiceActivityDetector()
    expect(detector.process(speechFrame())).toBe(true)
    detector.process(silence)
    expect(detector.process(speechFrame())).toBe(true)
    for (let i = 0; i < 24; i += 1) {
      expect(detector.process(i % 2 === 0 ? silence : speechFrame())).toBe(true)
    }
  })

  it('keeps the hangover under the model turn boundary — the SPEECH_RUN_GAP_MS invariant', () => {
    // This is the guard on `SPEECH_RUN_GAP_MS = TURN_SILENCE_MS − releaseFrames
    // × CHUNK_MS` in engine.ts, which must stay positive. Do not raise
    // releaseFrames past 7 without re-deriving that subtraction.
    expect(VAD_DEFAULTS.releaseFrames * CHUNK_MS).toBeLessThan(TURN_SILENCE_MS)
  })

  it('over 3 minutes at 10 dB SNR streams ≥98% of audible chunks with a stable floor', () => {
    const rng = mulberry32(1)
    const syllableRms = 0.2
    const noiseRms = syllableRms * 10 ** (-10 / 20)
    const detector = new VoiceActivityDetector()
    const factors = [1, 0.8, 0.35, 0.9, 0.3, 0.85, 0.45, 0.7, 0.25, 0.95]
    let audible = 0
    let audibleStreamed = 0
    for (let phrase = 0; phrase < 45; phrase += 1) {
      for (let i = 0; i < 24; i += 1) {
        const factor = factors[i % factors.length]!
        const chunk = noiseChunk(noiseRms, rng)
        const size = SAMPLES_PER_CHUNK / VAD_DEFAULTS.subWindows
        const window = ((i * 7) % VAD_DEFAULTS.subWindows) * size
        const amplitude = syllableRms * factor * Math.SQRT2
        for (let s = 0; s < size; s += 1) chunk[window + s]! += Math.sin(s / 8) * amplitude
        const streamed = detector.process(chunk)
        if (factor >= 0.15) {
          audible += 1
          if (streamed) audibleStreamed += 1
        }
      }
      for (let i = 0; i < 6; i += 1) detector.process(noiseChunk(noiseRms, rng))
    }
    expect(audibleStreamed / audible).toBeGreaterThanOrEqual(0.98)
    expect(detector.currentNoiseFloor).toBeLessThan(2 * noiseRms)
  })

  it('a quiet-room minute streams nothing and reads gatedWhileAudible 0', () => {
    const detector = new VoiceActivityDetector()
    const rng = mulberry32(3)
    let streamed = 0
    let gatedAudible = 0
    for (let i = 0; i < 600; i += 1) {
      if (detector.process(noiseChunk(0.0001, rng))) streamed += 1
      if (detector.lastFrameGatedWhileAudible) gatedAudible += 1
    }
    expect(streamed).toBe(0)
    expect(gatedAudible).toBe(0)
  })
})
