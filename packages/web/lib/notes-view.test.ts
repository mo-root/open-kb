import { describe, it, expect } from "vitest"
import { filterNotes, noteHaystack, orderNotes, relationFacets, tierRank } from "./notes-view"
import type { NoteRef } from "./viewTypes"

/**
 * The organization logic behind an 844-row entities list. On the live
 * brightdata run the sidebar was one text box over five alphabetical groups:
 * answering "show me the competitors" meant knowing the classifier's exact
 * vocabulary, and nothing anywhere ordered by evidence tier. These pin the
 * pure logic the tabs now render.
 */

function ref(over: Partial<NoteRef> & { title: string }): NoteRef {
  return {
    path: `players/${over.title.toLowerCase()}.md`,
    relevance: 50,
    type: "player",
    kind: "company",
    relation: "competitor",
    domain: `${over.title.toLowerCase()}.com`,
    what: "",
    why: "",
    ...over,
  }
}

describe("tierRank", () => {
  it("ranks the provenance ladder strongest first, absence last", () => {
    expect(tierRank("own-page")).toBeLessThan(tierRank("page"))
    expect(tierRank("page")).toBeLessThan(tierRank("snippet"))
    expect(tierRank("snippet")).toBeLessThan(tierRank(undefined))
  })

  it("ranks a tier it has never heard of above no tier at all — the run asserted something", () => {
    expect(tierRank("carrier-pigeon")).toBeGreaterThan(tierRank("snippet"))
    expect(tierRank("carrier-pigeon")).toBeLessThan(tierRank(undefined))
  })
})

describe("orderNotes", () => {
  it("orders by placement, then evidence tier, then title", () => {
    const out = orderNotes([
      ref({ title: "B", relevance: 95, tier: "snippet" }),
      ref({ title: "C", relevance: 85 }),
      ref({ title: "A", relevance: 95, tier: "own-page" }),
    ])
    expect(out.map((n) => n.title)).toEqual(["A", "B", "C"])
  })

  it("is a no-op reordering on a run recorded before tiers existed", () => {
    // every sweep run: no tier anywhere, so the order is placement then title
    const out = orderNotes([
      ref({ title: "Z", relevance: 85 }),
      ref({ title: "A", relevance: 85 }),
      ref({ title: "M", relevance: 95 }),
    ])
    expect(out.map((n) => n.title)).toEqual(["M", "A", "Z"])
  })

  it("returns a copy — the caller's array is React state", () => {
    const input = [ref({ title: "B" }), ref({ title: "A" })]
    const out = orderNotes(input)
    expect(out).not.toBe(input)
    expect(input.map((n) => n.title)).toEqual(["B", "A"])
  })
})

describe("relationFacets", () => {
  it("counts every relation present, strongest placement first", () => {
    const facets = relationFacets([
      ref({ title: "A", relation: "substitute", relevance: 85 }),
      ref({ title: "B", relation: "competitor", relevance: 95 }),
      ref({ title: "C", relation: "substitute", relevance: 85 }),
      ref({ title: "D", relation: "none", relevance: 15 }),
    ])
    expect(facets).toEqual([
      { relation: "competitor", count: 1 },
      { relation: "substitute", count: 2 },
      { relation: "none", count: 1 },
    ])
  })

  it("breaks equal-weight ties by count then name, so the chip row is stable", () => {
    const facets = relationFacets([
      ref({ title: "A", relation: "unknown", relevance: 15 }),
      ref({ title: "B", relation: "none", relevance: 15 }),
      ref({ title: "C", relation: "none", relevance: 15 }),
    ])
    expect(facets.map((f) => f.relation)).toEqual(["none", "unknown"])
  })

  it("answers nothing for an empty list rather than inventing a facet", () => {
    expect(relationFacets([])).toEqual([])
  })
})

describe("noteHaystack and filterNotes", () => {
  it("matches name, domain and relation, case-insensitively", () => {
    const notes = [
      ref({ title: "Postmark", domain: "postmarkapp.com", relation: "competitor" }),
      ref({ title: "Zapier", domain: "zapier.com", relation: "integration" }),
    ]
    expect(filterNotes(notes, { query: "POSTMARK" })).toHaveLength(1)
    expect(filterNotes(notes, { query: "integration" })[0]?.title).toBe("Zapier")
  })

  it("finds a host by the product name a swarm merge folded into it", () => {
    const host = ref({
      title: "Zyte",
      domain: "zyte.com",
      also: [{ name: "Scrapy Cloud", what: "a hosted scrapy runner" }],
    })
    expect(noteHaystack(host)).toContain("scrapy cloud")
    expect(filterNotes([host, ref({ title: "Other" })], { query: "scrapy" })).toEqual([host])
  })

  it("combines the typed query with the clicked relation facet", () => {
    const notes = [
      ref({ title: "Acme", relation: "competitor" }),
      ref({ title: "Acme Labs", relation: "integration" }),
      ref({ title: "Beta", relation: "competitor" }),
    ]
    const out = filterNotes(notes, { query: "acme", relation: "competitor" })
    expect(out.map((n) => n.title)).toEqual(["Acme"])
  })

  it("with nothing to filter by, returns every row", () => {
    const notes = [ref({ title: "A" }), ref({ title: "B" })]
    expect(filterNotes(notes, {})).toHaveLength(2)
    expect(filterNotes(notes, { query: "  ", relation: null })).toHaveLength(2)
  })
})
