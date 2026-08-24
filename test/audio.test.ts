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
