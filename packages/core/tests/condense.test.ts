import { describe, it, expect } from "vitest"
import { condense } from "../src/sniff.js"

/** A link index: many links, almost no prose. This is the shape of a
 *  machine-readable site index, and the shape a prefix handles worst. */
function index(n: number, sections: string[]): string {
  const rows: string[] = ["# Docs", "## Reference"]
  for (let i = 0; i < n; i++) {
    const s = sections[i % sections.length]!
    rows.push(`- [page ${i} about something](https://example.com/${s}/page-${i}) — some trailing description text`)
  }
  return rows.join("\n")
}

describe("condense", () => {
  it("leaves a page that already fits completely alone", () => {
    const t = "# Small\n\nnot much here at all"
    expect(condense(t, 24_000)).toBe(t)
  })

  it("keeps every section of a link index, including ones past a prefix cut", () => {
    // The measured failure: a product line appearing only past the cut was
    // invisible, so the model invented the catalog instead of reading it.
    const t = index(800, ["proxies", "unlocker", "serp", "datasets", "browser"])
    const out = condense(t, 24_000)
    expect(t.length).toBeGreaterThan(24_000)
    for (const s of ["proxies", "unlocker", "serp", "datasets", "browser"]) {
      expect(out).toContain(s)
    }
    // and the one a plain prefix would have missed
    expect(t.slice(0, 14_000)).not.toContain("page 799")
    expect(out.length).toBeLessThanOrEqual(24_000)
  })

  it("folds paths two segments deep and counts them", () => {
    const out = condense(index(500, ["products/serp-api", "products/unlocker"]), 24_000)
    expect(out).toMatch(/products\/serp-api \(\d+\)/)
  })

  it("cuts a prose page rather than folding it — there the prefix IS the content", () => {
    const prose = "word ".repeat(10_000)
    const out = condense(prose, 5_000)
    expect(out).toBe(prose.slice(0, 5_000))
    expect(out).not.toContain("sections, by page count")
  })

  it("falls back to a cut when the links carry no usable paths", () => {
    const t = Array.from({ length: 60 }, (_, i) => `- [x](not-a-url-${i})`).join("\n") + "x".repeat(30_000)
    expect(condense(t, 6_000)).toHaveLength(6_000)
  })
})
