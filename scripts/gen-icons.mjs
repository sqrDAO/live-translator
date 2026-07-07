// Generates PWA icons (192/512 PNG) without any image dependencies:
// draws at 4x with simple shape math, box-downsamples for antialiasing,
// and encodes PNG via node:zlib.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const BG = [11, 14, 19]
const EN = [133, 179, 255]
const VI = [255, 201, 102]

function drawIcon(size) {
  const S = size * 4 // supersample
  const px = new Uint8Array(S * S * 3)
  const r = S * 0.5
  const cornerR = S * 0.22

  const cxA = S * 0.36, cyA = S * 0.42, rA = S * 0.21 // EN circle
  const cxB = S * 0.64, cyB = S * 0.58, rB = S * 0.21 // VI circle

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // rounded-square mask
      const dx = Math.max(Math.abs(x - r) - (r - cornerR), 0)
      const dy = Math.max(Math.abs(y - r) - (r - cornerR), 0)
      const inside = dx * dx + dy * dy <= cornerR * cornerR
      let c = inside ? BG : [0, 0, 0]

      if (inside) {
        const inA = (x - cxA) ** 2 + (y - cyA) ** 2 <= rA * rA
        const inB = (x - cxB) ** 2 + (y - cyB) ** 2 <= rB * rB
        if (inA && inB) c = [236, 231, 219] // overlap → ivory
        else if (inA) c = EN
        else if (inB) c = VI
      }
      const i = (y * S + x) * 3
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]
    }
  }

  // box downsample 4x → RGBA
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const i = ((y * 4 + sy) * S + x * 4 + sx) * 3
          rr += px[i]; gg += px[i + 1]; bb += px[i + 2]
        }
      }
      const o = (y * size + x) * 4
      out[o] = rr / 16; out[o + 1] = gg / 16; out[o + 2] = bb / 16; out[o + 3] = 255
    }
  }
  return out
}

// ── minimal PNG encoder ──────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [192, 512]) {
  const file = join(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, encodePng(drawIcon(size), size))
  console.log('wrote', file)
}
