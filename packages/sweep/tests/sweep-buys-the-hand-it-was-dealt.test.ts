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
    // `uptime alerts` the adjacent one, so the core product's OPENING comes
    // first — but only its opening. Core's whole hand used to come first, and
    // on shopify.com that put thirteen products' first door past index 262 in
    // a plan that only ever fired 147 queries.
    const planned = h.result.queries.map((q) => q.q)
    expect(planned).toEqual([
      // The core product's two front doors and their comparison fields.
      "log search",
      "log search alternatives",
      "log management",
      "log management alternatives",
      // Then the adjacent market's opening, ahead of anything second-tier.
      "uptime monitoring",
      "uptime monitoring alternatives",
      "who gets paged when an endpoint stops answering",
      // Only now the tails: branded, then the rest of the debranded questions.
      "Log Search Cloud alternatives",
      "how do i find one request across a hundred containers",
      "keeping a year of logs without paying per seat",
      "synthetic checks from more than one region",
      ...co.map((f) => f.q),
    ])

    // The property the literal above is an instance of, stated so a future
    // fixture change cannot quietly lose it: the adjacent market's first door
    // is bought before the core product's second-tier queries.
    const firstAdjacentDoor = planned.indexOf(upHand.open[0]!.q)
    const coreDebranded = planned.indexOf("how do i find one request across a hundred containers")
    expect(firstAdjacentDoor).toBeLessThan(coreDebranded)

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

/**
 * DID THE PLAN REACH THE WIRE?
 *
 * A plan and a purchase are different things, and this repo confused them
 * three times in one night: a fourth strip term written into `report.strips`
 * and searched on none of fifty products, a reserve the widening loop never
 * draws from, a 258-query plan sealed at 100. Each time the mechanism was
 * verified and the wire was not, and each time it took a hand-written script
 * over `searched[]` to find out. `report.wire` is that script, kept.
 */
describe("report.wire — the plan against the purchase", () => {
  it("counts the products and strip terms that actually reached the wire", async () => {
    const h = await runFixture()
    const w = h.result.report.wire as {
      products: number; productsSearched: number; termsWritten: number; termsFired: number
    }
    // The fixture fires its whole hand, so the plan and the purchase agree.
    expect(w.products).toBeGreaterThan(0)
    expect(w.productsSearched).toBe(w.products)
    expect(w.termsFired).toBeGreaterThan(0)
    expect(w.termsFired).toBeLessThanOrEqual(w.termsWritten)
  }, 30_000)

  it("shows a term written and never fired, which is the failure it exists to catch", async () => {
    // A hand cut by the clock is the honest way to produce one now. Every
    // strip term opens with the hand since the reserve stopped being where
    // doors go to be forgotten, so a term goes unfired when the budget ends
    // before its pass — which is exactly the case `wire` has to make visible,
    // and exactly what a large decomposition does on a real run.
    const h = await runFixture({
      sweepOptions: { maxQueries: 3 },
      script: {
        catalog: (product: string) => ({
          terms: [`${product} term one`, `${product} term two`, `${product} term three`],
          generic: true,
          queries: [],
        }),
      },
    })
    const w = h.result.report.wire as {
      termsWritten: number; termsFired: number
      products: number; productsSearched: number; productsUnsearched: string[]
    }
    expect(w.termsWritten).toBeGreaterThan(w.termsFired)
    // And the terms that DID fire are real, so this is not simply an empty run.
    expect(w.termsFired).toBeGreaterThan(0)

    // NAMES, not just a count. The count sent me to a hand-written script the
    // first time it was non-zero; the names are what identified the missed
    // products as every non-core one, which is what found the band bug.
    expect(w.productsUnsearched.length).toBe(w.products - w.productsSearched)
    // The NAME, not just the arity — an assertion on length and type would
    // pass over an empty list and prove nothing. With three queries to spend
    // the fixture buys the core market's product and misses the adjacent
    // one, which is the same shape the band bug had on shopify: the products
    // that fall off are the non-core ones.
    expect(w.productsUnsearched).toEqual(["Uptime Alerts"])
    // And it really is absent from the wire it is said to have missed.
    for (const name of w.productsUnsearched)
      expect(h.asked.some((q) => q.includes(name))).toBe(false)
  }, 30_000)

  /**
   * THE JOIN IS BY TERM, NOT BY LABEL — and reading it the other way gives a
   * different, wrong answer.
   *
   * Two products can strip to the same term. The plan dedupes them to one
   * query, and that query carries ONE product label, so a join over
   * `searched[].product` reports the other product as never searched. The
   * join `report.wire` actually uses asks whether the product's TERMS reached
   * the wire, which credits both.
   *
   * MEASURED on shopify-com-20260824020850: the label join says 8 products
   * were never searched, the term join says 2, and the 6 in between are real
   * — `Online store`, `Shop app`, `Hydrogen`, `Checkout Kit`, `Shopify
   * developer platform` and `Shopify AI Toolkit` all strip to terms
   * (`headless commerce`, `commerce API`, `ecommerce platform`) that fired
   * under another product's name. The term join is the correct one: the
   * market WAS searched and its hosts ARE on the map, which is what the field
   * exists to tell you. I read it the label way first and had to be corrected
   * by the data, so this pins it.
   */
  it("credits a product whose every term another product also wrote", async () => {
    const h = await runFixture({
      script: {
        catalog: (product: string) =>
          product === "Uptime Alerts"
            ? { terms: ["log search"], generic: true, queries: [] }
            : { terms: ["log search", "retention window"], generic: true, queries: [] },
      },
    })
    const w = h.result.report.wire as {
      products: number; productsSearched: number; productsUnsearched: string[]
    }

    // Uptime Alerts was planned, and stripped to a term Log Search Cloud
    // also wrote.
    const strips = h.result.report.strips as { product: string; terms: string[] }[]
    expect(strips.map((st) => st.product)).toContain("Uptime Alerts")
    expect(strips.find((st) => st.product === "Uptime Alerts")!.terms).toEqual(["log search"])

    // THE WIRE CARRIES NO QUERY OF ITS OWN. The shared term deduped to a
    // single row, and that row is labelled with the other product — so the
    // label join would call this product unsearched.
    const rows = h.result.queries as { q: string; product?: string }[]
    expect(rows.filter((r) => r.q === "log search")).toHaveLength(1)
    expect(rows.some((r) => r.product === "Uptime Alerts")).toBe(false)

    // And the field credits it anyway, because its term was bought.
    expect(w.products).toBe(2)
    expect(w.productsSearched).toBe(2)
    expect(w.productsUnsearched).toEqual([])
  }, 30_000)
})

/**
 * THE READING IS NOT REPRODUCIBLE, AND EVERYTHING DESCENDS FROM IT.
 *
 * Measured on shopify.com with an identical 28,634-character prompt,
 * temperature 0, and the same upstream host answering all three asks: 14
 * products, then 1, then 19. The middle ask collapsed a company with fifty
 * products to a single one, which would have dealt a one-product opening
 * hand. `temperature: 0` and a pinned host fixed the classifier, which asks a
 * small question about one page; they do not fix a 28k prompt answered with a
 * large structured object.
 *
 * So it is read three times and the MEDIAN product count is kept — the middle
 * rather than the richest, because both tails are failures.
 */
describe("report.serp.dispatch — did the pool ever fill", () => {
  it("records the peak and mean width against the configured one", async () => {
    /**
     * The search phase moves 0.27 queries a second on a 32-wide pool whose
     * queries have a 4.6s median. Two different faults look identical from
     * outside — a dispatch that never gets wide, or a wire that is wide and
     * slow — and no other field can separate them. `pacedMs` ruled out our own
     * rate limiter; this rules on the pool itself.
     */
    const h = await runFixture({ sweepOptions: { concurrency: 4 } })
    const d = (h.result.report.serp as { dispatch: { width: number; peak: number; mean: number } }).dispatch
    expect(d.width).toBe(4)
    // A real count, not a restatement of the setting: it cannot exceed the
    // width, and with queries to spend it must have gone above one.
    expect(d.peak).toBeGreaterThan(1)
    expect(d.peak).toBeLessThanOrEqual(4)
    expect(d.mean).toBeGreaterThan(0)
    expect(d.mean).toBeLessThanOrEqual(d.peak)
  }, 30_000)

  it("reports a peak BELOW the width when there is not enough work to fill it", async () => {
    // The case that proves the counter counts rather than echoing
    // `concurrency` back. Eight workers and three queries can never put more
    // than three in flight, so `peak === width` here would mean the field is
    // a restatement of the setting.
    //
    // Written after a mutation test caught exactly that: with the pool full,
    // `peak: CONC` passes every assertion, because peak legitimately equals
    // the width. Only starving it separates the two.
    const h = await runFixture({ sweepOptions: { concurrency: 8, maxQueries: 3 } })
    const d = (h.result.report.serp as { dispatch: { width: number; peak: number } }).dispatch
    expect(d.width).toBe(8)
    expect(d.peak).toBeLessThanOrEqual(3)
    expect(d.peak).toBeGreaterThan(0)
  }, 30_000)
})

describe("report.serp.paced — whose ceiling was it", () => {
  it("is absent from the count when nothing waited", async () => {
    const h = await runFixture()
    const paced = (h.result.report.serp as { paced?: { ms: number; queries: number } }).paced
    // Zero, not missing: "nothing waited" and "this port cannot say" have to
    // read differently, because a slow search with paced.queries at 0 means
    // the ceiling is upstream and one with it high means it is ours.
    expect(paced).toEqual({ ms: 0, queries: 0 })
  })

  it("sums the wait and counts the queries that paid it", async () => {
    const h = await runFixture({ pacedMs: 250 })
    const paced = (h.result.report.serp as { paced: { ms: number; queries: number } }).paced
    const fired = h.result.report.queries as number
    expect(fired).toBeGreaterThan(0)
    expect(paced.queries).toBe(fired)
    expect(paced.ms).toBe(fired * 250)
  })
})

describe("report.clock — what the model predicted against what it cost", () => {
  it("prices the queries the run FIRED, not the ones it planned", async () => {
    /**
     * `queriesThatFit` sizes every deadline-bound run — the web route turns
     * 270 seconds into 18 queries with it — and nothing checked the model
     * against a finished run. Measured by hand it is 1.5-2x conservative;
     * this makes the check automatic.
     *
     * Fired, not planned, because the host ceiling seals the search early on a
     * large anchor: shopify planned 373 queries and bought 147, and pricing
     * the plan would compare the clock against work never done.
     */
    const h = await runFixture()
    const c = h.result.report.clock as { predictedSeconds: number; actualSeconds: number; queries: number }
    expect(c.queries).toBe(h.result.report.queries)
    expect(c.queries).toBeLessThanOrEqual((h.result.report.queued as number) ?? Infinity)
    // A prediction, not an echo of the clock: the fixture runs in about a
    // second and the model still charges fixed and tail seconds for it.
    expect(c.predictedSeconds).toBeGreaterThan(c.actualSeconds)
    expect(c.actualSeconds).toBeGreaterThanOrEqual(0)
  }, 30_000)
})

describe("report.phases — where the minutes went", () => {
  it("carries a span for every rail that spoke", async () => {
    // `report.seconds` is the total and `cost.byKind[].ms` is BILLED time, so
    // neither answers "which phase was slow". Without this the only way to
    // find out was to diff timestamps in a terminal log — and doing it from
    // memory instead blamed the second look for eleven minutes it did not
    // spend (73 seconds; `understand` spent 362).
    const h = await runFixture()
    const phases = h.result.report.phases as Record<
      string,
      { firstSec: number; lastSec: number; spanSec: number; lines: number }
    >
    // The rail names are a closed set and the pipeline walks all of them.
    expect(Object.keys(phases).sort()).toEqual(["link", "plan", "rank", "sweep", "understand", "write"])
    for (const [rail, c] of Object.entries(phases)) {
      expect(c.spanSec, rail).toBeGreaterThanOrEqual(0)
    }
    // `lines` has to be COUNTED, and "greater than zero" does not check that —
    // the initialiser is 1, so deleting the increment passes it. Caught by a
    // mutation test that removed `c.lines += 1` and broke nothing.
    //
    // `write` narrates exactly once, at the end; `understand` narrates
    // repeatedly. A counter that never increments makes them equal.
    expect(phases.write!.lines).toBe(1)
    expect(phases.understand!.lines).toBeGreaterThan(1)
    // Ordered as the pipeline runs them, which is what makes the spans
    // readable as phases at all.
    expect(phases.understand!.firstSec).toBeLessThanOrEqual(phases.write!.firstSec)
  }, 30_000)
})

describe("reading the company more than once", () => {
  const decomp = (n: number) => ({
    sells: "hosted log search for small platform teams",
    buyer: "a platform team of five to fifty engineers",
    brand: "Pellucid",
    products: Array.from({ length: n }, (_, i) => ({
      name: `Product ${i + 1}`, does: `does thing ${i + 1}`, foundAt: "",
    })),
    capabilities: [
      { name: "log search", does: "answers a question about production", covers: ["Product 1"], centrality: "core" },
    ],
    coinages: [],
  })

  it("keeps the middle answer, not the collapsed one and not the richest", async () => {
    // The measured shape: one ask collapses, one is rich, one is in between.
    const sizes = [1, 9, 4]
    let ask = 0
    const h = await runFixture({ script: { understand: () => decomp(sizes[ask++ % sizes.length]!) } })
    // Three asks, and the run kept the one with four products.
    expect(h.calls.filter((c) => c.phase === "understand")).toHaveLength(3)
    expect(h.result.decomposition.products).toHaveLength(4)
    // And it says so, because a spread this wide is a fact about the run.
    expect(h.says.some((s) => /read it 3 times/.test(s))).toBe(true)
  }, 30_000)

  it("leans away from the collapse when an ask fails and there is no true middle", async () => {
    // Two answers left, so `Math.floor(n / 2)` picks the upper. That is
    // deliberate: a reading that collapses maps almost nothing and cannot be
    // recovered downstream, while an inflated one is only expensive. Measured
    // on three simulated runs, an ask failed on two of them, so this is the
    // common case rather than a corner.
    let ask = 0
    const h = await runFixture({
      script: {
        understand: () => {
          ask += 1
          if (ask === 1) return { nonsense: true } // refused, then refused again
          return decomp(ask === 2 ? 3 : 8)
        },
      },
    })
    expect(h.result.decomposition.products).toHaveLength(8)
  }, 30_000)

  it("does not buy a second timeout — the other asks answer for the slow one", async () => {
    /**
     * A schema miss is worth retrying: it fails in seconds. A timeout costs
     * the FULL ceiling again on the route that just proved too slow, and
     * understand's ceiling is 180 seconds. Measured on cloudflare.com, the
     * phase said "no answer in 180s, retrying once" at 182s and finished at
     * 362s — six minutes of a thirty-minute run, spent on one ask while the
     * other two sat already answered behind `Promise.all`.
     */
    let ask = 0
    const h = await runFixture({
      script: {
        understand: () => {
          if (++ask === 1) {
            const e = new Error("aborted due to timeout")
            e.name = "TimeoutError"
            throw e
          }
          return decomp(5)
        },
      },
    })
    // Three asks, one of them lost. A retry of the timeout would make four.
    expect(h.calls.filter((c) => c.phase === "understand")).toHaveLength(3)
    expect(h.result.decomposition.products).toHaveLength(5)
  }, 30_000)

  it("survives an ask that fails outright — the others answer for it", async () => {
    let ask = 0
    const h = await runFixture({
      script: {
        understand: () => {
          // One refusal of three. `call()` retries it once and it refuses
          // again, so this ask is lost entirely.
          if (++ask === 2) return { nonsense: true }
          return decomp(6)
        },
      },
    })
    expect(h.result.decomposition.products).toHaveLength(6)
    expect(h.result.report.kept).toBeGreaterThan(0)
  }, 30_000)
})
