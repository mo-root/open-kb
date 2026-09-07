import { describe, it, expect } from "vitest"
import {
  computeScorecard,
  scorecardSentences,
  scorecardObjections,
  fraction,
  SCORECARD_DEFAULTS,
  type ScorecardInput,
  type ScorecardConfig,
} from "../src/scorecard.js"

/**
 * Run 2's real numbers — runs/swarm-brightdata-com-202608052348.json, the run
 * whose ending ("Map completed within budget and time" at 8 nodes, $3.55 of
 * $5.00 unspent) the scorecard exists to put in front of the lead. Family
 * page-tier attribution is the fixture's own (the run predates T2's
 * contribution records): the orient dig read pages and carries the two
 * own-page entities; the three read missions landed one snippet-tier node
 * each (two ended `timeout`).
 */
const run2 = (): ScorecardInput => ({
  families: [
    { lens: "orientation", dedupeKey: "orient:brightdata.com", priority: 1, status: "landed", nodesAdded: 5, pageTierNodes: 2 },
    { lens: "competitor_analysis", dedupeKey: "enterprise_competitors", priority: 2, status: "landed", nodesAdded: 1, pageTierNodes: 0 },
    { lens: "competitor_analysis", dedupeKey: "midmarket_proxies", priority: 3, status: "landed", nodesAdded: 1, pageTierNodes: 0 },
    { lens: "market_segmentation", dedupeKey: "ai_scraping_niche", priority: 4, status: "landed", nodesAdded: 1, pageTierNodes: 0 },
  ],
  entities: [
    { tier: "own-page", sources: 2 }, // Oxylabs
    { tier: "own-page", sources: 2 }, // Zyte
    { tier: "snippet", sources: 1 }, // Decodo
    { tier: "snippet", sources: 1 }, // Apify
    { tier: "snippet", sources: 1 }, // SOAX
    { tier: "snippet", sources: 1 }, // Firecrawl
    { tier: "snippet", sources: 1 }, // ScrapingBee
    { tier: "snippet", sources: 1 }, // Jina AI (Reader)
  ],
  spendableUsd: 3.55,
  ceilingUsd: 5,
  spentUsd: 1.44278,
  elapsedMs: 288462,
  wallMs: 300000,
  yieldHistory: [5, 1, 1, 1],
  recall: {
    pooled: 0.2,
    probes: [
      {
        url: "https://use-apify.com/docs/apify-vs-the-world/apify-vs-firecrawl",
        vendors: [
          "googletagmanager.com",
          "clarity.ms",
          "google.com",
          "gstatic.com",
          "apify.com?fpr=use-apify",
          "firecrawl.link",
          "firecrawl.dev",
          "apify.com",
          "crawlee.dev",
          "github.com",
        ],
        found: ["firecrawl.dev", "apify.com"],
        recall: 0.2,
      },
    ],
  },
})

/** A run the gate has nothing to say about: every family landed page-tier
 *  evidence, most nodes corroborated, most of the pool spent. */
const healthy = (): ScorecardInput => ({
  families: [
    { lens: "orientation", dedupeKey: "orient:example.com", priority: 1, status: "landed", nodesAdded: 4, pageTierNodes: 3 },
    { lens: "competitor_analysis", dedupeKey: "rivals", priority: 2, status: "landed", nodesAdded: 4, pageTierNodes: 2 },
  ],
  entities: [
    { tier: "own-page", sources: 2 },
    { tier: "own-page", sources: 3 },
    { tier: "page", sources: 2 },
    { tier: "page", sources: 2 },
    { tier: "page", sources: 2 },
    { tier: "page", sources: 2 },
    { tier: "snippet", sources: 1 },
    { tier: "snippet", sources: 1 },
  ],
  spendableUsd: 0.8,
  ceilingUsd: 5,
  spentUsd: 3.7,
  elapsedMs: 150000,
  wallMs: 300000,
  yieldHistory: [4, 4],
  recall: { pooled: 0.6, probes: [] },
})

describe("fraction", () => {
  it("computes value as num/den", () => {
    expect(fraction(2, 8)).toEqual({ num: 2, den: 8, value: 0.25 })
  })

  it("a denominator of 0 answers null, never NaN — recall's honesty rule", () => {
    const f = fraction(0, 0)
    expect(f.value).toBeNull()
    expect(f).toEqual({ num: 0, den: 0, value: null })
  })
})

describe("computeScorecard over run 2's real numbers", () => {
  const sc = computeScorecard(run2())

  it("counts families with page-or-better contributions: 1 of 4", () => {
    expect(sc.familiesWithPageTier).toEqual({ num: 1, den: 4, value: 0.25 })
  })

  it("counts page-tier nodes: 2 of 8", () => {
    expect(sc.pageTier).toEqual({ num: 2, den: 8, value: 0.25 })
  })

  it("counts single-sourced nodes: 6 of 8", () => {
    expect(sc.singleSourced).toEqual({ num: 6, den: 8, value: 0.75 })
  })

  it("poolUnspent is spendable over the caller-set ceiling, never a design constant", () => {
    expect(sc.poolUnspent).toEqual({ num: 3.55, den: 5, value: 0.71 })
  })

  it("wall is elapsed over the wall budget, in ms", () => {
    expect(sc.wall.num).toBe(288462)
    expect(sc.wall.den).toBe(300000)
    expect(sc.wall.value).toBeCloseTo(0.96154, 4)
  })

  it("yield: four landings is under one full window, so before is null", () => {
    expect(sc.yield).toEqual({ window: 4, recent: 8, before: null })
  })

  it("recall passes through untouched — computed once, upstream", () => {
    expect(sc.recall).toEqual(run2().recall)
  })

  it("costPerNodeUsd is this run's own spent over kept, not config", () => {
    expect(sc.costPerNodeUsd).toBeCloseTo(1.44278 / 8)
  })

  it("carries the family rows for the sentence renderer", () => {
    expect(sc.families.map((f) => f.dedupeKey)).toEqual([
      "orient:brightdata.com",
      "enterprise_competitors",
      "midmarket_proxies",
      "ai_scraping_niche",
    ])
  })
})

describe("computeScorecard edges", () => {
  it("an empty map yields null-valued fractions and a null cost per node", () => {
    const sc = computeScorecard({
      families: [],
      entities: [],
      spendableUsd: 0,
      ceilingUsd: 0,
      spentUsd: 0,
      elapsedMs: 0,
      wallMs: 0,
      yieldHistory: [],
      recall: { pooled: null, probes: [] },
    })
    expect(sc.familiesWithPageTier.value).toBeNull()
    expect(sc.pageTier.value).toBeNull()
    expect(sc.singleSourced.value).toBeNull()
    expect(sc.poolUnspent.value).toBeNull()
    expect(sc.wall.value).toBeNull()
    expect(sc.costPerNodeUsd).toBeNull()
    expect(sc.yield).toEqual({ window: 0, recent: 0, before: null })
  })

  it("yield with two full windows compares them: the design's curve sentence", () => {
    const sc = computeScorecard({
      ...healthy(),
      yieldHistory: [3, 3, 2, 2, 2, 2, 1, 1, 0, 0, 0, 0],
    })
    expect(sc.yield).toEqual({ window: 6, recent: 2, before: 14 })
  })

  it("yield never compares a full window against a partial one", () => {
    // Nine landings: six recent, three left over — before stays null rather
    // than grading six landings against three.
    const sc = computeScorecard({ ...healthy(), yieldHistory: [9, 9, 9, 1, 1, 1, 1, 1, 1] })
    expect(sc.yield).toEqual({ window: 6, recent: 6, before: null })
  })

  it("a single landing is a window of 1, and before stays null — a second window needs 2 landings, not 1", () => {
    const sc = computeScorecard({ ...healthy(), yieldHistory: [3] })
    expect(sc.yield).toEqual({ window: 1, recent: 3, before: null })
  })

  it("a page-tier node counts whether its evidence is own-page or page", () => {
    const sc = computeScorecard({
      ...healthy(),
      entities: [
        { tier: "own-page", sources: 2 },
        { tier: "page", sources: 2 },
        { tier: "snippet", sources: 2 },
      ],
    })
    expect(sc.pageTier).toEqual({ num: 2, den: 3, value: 2 / 3 })
  })
})

describe("scorecardSentences: facts a reader can disagree with", () => {
  it("renders run 2's block byte-for-byte", () => {
    expect(scorecardSentences(computeScorecard(run2()))).toEqual([
      "3 of 4 planned families have zero page-tier nodes (enterprise_competitors, midmarket_proxies, ai_scraping_niche)",
      "2 of 8 nodes carry page-tier evidence",
      "6 of 8 nodes rest on a single source",
      "the pool holds $3.55 of $5.00",
      "288s of the 300s wall elapsed",
      "the last 4 landings added 8 nodes",
      "recall across 1 answer-key probe: 0.20",
      "the run has paid $1.44 for 8 nodes ($0.18 per node)",
    ])
  })

  it("never exceeds eight lines", () => {
    expect(scorecardSentences(computeScorecard(run2())).length).toBeLessThanOrEqual(8)
    expect(scorecardSentences(computeScorecard(healthy())).length).toBeLessThanOrEqual(8)
  })

  it("renders the two-window yield curve the design shows the lead", () => {
    const sc = computeScorecard({ ...healthy(), yieldHistory: [3, 3, 2, 2, 2, 2, 1, 1, 0, 0, 0, 0] })
    expect(scorecardSentences(sc)).toContain("the last 6 landings added 2 nodes; the 6 before added 14")
  })

  it("a window of 1 speaks of 'the last landing', singular, not 'the last 1 landings'", () => {
    const plural = computeScorecard({ ...healthy(), yieldHistory: [3] })
    expect(scorecardSentences(plural)).toContain("the last landing added 3 nodes")
    const singular = computeScorecard({ ...healthy(), yieldHistory: [1] })
    expect(scorecardSentences(singular)).toContain("the last landing added 1 node")
  })

  it("a plural window still says 'node', singular, when only one landed", () => {
    // yieldSentence's window!==1 branch has its own recent===1 ? "node" :
    // "nodes" ternary, separate from the window===1 branch's copy above.
    // Every other test with a plural window (run 2 at 8, the two-window
    // curve at 2) also lands a plural recent count, so this arm had never
    // run: dropping the ternary for a bare "nodes" still passed every test
    // in this file but the one added here.
    const sc = computeScorecard({ ...healthy(), yieldHistory: [0, 1] })
    expect(scorecardSentences(sc)).toContain("the last 2 landings added 1 node")
  })

  it("speaks sensibly about a run that never grew a map — the seed-only shape", () => {
    const sc = computeScorecard({
      families: [{ lens: "orientation", dedupeKey: "orient:example.com", priority: 1, status: "queued", nodesAdded: 0, pageTierNodes: 0 }],
      entities: [],
      spendableUsd: 4.5,
      ceilingUsd: 5,
      spentUsd: 0.02,
      elapsedMs: 12000,
      wallMs: 300000,
      yieldHistory: [],
      recall: { pooled: null, probes: [] },
    })
    expect(scorecardSentences(sc)).toEqual([
      "1 of 1 planned family has zero page-tier nodes (orient:example.com)",
      "the map holds no nodes",
      "the pool holds $4.50 of $5.00",
      "12s of the 300s wall elapsed",
      "no missions have landed",
      "no fetched page qualified as an answer key",
    ])
  })

  it("agrees its verbs with its counts", () => {
    const sc = computeScorecard({
      ...healthy(),
      entities: [
        { tier: "page", sources: 1 },
        { tier: "snippet", sources: 2 },
      ],
    })
    const lines = scorecardSentences(sc)
    expect(lines).toContain("1 of 2 nodes carries page-tier evidence")
    expect(lines).toContain("1 of 2 nodes rests on a single source")
  })

  it("a single kept node says 'node', not 'nodes' — pageTier, singleSourced, and cost-per-node share that denominator", () => {
    // entities.length is the den for both fractions and the "kept" count in
    // the cost sentence, so every test above that exercises den===1 uses the
    // seed-only (zero-node) shape instead, which takes the "the map holds no
    // nodes" branch and never reaches these three ternaries at all. A run
    // that actually kept exactly one node had never run.
    const sc = computeScorecard({ ...healthy(), entities: [{ tier: "own-page", sources: 1 }], spentUsd: 0.5 })
    const lines = scorecardSentences(sc)
    expect(lines).toContain("1 of 1 node carries page-tier evidence")
    expect(lines).toContain("1 of 1 node rests on a single source")
    expect(lines).toContain("the run has paid $0.50 for 1 node ($0.50 per node)")
  })

  it("no family is empty: no parenthetical, 'have' not 'has' — the ternary guard's true branch", () => {
    // Every test above that asserts the full families line (run 2, the
    // seed-only run) has at least one empty family, so `empty.length ?
    // ... : ""` had only ever taken its truthy arm. Dropping the guard
    // (`` `(${empty.map(...).join(", ")})` `` unconditionally) still
    // passes every other test in this file, because `[].join(", ")` is
    // "" — it only surfaces as a stray "()" here, on a run where nothing
    // is empty.
    const sc = computeScorecard(healthy())
    expect(scorecardSentences(sc)[0]).toBe("0 of 2 planned families have zero page-tier nodes")
  })

  it("uses no judgement vocabulary — the boundary is facts, never verdicts", () => {
    const forbidden = [
      "insufficient",
      "too early",
      "should",
      "must",
      "ought",
      "premature",
      "recommend",
      "consider",
      "warning",
      "problem",
      "concern",
      "poor",
      "weak",
      "good",
      "bad",
      "better",
      "worse",
      "fail",
      "failure",
      "healthy",
      "unhealthy",
      "enough",
      "need",
    ]
    const inputs = [run2(), healthy()]
    inputs.push({ ...run2(), entities: [], families: [], yieldHistory: [], recall: { pooled: null, probes: [] } })
    for (const input of inputs) {
      for (const line of scorecardSentences(computeScorecard(input))) {
        for (const word of forbidden) {
          expect(line).not.toMatch(new RegExp(`\\b${word.replace(" ", "\\s+")}\\b`, "i"))
        }
      }
    }
  })
})

describe("scorecardObjections: the armed subset", () => {
  it("run 2 under measured defaults arms three objections, byte-for-byte", () => {
    expect(scorecardObjections(computeScorecard(run2()), SCORECARD_DEFAULTS)).toEqual([
      "3 of 4 planned families have zero page-tier nodes (enterprise_competitors, midmarket_proxies, ai_scraping_niche)",
      "6 of 8 nodes rest on a single source",
      "the pool holds $3.55 of $5.00",
    ])
  })

  it("every objection is one of the sentences — a subset, not a second voice", () => {
    for (const input of [run2(), healthy()]) {
      const sc = computeScorecard(input)
      const sentences = scorecardSentences(sc)
      for (const objection of scorecardObjections(sc, SCORECARD_DEFAULTS)) {
        expect(sentences).toContain(objection)
      }
    }
  })

  it("a healthy run passes in silence", () => {
    expect(scorecardObjections(computeScorecard(healthy()), SCORECARD_DEFAULTS)).toEqual([])
  })

  it("a config of all nulls silences every objection — the design's escape hatch", () => {
    const silent: ScorecardConfig = {
      maxPoolUnspentFraction: null,
      maxSingleSourcedFraction: null,
      requirePageTierPerFamily: null,
    }
    expect(scorecardObjections(computeScorecard(run2()), silent)).toEqual([])
  })

  it("a value at its threshold stays quiet: max means the last tolerated number", () => {
    const sc = computeScorecard({
      ...healthy(),
      entities: [
        { tier: "page", sources: 1 },
        { tier: "page", sources: 1 },
        { tier: "page", sources: 2 },
        { tier: "page", sources: 2 },
      ],
      spendableUsd: 2.5,
      ceilingUsd: 5,
    })
    expect(sc.singleSourced.value).toBe(0.5)
    expect(sc.poolUnspent.value).toBe(0.5)
    expect(scorecardObjections(sc, SCORECARD_DEFAULTS)).toEqual([])
  })

  it("a fraction with denominator 0 never arms, whatever the config demands", () => {
    const sc = computeScorecard({
      families: [],
      entities: [],
      spendableUsd: 1,
      ceilingUsd: 0,
      spentUsd: 0,
      elapsedMs: 0,
      wallMs: 0,
      yieldHistory: [],
      recall: { pooled: null, probes: [] },
    })
    const strictest: ScorecardConfig = {
      maxPoolUnspentFraction: 0,
      maxSingleSourcedFraction: 0,
      requirePageTierPerFamily: true,
    }
    expect(sc.poolUnspent.value).toBeNull()
    expect(scorecardObjections(sc, strictest)).toEqual([])
  })
})

describe("SCORECARD_DEFAULTS", () => {
  it("ships the measured thresholds", () => {
    expect(SCORECARD_DEFAULTS).toEqual({
      maxPoolUnspentFraction: 0.5,
      maxSingleSourcedFraction: 0.5,
      requirePageTierPerFamily: true,
    })
  })
})
