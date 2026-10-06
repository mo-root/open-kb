import { describe, expect, it } from "vitest"
import { clampCursor, rankMatches, type SearchItem } from "./search"

const item = (over: Partial<SearchItem> & { id: string }): SearchItem => ({
  title: over.id,
  type: "player",
  deg: 1,
  ...over,
})

const MAP: SearchItem[] = [
  item({ id: "a", title: "Apify", domain: "apify.com", deg: 12 }),
  item({ id: "b", title: "Scrapfly", domain: "scrapfly.io", deg: 22 }),
  item({ id: "c", title: "Bright Data alternatives roundup", domain: "example.com" }),
  item({ id: "d", title: "Zyte", domain: "zyte.com", deg: 3 }),
  item({ id: "e", title: "apiscrapy", domain: "apiscrapy.com", deg: 2 }),
]

describe("rankMatches", () => {
  it("returns nothing for an empty query rather than the whole map", () => {
    expect(rankMatches(MAP, "")).toEqual([])
    expect(rankMatches(MAP, "   ")).toEqual([])
  })

  it("puts a title prefix ahead of a mid-title substring", () => {
    // "apify" prefixes Apify; it appears nowhere in the roundup title, but
    // "api" does — and a prefix must always win.
    const hits = rankMatches(MAP, "api")
    expect(hits[0]!.id).toBe("a")
  })

  it("finds a node by its domain, not just its title", () => {
    const hits = rankMatches(MAP, "zyte.com")
    expect(hits.map((h) => h.id)).toContain("d")
  })

  it("is case-insensitive", () => {
    expect(rankMatches(MAP, "APIFY")[0]!.id).toBe("a")
    expect(rankMatches(MAP, "bright")[0]!.id).toBe("c")
  })

  it("breaks a tie toward the better-connected node", () => {
    const tie = [
      item({ id: "low", title: "Same Name", deg: 1 }),
      item({ id: "high", title: "Same Name", deg: 30 }),
    ]
    expect(rankMatches(tie, "same")[0]!.id).toBe("high")
  })

  it("never lets degree overturn a prefix hit", () => {
    // Otherwise a huge hub containing the query mid-string would outrank the
    // node the reader actually typed the start of.
    const items = [
      item({ id: "hub", title: "a big scrapfly comparison", deg: 90 }),
      item({ id: "exact", title: "Scrapfly", deg: 1 }),
    ]
    expect(rankMatches(items, "scrapfly")[0]!.id).toBe("exact")
  })

  it("caps the list so the dropdown cannot cover the graph", () => {
    const many = Array.from({ length: 60 }, (_, i) => item({ id: `n${i}`, title: `node ${i}` }))
    expect(rankMatches(many, "node").length).toBe(8)
    expect(rankMatches(many, "node", 3).length).toBe(3)
  })

  it("tolerates a node with no domain", () => {
    expect(() => rankMatches([item({ id: "x", title: "No Domain" })], "no")).not.toThrow()
  })

  it("falls back to a mid-domain substring when the title has no hit at all", () => {
    // "ample" is absent from every title in MAP (including item c's) and from
    // every domain's start; it only turns up inside "example.com" — the one
    // branch (score = 20 + domain.indexOf(q)) every other test leaves cold.
    expect(rankMatches(MAP, "ample").map((h) => h.id)).toEqual(["c"])
  })
})

describe("clampCursor", () => {
  it("is 0 on an empty result set, not -1", () => {
    // GraphSearch.tsx's old inline `Math.min(c + 1, results.length - 1)`
    // landed on -1 here (length - 1 is -1 with nothing to navigate).
    expect(clampCursor(0, 0)).toBe(0)
    expect(clampCursor(1, 0)).toBe(0)
  })

  it("leaves an in-range cursor untouched", () => {
    expect(clampCursor(2, 5)).toBe(2)
  })

  it("pulls a cursor left over the end of the list that was there", () => {
    // The shape that was reachable without GraphSearch.tsx's results.length
    // effect: toggling a node type off shrinks `results` for an unchanged
    // query, and a cursor the reader had moved past the new last index must
    // land ON the new last row, not past it.
    expect(clampCursor(4, 2)).toBe(1)
  })

  it("never returns a negative index for a negative input", () => {
    expect(clampCursor(-1, 5)).toBe(0)
  })
})
