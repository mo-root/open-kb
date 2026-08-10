import { describe, expect, it } from "vitest"
import { rankMatches, type SearchItem } from "./search"

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
    expect(hits[0].id).toBe("a")
  })

  it("finds a node by its domain, not just its title", () => {
    const hits = rankMatches(MAP, "zyte.com")
    expect(hits.map((h) => h.id)).toContain("d")
  })

  it("is case-insensitive", () => {
    expect(rankMatches(MAP, "APIFY")[0].id).toBe("a")
    expect(rankMatches(MAP, "bright")[0].id).toBe("c")
  })

  it("breaks a tie toward the better-connected node", () => {
    const tie = [
      item({ id: "low", title: "Same Name", deg: 1 }),
      item({ id: "high", title: "Same Name", deg: 30 }),
    ]
    expect(rankMatches(tie, "same")[0].id).toBe("high")
  })

  it("never lets degree overturn a prefix hit", () => {
    // Otherwise a huge hub containing the query mid-string would outrank the
    // node the reader actually typed the start of.
    const items = [
      item({ id: "hub", title: "a big scrapfly comparison", deg: 90 }),
      item({ id: "exact", title: "Scrapfly", deg: 1 }),
    ]
    expect(rankMatches(items, "scrapfly")[0].id).toBe("exact")
  })

  it("caps the list so the dropdown cannot cover the graph", () => {
    const many = Array.from({ length: 60 }, (_, i) => item({ id: `n${i}`, title: `node ${i}` }))
    expect(rankMatches(many, "node").length).toBe(8)
    expect(rankMatches(many, "node", 3).length).toBe(3)
  })

  it("tolerates a node with no domain", () => {
    expect(() => rankMatches([item({ id: "x", title: "No Domain" })], "no")).not.toThrow()
  })
})
