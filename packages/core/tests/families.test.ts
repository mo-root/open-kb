import { describe, expect, it } from "vitest"
import { openingHand, companyHand, banned } from "../src/families.js"

describe("openingHand", () => {
  it("opens with every bare term, the first term's alternatives, and the branded alternatives", () => {
    const { open } = openingHand("Web Scraper API", ["web scraper", "web scraping api"])
    expect(open.map((q) => q.q)).toEqual([
      "web scraper",
      "web scraper alternatives",
      "web scraping api",
      "Web Scraper API alternatives",
    ])
    expect(open[0]).toMatchObject({ family: "plain", product: "Web Scraper API", term: "web scraper" })
    expect(open[3]).toMatchObject({ family: "branded", term: "" })
  })

  /** Every strip term is a door — two of them return the same host only 11%
   *  of the time — and a bare term finds a known rival every 18.4 clean
   *  queries against 6.2 for `<term> alternatives`. They used to sit in the
   *  reserve, which `assess` draws from almost never: 47 of 1,455 plain
   *  queries across `runs/`. A door in the reserve is a door nobody opens. */
  it("opens the extra terms too, rather than reserving doors nobody draws", () => {
    const { open, reserve } = openingHand("Web Scraper API", [
      "web scraper",
      "web scraping api",
      "data extraction service",
    ])
    expect(open.map((q) => q.q)).toContain("web scraping api")
    expect(open.map((q) => q.q)).toContain("data extraction service")
    expect(reserve.map((q) => q.q)).not.toContain("data extraction service")
  })

  /** `<term> alternatives` is NOT displaced by them: 60% of the rows it
   *  returns are roundup-shaped against 14% for a bare term, and roundup
   *  rows are what the listicle harvest reads. */
  it("keeps the four roundup shapes and branded vs in reserve", () => {
    const { reserve } = openingHand("Web Scraper API", ["web scraper", "web scraping api"])
    expect(reserve.map((q) => q.q)).toEqual([
      "best web scraper",
      "web scraper vs",
      "top web scraper companies",
      "open source web scraper",
      "Web Scraper API vs",
    ])
  })

  it("drops case-insensitive duplicates: a product named exactly its term", () => {
    const { open, reserve } = openingHand("web scraper", ["web scraper"])
    const all = [...open, ...reserve].map((q) => q.q.toLowerCase())
    expect(new Set(all).size).toBe(all.length)
  })

  it("every query carries a non-empty why", () => {
    const { open, reserve } = openingHand("X", ["y"])
    for (const q of [...open, ...reserve]) expect(q.why.length).toBeGreaterThan(0)
  })

  it("tolerates an empty terms list: branded only", () => {
    const { open, reserve } = openingHand("Web Scraper API", [])
    expect(open.map((q) => q.q)).toEqual(["Web Scraper API alternatives"])
    expect(reserve.map((q) => q.q)).toEqual(["Web Scraper API vs"])
  })

  it("skips branded entirely for a generic-named product", () => {
    const { open, reserve } = openingHand("Datasets", ["web dataset marketplace"], { branded: false })
    const all = [...open, ...reserve]
    expect(all.some((q) => q.family === "branded")).toBe(false)
    expect(open.map((q) => q.q)).toEqual(["web dataset marketplace", "web dataset marketplace alternatives"])
  })
})

describe("banned", () => {
  it("bans a plain query that names the anchor", () => {
    expect(banned("resend alternatives to email", "plain", "resend", [])).toBe(true)
  })

  it("keeps a branded query that names the anchor — that is the family's entire point", () => {
    expect(banned("resend alternatives", "branded", "resend", [])).toBe(false)
  })

  it("bans a debranded query that contains a coinage, even with no anchor match", () => {
    expect(banned("how does broadcastify work", "debranded", "resend", ["broadcastify"])).toBe(true)
  })

  it("enforces a coinage edged with punctuation — \\b could not", () => {
    // A word boundary cannot assert between two non-word characters, so
    // "C++", ".NET" and "Copilot+" were silently unenforceable. A measured
    // corpus held 10 punctuation-edged coinages of 400 distinct.
    expect(banned("using c++ sdk here", "debranded", "anchorco", ["C++"])).toBe(true)
    expect(banned(".net runtime alternatives", "debranded", "anchorco", [".NET"])).toBe(true)
    expect(banned("copilot+ pc alternatives", "debranded", "anchorco", ["Copilot+"])).toBe(true)
  })

  it("still refuses a name that only appears inside a longer word", () => {
    expect(banned("preresending emails guide", "plain", "resend", [])).toBe(false)
    expect(banned("cnet reviews", "debranded", "anchorco", [".NET"])).toBe(false)
  })

  it("matches a full domain passed as the ban name — the common-word-label escape hatch", () => {
    // For customer.io the bare label "customer" is a market word; the caller
    // tightens the ban to the full name, which must still catch the spellings
    // that actually look the company up.
    expect(banned("customer.io alternatives", "plain", "customer.io", [])).toBe(true)
    expect(banned("customerio pricing", "plain", "customer.io", ["customerio"])).toBe(true)
    expect(banned("customer engagement platform", "plain", "customer.io", [])).toBe(false)
  })

  it("bans nothing when there is no anchor name and no coinage to check for", () => {
    // sweep.ts derives its ban name as `anchor.split(".")[0] ?? ""` — an
    // anchor domain that starts with a dot (".io", a malformed input the
    // caller does not otherwise guard against) reduces to "". With no anchor
    // name and no coinages, `forbidden` is empty and there is nothing left
    // for this predicate to check a query against, so every query must clear
    // it rather than the empty alternation being asked to decide.
    expect(banned("anything at all", "plain", "", [])).toBe(false)
    expect(banned("", "debranded", "", [])).toBe(false)
  })
})

describe("companyHand", () => {
  it("fires the company-level branded set once", () => {
    const qs = companyHand("Bright Data")
    expect(qs.map((q) => q.q)).toEqual([
      "Bright Data alternatives",
      "Bright Data vs",
      "Bright Data competitors",
    ])
    for (const q of qs) expect(q).toMatchObject({ family: "branded", product: "", term: "" })
  })
})
