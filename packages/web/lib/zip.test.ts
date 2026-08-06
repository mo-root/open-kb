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
