// One-off placeholder-icon generator for the PWA manifest (Increment 1 of
// webapp-pos-plan.md). No logo/brand asset exists yet, so this draws a plain
// brand-colored square with a white circle mark - swap for a real design
// later, this script's only job is to unblock the manifest wiring. Pure
// Node (fs + zlib), no image-library dependency.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const ACCENT = [0xb4, 0x79, 0x4a]   // --accent from skc-web/site/assets/style.css
const WHITE = [0xff, 0xff, 0xff]

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })())
  c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

// safeMargin: fraction of the canvas kept as flush background (no mark) -
// maskable icons can be cropped to a circle, so the mark must stay inside
// the safe zone; a plain icon can use the whole canvas.
function drawPng(size, { safeMargin = 0 } = {}) {
  const rowBytes = 1 + size * 3   // filter byte + RGB per pixel
  const raw = Buffer.alloc(rowBytes * size)
  const cx = size / 2
  const cy = size / 2
  const r = size * (0.5 - safeMargin) * 0.72
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const inCircle = dx * dx + dy * dy <= r * r
      const [rr, gg, bb] = inCircle ? WHITE : ACCENT
      const px = rowStart + 1 + x * 3
      raw[px] = rr
      raw[px + 1] = gg
      raw[px + 2] = bb
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type: truecolor (RGB)
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(raw)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public', { recursive: true })
writeFileSync('public/pwa-192.png', drawPng(192))
writeFileSync('public/pwa-512.png', drawPng(512))
writeFileSync('public/maskable-512.png', drawPng(512, { safeMargin: 0.1 }))
console.log('Wrote public/pwa-192.png, public/pwa-512.png, public/maskable-512.png')
