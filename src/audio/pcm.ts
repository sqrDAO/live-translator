export function float32ToPcm16Bytes(f32: Float32Array): Uint8Array {
  const out = new Uint8Array(f32.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
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
