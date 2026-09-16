import { describe, expect, it } from "vitest"
import { crc32, zipOf } from "./zip"

describe("crc32", () => {
  it("matches the known test vector", () => {
    expect(crc32(new TextEncoder().encode("abc")).toString(16)) .toBe("352441c2")
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe("zipOf", () => {
  const zip = zipOf([
    { path: "README.md", content: "# hello\n" },
    { path: "entities/a.md", content: "alpha" },
  ])

  it("carries the zip signatures and the entry count", () => {
    const sig = (off: number) =>
      zip[off]! | (zip[off + 1]! << 8) | (zip[off + 2]! << 16) | ((zip[off + 3]! << 24) >>> 0)
    expect(sig(0) >>> 0).toBe(0x04034b50)
    const eocd = zip.length - 22
    expect(sig(eocd) >>> 0).toBe(0x06054b50)
    expect(zip[eocd + 10]! | (zip[eocd + 11]! << 8)).toBe(2)
  })

  it("stores contents verbatim", () => {
    const text = new TextDecoder().decode(zip)
    expect(text).toContain("# hello")
    expect(text).toContain("entities/a.md")
  })

  it("is deterministic", () => {
    expect(zipOf([{ path: "x", content: "y" }])).toEqual(zipOf([{ path: "x", content: "y" }]))
  })
})

/**
 * Every test above reads bytes it expects at a fixed offset (0, or `length -
 * 22`) and never follows a central-directory record to the local header it
 * names. That leaves `e.offset` — the one field that must track cumulative
 * byte length across entries, not just this entry's own size — asserted by
 * no test at all: a multi-entry run could point entry 2 at entry 1's header
 * and every existing assertion would still pass, because none of them ever
 * dereference that field. Same gap for `e.crc`: written from `crc32(data)`
 * at build time, never read back and recomputed. This walks the archive the
 * way a real reader must — central directory -> offset -> local header ->
 * data — so both are actually exercised, on entries whose lengths differ
 * (so a wrong offset lands mid-header, not at another entry's boundary by
 * coincidence) and on multi-byte UTF-8 content (so a byte-length bug would
 * show as truncated or shifted output, not just a wrong count).
 */
describe("zipOf — a real reader's path through the archive", () => {
  function readZip(zip: Uint8Array): Array<{ path: string; content: string }> {
    const dec = new TextDecoder()
    const u16 = (o: number) => zip[o]! | (zip[o + 1]! << 8)
    const u32 = (o: number) => (zip[o]! | (zip[o + 1]! << 8) | (zip[o + 2]! << 16) | (zip[o + 3]! << 24)) >>> 0

    const eocd = zip.length - 22
    expect(u32(eocd)).toBe(0x06054b50)
    const count = u16(eocd + 10)
    let cdOff = u32(eocd + 16)

    const out: Array<{ path: string; content: string }> = []
    for (let i = 0; i < count; i++) {
      expect(u32(cdOff)).toBe(0x02014b50)
      const crc = u32(cdOff + 16)
      const size = u32(cdOff + 24)
      const nameLen = u16(cdOff + 28)
      const localOffset = u32(cdOff + 42)
      const name = dec.decode(zip.slice(cdOff + 46, cdOff + 46 + nameLen))

      expect(u32(localOffset)).toBe(0x04034b50)
      const localNameLen = u16(localOffset + 26)
      const dataStart = localOffset + 30 + localNameLen
      const data = zip.slice(dataStart, dataStart + size)
      expect(crc32(data)).toBe(crc)

      out.push({ path: name, content: dec.decode(data) })
      cdOff += 46 + nameLen
    }
    return out
  }

  it("round-trips path, byte-exact content and crc for every entry via its own offset", () => {
    const files = [
      { path: "README.md", content: "# hello\n" },
      { path: "entities/a.md", content: "alpha, a longer body than the first entry" },
      { path: "entities/emoji.md", content: "café 🎯 — multi-byte content, byte length must drive every offset" },
    ]
    expect(readZip(zipOf(files))).toEqual(files)
  })

  it("stays a valid, empty archive when there are no files", () => {
    expect(readZip(zipOf([]))).toEqual([])
  })
})
