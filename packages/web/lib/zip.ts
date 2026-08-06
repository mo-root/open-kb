/**
 * A store-only zip writer — no compression, no dependency. The export button
 * ships a folder of markdown; markdown is small and the point is the shape,
 * so stored entries (method 0) keep this at ~70 lines a reader can audit
 * instead of a library nobody opens.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Entry {
  name: Uint8Array
  data: Uint8Array
  crc: number
  offset: number
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff]
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}

/** Build a zip from named text files. Deterministic: fixed timestamps. */
export function zipOf(files: Array<{ path: string; content: string }>): Uint8Array {
  const enc = new TextEncoder()
  const chunks: number[] = []
  const entries: Entry[] = []

  for (const f of files) {
    const name = enc.encode(f.path)
    const data = enc.encode(f.content)
    const crc = crc32(data)
    const offset = chunks.length
    // local file header
    chunks.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0))
    for (const b of name) chunks.push(b)
    for (const b of data) chunks.push(b)
    entries.push({ name, data, crc, offset })
  }

  const cdStart = chunks.length
  for (const e of entries) {
    chunks.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(e.crc), ...u32(e.data.length), ...u32(e.data.length), ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(e.offset))
    for (const b of e.name) chunks.push(b)
  }
  const cdSize = chunks.length - cdStart
  chunks.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(cdStart), ...u16(0))

  return Uint8Array.from(chunks)
}
