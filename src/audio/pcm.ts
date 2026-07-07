export function float32ToPcm16Bytes(f32: Float32Array): Uint8Array {
  const out = new Uint8Array(f32.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/**
 * True if the chunk is (near-)silence. The Live Translate session whose target
 * language matches the speaker (echoTargetLanguage=false) streams silence —
 * usually exact zeros but sometimes with a tiny noise floor (peak ≈ 0.007).
 * Those chunks must not reach the player or they interleave with the other
 * session's real audio and hold the mic duck open forever.
 */
const SILENCE_PEAK = 500 // int16 units ≈ 0.015 full-scale

export function isSilentPcm(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < bytes.byteLength - 1; i += 2) {
    const s = view.getInt16(i, true)
    if (s > SILENCE_PEAK || s < -SILENCE_PEAK) return false
  }
  return true
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Streaming linear-interpolation resampler (keeps fractional phase across chunks). */
export class Resampler {
  private remainder = new Float32Array(0)
  private phase = 0
  constructor(private fromRate: number, private toRate: number) {}

  process(input: Float32Array): Float32Array {
    const data = new Float32Array(this.remainder.length + input.length)
    data.set(this.remainder)
    data.set(input, this.remainder.length)

    const ratio = this.fromRate / this.toRate
    const out: number[] = []
    let pos = this.phase
    while (pos < data.length - 1) {
      const i0 = Math.floor(pos)
      const t = pos - i0
      out.push(data[i0] * (1 - t) + data[i0 + 1] * t)
      pos += ratio
    }
    const keepFrom = Math.min(Math.floor(pos), data.length - 1)
    this.remainder = data.slice(keepFrom)
    this.phase = pos - keepFrom
    return Float32Array.from(out)
  }
}
