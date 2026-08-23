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

  /**
   * THE BUDGET IS A BOUND, NOT A SUGGESTION.
   *
   * The structure block — every heading, then every folded section — used to
   * be built in full and only THEN subtracted from the budget. A page with
   * thousands of headings produced a structure bigger than the whole budget,
   * so `room` went negative, the prose was dropped, and the oversized
   * structure was returned regardless.
   *
   * MEASURED on datadoghq.com/llms.txt, 566,047 chars: 96,760 returned at
   * budget 24,000 and the SAME 96,760 at budget 8,000 — the argument did
   * nothing at all. Downstream that pushed the understand prompt past what the
   * model would answer; the call was refused twice on a truncated body and the
   * run died before buying a single search, so an anchor that publishes a big
   * enough index could not be mapped.
   */
  const hugeIndex = () =>
    Array.from({ length: 2_000 }, (_, i) => `### Section number ${i} with a fairly long heading line`).join("\n") +
    "\n" +
    Array.from({ length: 2_000 }, (_, i) => `- [row ${i}](https://x.com/area-${i}/page-${i})`).join("\n")

  it("never returns more than the budget, however many headings the page has", () => {
    const t = hugeIndex()
    // Far past the fold threshold, and the structure alone would dwarf these.
    for (const budget of [24_000, 8_000, 2_000, 500]) {
      expect(condense(t, budget).length).toBeLessThanOrEqual(budget)
    }
  })

  it("says how many rows it dropped rather than shortening the list in silence", () => {
    const out = condense(hugeIndex(), 4_000)
    // A reader who sees the count knows the map was built off a sample.
    expect(out).toMatch(/\+[\d,]+ more/)
  })

  it("keeps the biggest sections when it has to choose", () => {
    // One section with many pages, one with few: the crowded one is the one a
    // reader needs when only some can survive.
    const many = Array.from({ length: 400 }, (_, i) => `- [a](https://x.com/crowded/page-${i})`)
    const few = Array.from({ length: 2 }, (_, i) => `- [b](https://x.com/quiet/page-${i})`)
    const heads = Array.from({ length: 500 }, (_, i) => `### heading ${i}`)
    const out = condense([...heads, ...many, ...few].join("\n"), 3_000)
    expect(out).toContain("crowded")
  })
})
