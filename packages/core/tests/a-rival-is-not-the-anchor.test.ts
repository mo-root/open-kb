import { describe, expect, it } from "vitest"
import { banned, rivalHand } from "../src/families.js"

/**
 * The thesis is that a non-branded query never rides the ANCHOR's name. It has
 * never been that a query may not name anyone else, and these are the tests
 * that hold both halves of that sentence at once.
 */

const NAMES = ["wix", "bigcommerce", "squarespace", "magento", "etsy", "webflow"]

describe("rivalHand", () => {
  it("spends two thirds on the shortlist shape and the rest on pairs", () => {
    expect(rivalHand(NAMES, 6).map((q) => q.q)).toEqual([
      "wix alternatives",
      "bigcommerce alternatives",
      "squarespace alternatives",
      "magento alternatives",
      "wix vs bigcommerce",
      "squarespace vs magento",
    ])
  })

  it("names no name twice in the pair shape", () => {
    const pairs = rivalHand(NAMES, 6)
      .filter((q) => q.q.includes(" vs "))
      .flatMap((q) => q.q.split(" vs "))
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it("never exceeds the budget, whatever the budget is", () => {
    for (const cap of [1, 2, 3, 5, 9, 40])
      expect(rivalHand(NAMES, cap).length).toBeLessThanOrEqual(cap)
  })

  it("spends what it can when there are fewer names than budget", () => {
    expect(rivalHand(["wix", "magento", "etsy"], 10).map((q) => q.q)).toEqual([
      "wix alternatives",
      "magento alternatives",
      "etsy alternatives",
      "wix vs magento",
    ])
  })

  it("buys nothing with no budget, and nothing with no names", () => {
    expect(rivalHand(NAMES, 0)).toEqual([])
    expect(rivalHand(NAMES, -3)).toEqual([])
    expect(rivalHand([], 8)).toEqual([])
    expect(rivalHand([" ", ""], 8)).toEqual([])
  })

  it("tags every query with the family and the name that grounded it", () => {
    const [first, ...rest] = rivalHand(NAMES, 6)
    expect(first).toMatchObject({ family: "rival", product: "", term: "wix" })
    expect(rest.at(-1)).toMatchObject({ family: "rival", term: "squarespace, magento" })
    for (const q of rivalHand(NAMES, 6)) expect(q.why.length).toBeGreaterThan(0)
  })

  it("asks the same question once, however the names repeat", () => {
    const qs = rivalHand(["wix", "wix", "magento"], 6).map((q) => q.q)
    expect(new Set(qs).size).toBe(qs.length)
  })
})

describe("banned, on the rival family", () => {
  it("keeps a query that names a rival — naming a rival is not naming the anchor", () => {
    for (const q of rivalHand(NAMES, 6))
      expect(banned(q.q, q.family, "shopify", ["shopify plus", "shop pay"])).toBe(false)
  })

  it("drops a rival query that also names the anchor, which a slug can hand back", () => {
    // `/compare/shopify-plus-vs-magento` on an anchor whose coinage is
    // "shopify plus": the extraction never saw the coinage list, this check did.
    expect(banned("shopify plus alternatives", "rival", "shopify", ["shopify plus"])).toBe(true)
    expect(banned("wix vs shopify", "rival", "shopify", [])).toBe(true)
  })

  it("still exempts branded, and still bans plain — the rival family changed neither", () => {
    expect(banned("shopify alternatives", "branded", "shopify", [])).toBe(false)
    expect(banned("shopify alternatives", "plain", "shopify", [])).toBe(true)
  })
})
