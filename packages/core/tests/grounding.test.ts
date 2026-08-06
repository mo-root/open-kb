import { describe, it, expect } from "vitest"
import { descriptionGrounding } from "../src/grounding.js"

describe("descriptionGrounding", () => {
  it("scores a fully grounded description at 1 with nothing ungrounded", () => {
    const r = descriptionGrounding(
      "a scraping api for developers",
      "We sell a scraping API to developers around the world.",
    )
    expect(r.score).toBe(1)
    expect(r.ungrounded).toEqual([])
  })

  it("an invented claim scores low and names the missing terms, longest first", () => {
    // The measured residual error class: a correctly-placed competitor whose
    // description invents "custom dataset delivery" its page nowhere offers.
    const r = descriptionGrounding(
      "a proxy provider that also offers custom dataset delivery",
      "Acme sells residential proxies to developers. A trusted proxy provider for scraping teams, with rotating IPs.",
    )
    // terms: proxy, provider, custom, dataset, delivery, "proxy provider",
    // "custom dataset", "dataset delivery" — 3 of 8 appear on the page.
    expect(r.score).toBeCloseTo(3 / 8)
    expect(r.ungrounded[0]).toBe("dataset delivery")
    expect(r.ungrounded).toContain("custom dataset")
    expect(r.ungrounded).toContain("custom")
  })

  it("boundary discipline: 'api' does not match inside 'rapid'", () => {
    const r = descriptionGrounding("api", "rapid results delivered rapidly")
    expect(r.score).toBe(0)
    expect(r.ungrounded).toEqual(["api"])
  })

  it("boundary discipline: a term followed by a path or punctuation still matches", () => {
    expect(descriptionGrounding("api", "see api/pricing for details").score).toBe(1)
    expect(descriptionGrounding("api", "an API for everyone").score).toBe(1)
  })

  it("a 2-gram matches across whitespace and punctuation but not across other words", () => {
    // "dataset\n delivery" is the same claim; "dataset-based delivery" is not.
    expect(descriptionGrounding("dataset delivery", "dataset\n delivery schedules").score).toBe(1)
    const r = descriptionGrounding("dataset delivery", "dataset-based delivery vans")
    // 1-grams both appear (hyphen is a boundary); the 2-gram does not.
    expect(r.score).toBeCloseTo(2 / 3)
    expect(r.ungrounded).toEqual(["dataset delivery"])
  })

  it("a stopword between two content words breaks the 2-gram", () => {
    // "api for developers": "api developers" is not a claim the desc makes.
    const r = descriptionGrounding("api for developers", "api tools and developers")
    expect(r.score).toBe(1)
  })

  it("an empty description claims nothing: score 1, nothing ungrounded", () => {
    expect(descriptionGrounding("", "any page text")).toEqual({ score: 1, ungrounded: [] })
  })

  it("a description of only stopwords claims nothing either", () => {
    expect(descriptionGrounding("the of and that", "any page text")).toEqual({
      score: 1,
      ungrounded: [],
    })
  })

  it("an empty page grounds nothing: score 0 with no term-level findings", () => {
    expect(descriptionGrounding("real content claims", "")).toEqual({ score: 0, ungrounded: [] })
    expect(descriptionGrounding("real content claims", "   \n ")).toEqual({ score: 0, ungrounded: [] })
  })

  it("caps ungrounded at 8, longest first", () => {
    const r = descriptionGrounding(
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "zulu",
    )
    expect(r.score).toBe(0)
    expect(r.ungrounded).toHaveLength(8)
    for (let i = 1; i < r.ungrounded.length; i++) {
      expect(r.ungrounded[i - 1]!.length).toBeGreaterThanOrEqual(r.ungrounded[i]!.length)
    }
  })

  it("is case-insensitive in both directions", () => {
    expect(descriptionGrounding("Proxy Networks", "the largest PROXY network's reach").score).toBeGreaterThan(0)
    expect(descriptionGrounding("PROXY", "a proxy for everyone").score).toBe(1)
  })

  it("dedupes repeated terms rather than double-counting them", () => {
    // "proxy proxy proxy" is one claim, not three.
    const r = descriptionGrounding("proxy proxy proxy", "no such word here")
    expect(r.ungrounded).toEqual(["proxy proxy", "proxy"])
  })
})
