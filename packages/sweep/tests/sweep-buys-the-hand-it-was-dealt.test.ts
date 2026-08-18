import { describe, it, expect, beforeAll } from "vitest"
import { openingHand, companyHand } from "@open-kb/core"
import { ANCHOR_NAME, COINAGE, runFixture, type Harness } from "./fixture.js"

/**
 * WHAT THE RUN BOUGHT, exactly, and nothing else.
 *
 * The opening catalog is the only part of a sweep that spends before it has
 * learned anything, so it is the part where a mistake is pure loss: a query
 * that names the anchor's own name buys a page about the anchor, which the map
 * already has, and a product that never gets a hand is a whole market the map
 * cannot see. Both failures are silent — a dropped query and a query that found
 * nothing produce the same empty result — which is why these assertions are
 * against `FakeSearch.calls`, the queries that actually reached the port,
 * rather than against what came back.
 *
 * The expectations are BUILT FROM `openingHand`/`companyHand` rather than
 * typed out. That makes this a contract test between `@open-kb/core`'s family
 * templates and the engine that fires them: change a template and this file
 * follows, change the engine's idea of which templates open and it goes red.
 */
describe("the opening catalog", () => {
  let h: Harness
  const LOG_TERMS = ["log search", "log management"]
  // `core: true` — log search is the fixture's core market, and a core
  // product's second strip term opens with the hand (the cursor.com lesson:
  // "AI code editor" sat in reserve and windsurf never surfaced).
  const logHand = openingHand("Log Search Cloud", LOG_TERMS, { branded: true, core: true })
  const upHand = openingHand("Uptime Alerts", ["uptime monitoring"], { branded: false })
  const co = companyHand("Pellucid")

  beforeAll(async () => {
    h = await runFixture()
  }, 30_000)

  it("deals every product an opening hand, core market first, and buys the reserve from none of them", () => {
    // ORDER, off `result.queries` — the plan as the engine composed it, before
    // a pool decided who ran what. `log search` is the core market and
    // `uptime alerts` the adjacent one, so the core product's whole hand comes
    // first even though the adjacent product is a real market with real rivals.
    const planned = h.result.queries.map((q) => q.q)
    expect(planned).toEqual([
      ...logHand.open.map((f) => f.q),
      "how do i find one request across a hundred containers",
      "keeping a year of logs without paying per seat",
      ...upHand.open.map((f) => f.q),
      "who gets paged when an endpoint stops answering",
      "synthetic checks from more than one region",
      ...co.map((f) => f.q),
    ])

    // A held template is a query the run has decided not to buy yet. If any of
    // these reach the port at the open, the widening loop has nothing left to
    // draw and the opening costs whatever the whole hand costs.
    const reserve = [...logHand.reserve, ...upHand.reserve].map((f) => f.q)
    expect(reserve.length).toBeGreaterThan(4)
    for (const q of reserve) expect(h.asked).not.toContain(q)
  })

  it("buys each query exactly once, and buys nothing that was not planned", () => {
    // The port dedupes, so a repeat would be free — but the engine must not
    // rely on that, because `serpCalls` and the yield table are both computed
    // from what it SENT.
    expect([...h.asked].sort()).toEqual([...h.result.queries.map((q) => q.q)].sort())
    expect(new Set(h.asked).size).toBe(h.asked.length)
  })

  it("never buys the anchor's own name or a coinage, and says so without pretending they were never written", () => {
    const named = [`${COINAGE} log pipeline sizing`, `${ANCHOR_NAME} status page setup`]
    for (const q of named) expect(h.asked).not.toContain(q)

    // Dropped, not counted: `written` is what the model produced and `queries`
    // is what survived. Collapsing the two is how a catalog reports "0 named
    // the company" on a run where two did.
    const [plan] = h.ui("results", "planned")
    expect(plan!.written).toBe(16)
    expect((plan!.queries as unknown[]).length).toBe(14)
    expect(h.result.stats.queries).toBe(14)
  })

  it("still buys the branded family, whose whole point is naming the anchor", () => {
    // The counterweight to the test above. A ban that fired on family as well
    // as on text would pass every assertion up there and quietly delete the
    // densest comparison pages a map has — visible only here, as a branded
    // count that fell to zero.
    for (const f of co) expect(h.asked).toContain(f.q)
    expect(h.asked).toContain("Log Search Cloud alternatives")
    expect(h.result.report.families).toEqual({ plain: 6, branded: 4, debranded: 4 })
  })

  it("records the strip each product was reduced to, with the page that established it", () => {
    // The audit trail the spec promises. `generic` decides whether a product
    // gets a branded query at all, so it is the one field here that changed
    // what was bought: Uptime Alerts is generic and has no branded opener.
    expect(h.result.report.strips).toEqual([
      {
        product: "Log Search Cloud",
        terms: LOG_TERMS,
        generic: false,
        foundAt: "https://pellucid.example/products/log-search",
      },
      {
        product: "Uptime Alerts",
        terms: ["uptime monitoring"],
        generic: true,
        foundAt: "https://pellucid.example/products/uptime-alerts",
      },
    ])
    expect(upHand.open.some((f) => f.family === "branded")).toBe(false)
  })

  it("keeps noise in the entity list and off the map, edges included", () => {
    // Noise is the one kind that LEAVES the map, and it leaves at exactly one
    // line — `entities.filter(kind !== "noise")`. Everything downstream reads
    // the filtered set: the counts, the co-occurrence selector, the naming
    // pass, the pairs the model is asked about. A coupon site that survived
    // that filter would not throw anything; it would quietly become a node
    // with edges to two real vendors.
    const noise = h.result.entities.find((e) => e.domain === "adtrash.example")
    expect(noise!.kind).toBe("noise")
    expect(h.result.report.entities).toBe(6)
    expect(h.result.report.kept).toBe(5)
    expect(h.result.report.noise).toBe(1)
    expect(h.result.stats.kept).toBe(5)
    for (const e of h.result.edges ?? []) {
      expect([e.from, e.to]).not.toContain("adtrash.example")
    }
  })

  it("hangs every host on the market whose query surfaced it", () => {
    // `foundBy` is the join that turns the graph from a star into a map, and it
    // is the field that was computed nowhere for a while: every hit knows its
    // query and every query knows its market, and the two were simply never put
    // together. `forum.example` arrives through both markets; the strongest
    // comes first.
    const by = (d: string) => h.result.entities.find((e) => e.domain === d)
    expect(by("grepstack.example")!.foundBy).toEqual(["log search"])
    // Three of forum's five rows come through uptime-alerts queries and two
    // through log-search ones, so the order is a count and not an arrival time.
    expect(by("forum.example")!.foundBy).toEqual(["uptime alerts", "log search"])
    // The same join, per family: tailwatch is a plain-family find first and a
    // branded one second, which is what tells a reader the bare category term
    // was doing the work rather than the company's name.
    expect(by("tailwatch.example")!.families).toEqual(["plain", "branded", "debranded"])
  })
})
