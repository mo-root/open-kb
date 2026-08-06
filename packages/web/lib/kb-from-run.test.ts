import { describe, it, expect } from "vitest"
import { graphOf, manifestOf, noteOf, viewOf } from "./kb-from-run"
import type { StoredRun } from "./runs"

/**
 * The map used to be a star: on one live run all 367 edges touched the anchor
 * and none joined two other companies. These cover the reading half of the fix,
 * where a linked entity becomes a node with real neighbours.
 */

function entity(domain: string, relation: string, kind = "company") {
  return { name: domain, domain, kind, what: `what ${domain} does`, relation, why: `why ${domain}` }
}

function run(entities: unknown[], edges: unknown[] = []): StoredRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    domain: "anchor.com",
    queries: 4,
    startedAt: 0,
    endedAt: 1,
    status: "complete",
    result: {
      anchor: "anchor.com",
      decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
      queries: [],
      entities,
      edges,
      stats: { queries: 4, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, serpCalls: 0, unlockerCalls: 0, usd: 0, seconds: 1 },
      report: {},
    } as never,
  }
}

/** Object-shaped fixture for tests that want to name `entities`/`edges`
 *  together rather than positionally. Built on `run()` above, the smallest
 *  existing `StoredRun` fixture in this file, so both stay one shape. */
function fixtureRun(overrides: {
  entities?: unknown[]
  edges?: unknown[]
  report?: Record<string, unknown>
}): StoredRun {
  const r = run(overrides.entities ?? [], overrides.edges ?? [])
  if (overrides.report) (r.result as { report: Record<string, unknown> }).report = overrides.report
  return r
}

describe("graphOf, entity-to-entity edges", () => {
  it("draws an edge between two entities, not only to the anchor", () => {
    const g = graphOf(run(
      [entity("a.com", "competitor"), entity("b.com", "competitor")],
      [{ from: "a.com", to: "b.com", relation: "competitor", why: "same shortlist", confidence: "inferred" }],
    ))
    const peer = g.edges.filter((e) => e.source !== "company.md" && e.target !== "company.md")
    expect(peer).toHaveLength(1)
    expect(peer[0]!.label).toBe("competitor")
  })

  /** A model naming a company the run never found is a dangling edge. v1 shipped
   *  sixteen of those before anyone noticed. */
  it("drops an edge whose end was never recorded", () => {
    const g = graphOf(run(
      [entity("a.com", "competitor")],
      [{ from: "a.com", to: "never-found.com", relation: "competitor", why: "x", confidence: "inferred" }],
    ))
    expect(g.edges.every((e) => e.source === "company.md" || e.target === "company.md")).toBe(true)
  })

  it("drops a self-edge", () => {
    const g = graphOf(run(
      [entity("a.com", "competitor")],
      [{ from: "a.com", to: "a.com", relation: "competitor", why: "x", confidence: "inferred" }],
    ))
    expect(g.edges.filter((e) => e.source === e.target)).toEqual([])
  })

  /** Two batches can report the same pair from opposite ends. */
  it("reports a pair once however many times it was written", () => {
    const g = graphOf(run(
      [entity("a.com", "competitor"), entity("b.com", "competitor")],
      [
        { from: "a.com", to: "b.com", relation: "competitor", why: "x", confidence: "inferred" },
        { from: "b.com", to: "a.com", relation: "competitor", why: "y", confidence: "measured" },
      ],
    ))
    const peer = g.edges.filter((e) => e.source !== "company.md" && e.target !== "company.md")
    expect(peer).toHaveLength(1)
  })

  it("matches ends case-insensitively and ignores a www prefix", () => {
    const g = graphOf(run(
      [entity("a.com", "competitor"), entity("b.com", "competitor")],
      [{ from: "WWW.A.com", to: "B.COM", relation: "substitute", why: "x", confidence: "inferred" }],
    ))
    expect(g.edges.some((e) => e.label === "substitute")).toBe(true)
  })

  /**
   * The reason `orphans` had to change meaning. It used to be "no relation to
   * the anchor", which after linking would report a gap that is not there.
   */
  it("does not call an entity unplaced when a peer edge holds it", () => {
    const g = graphOf(run(
      [entity("a.com", "competitor"), entity("lonely.com", "none")],
      [{ from: "a.com", to: "lonely.com", relation: "discusses", why: "x", confidence: "inferred" }],
    ))
    expect(g.orphans).toEqual([])
  })

  it("still reports an entity that nothing joins at all", () => {
    const g = graphOf(run([entity("a.com", "competitor"), entity("lonely.com", "none")], []))
    expect(g.orphans).toHaveLength(1)
    expect(g.orphans[0]).toContain("lonely.com")
  })

  it("survives a run written before linking existed", () => {
    const r = run([entity("a.com", "competitor")])
    delete (r.result as { edges?: unknown }).edges
    expect(() => graphOf(r)).not.toThrow()
    expect(graphOf(r).edges).toHaveLength(1)
  })
})

describe("graphOf, market clustering", () => {
  const cap = (name: string) => ({ name, does: `does ${name}`, centrality: "core", covers: [] })
  const withMarkets = (entities: unknown[], edges: unknown[] = []) => {
    const r = run(entities, edges)
    ;(r.result.decomposition as { capabilities?: unknown[] }).capabilities = [cap("proxy network"), cap("search api")]
    return r
  }

  /** The v1 shape, restored: search for the unlocker's job, find Apify, and
   *  Apify sits in the unlocker's cluster rather than on the anchor blob. */
  it("hangs an entity off the market whose queries surfaced it", () => {
    const g = graphOf(withMarkets([{ ...entity("apify.com", "competitor"), foundBy: ["proxy network"] }]))
    expect(g.nodes.some((n) => n.kind === "market" && n.title === "proxy network")).toBe(true)
    const e = g.edges.find((x) => x.target.includes("apify.com"))
    expect(e!.source).toBe("markets/proxy-network.md")
    expect(e!.label).toBe("competitor")
    // and the anchor sells into its markets
    expect(g.edges.some((x) => x.source === "company.md" && x.target === "markets/proxy-network.md" && x.label === "sells")).toBe(true)
  })

  it("falls back to the anchor when the planner invented the market mid-run", () => {
    const g = graphOf(withMarkets([{ ...entity("a.com", "competitor"), foundBy: ["captcha solvers"] }]))
    const e = g.edges.find((x) => x.target.includes("a.com"))
    expect(e!.source).toBe("company.md")
  })

  /** Declining to place something against the anchor does not un-happen the
   *  retrieval that surfaced it. */
  it("keeps a relation-none entity in its market as found, not as an orphan", () => {
    const g = graphOf(withMarkets([{ ...entity("lonely.com", "none"), foundBy: ["search api"] }]))
    const e = g.edges.find((x) => x.target.includes("lonely.com"))
    expect(e!.label).toBe("found")
    expect(g.orphans).toEqual([])
  })

  it("draws the old star for a run written before foundBy existed", () => {
    const g = graphOf(run([entity("a.com", "competitor")]))
    expect(g.nodes.filter((n) => n.kind === "market")).toEqual([])
    expect(g.edges.find((x) => x.target.includes("a.com"))!.source).toBe("company.md")
  })

  it("matches market names case-insensitively", () => {
    const g = graphOf(withMarkets([{ ...entity("b.com", "substitute"), foundBy: ["  Proxy Network "] }]))
    expect(g.edges.find((x) => x.target.includes("b.com"))!.source).toBe("markets/proxy-network.md")
  })
})

describe("validation kernel surfaces", () => {
  it("places unknown-kind entities under unplaced instead of dropping them", () => {
    const run = fixtureRun({
      entities: [{ name: "dead.com", domain: "dead.com", kind: "unknown", what: "", relation: "unknown", why: "", because: "its front page could not be read this run (blocked)" }],
    })
    const g = graphOf(run)
    expect(g.nodes.some((n) => n.id === "unplaced/dead.com.md")).toBe(true)
  })
  it("carries edge confidence through to GraphEdge", () => {
    // relation "none" on both ends, not "competitor": with a real relation
    // and no `foundBy`, `graphOf` also draws an anchor->entity edge labelled
    // "competitor" for each (see the placement loop above this one), and
    // `.find` would grab that undecorated edge before the peer edge this test
    // means to check. "none" keeps the only "competitor"-labelled edge the
    // one this test asserts on: the peer edge carrying `confidence`.
    const run = fixtureRun({
      entities: [
        { name: "a.com", domain: "a.com", kind: "company", what: "", relation: "none", why: "" },
        { name: "b.com", domain: "b.com", kind: "company", what: "", relation: "none", why: "" },
      ],
      edges: [{ from: "a.com", to: "b.com", relation: "competitor", why: "", confidence: "inferred" }],
    })
    const g = graphOf(run)
    const edge = g.edges.find((e) => e.label === "competitor")
    expect(edge?.confidence).toBe("inferred")
  })
  it("noteOf exposes the refusal reason", () => {
    const run = fixtureRun({
      entities: [{ name: "x.com", domain: "x.com", kind: "unknown", what: "", relation: "unknown", why: "", because: "nothing on its own site says it does this" }],
    })
    const note = noteOf(run, "unplaced/x.com.md")
    expect(note?.because).toContain("its own site")
  })
})

/**
 * The run JSONs carry riches the frontend never showed: the scorecard a swarm
 * run serialized at its ending (report.scorecard, T6), the evidence tier on
 * each swarm entity, and the kernel's grounding meter on sweep runs. These
 * cover the reading half — the fields must survive the run -> view translation
 * byte-intact, because the surfaces render them verbatim.
 */
describe("scorecard passthrough (swarm runs)", () => {
  /** Modeled field-for-field on runs/swarm-brightdata-com-202608060151.json —
   *  a live ending whose gate never had to speak. Values are that run's own;
   *  only the anchor inside the orientation dedupeKey is renamed to match
   *  this file's fixture anchor. */
  const liveScorecard = {
    families: [
      { lens: "orientation", dedupeKey: "orient:anchor.com", priority: 100, status: "landed", nodesAdded: 2, pageTierNodes: 2 },
      { lens: "market_mapping", dedupeKey: "competitors_proxies_scraping", priority: 90, status: "landed", nodesAdded: 7, pageTierNodes: 6 },
      { lens: "ecosystem_mapping", dedupeKey: "integrations_agents_mcp", priority: 85, status: "landed", nodesAdded: 2, pageTierNodes: 0 },
    ],
    familiesWithPageTier: { num: 2, den: 3, value: 0.6666666666666666 },
    pageTier: { num: 12, den: 12, value: 1 },
    singleSourced: { num: 12, den: 12, value: 1 },
    poolUnspent: { num: 3.1303555, den: 5, value: 0.6260711 },
    wall: { num: 235994, den: 600000, value: 0.39332333333333336 },
    yield: { window: 3, recent: 11, before: null },
    recall: { pooled: null, probes: [] },
    costPerNodeUsd: 0.11413704166666666,
    spentUsd: 1.3696445,
    gate: { refusals: 0, objections: [], carriedObjections: [], refusedFinish: null },
    config: { maxPoolUnspentFraction: 0.5, maxSingleSourcedFraction: 0.5, requirePageTierPerFamily: true },
  }

  it("carries the scorecard onto the view, fractions shipping their own arithmetic", () => {
    const v = viewOf(fixtureRun({ report: { scorecard: liveScorecard } }))
    expect(v.scorecard).toBeDefined()
    expect(v.scorecard!.familiesWithPageTier).toEqual({ num: 2, den: 3, value: 0.6666666666666666 })
    expect(v.scorecard!.poolUnspent.num).toBeCloseTo(3.1303555)
    expect(v.scorecard!.poolUnspent.den).toBe(5)
    expect(v.scorecard!.families).toHaveLength(3)
    expect(v.scorecard!.families[1]).toMatchObject({ lens: "market_mapping", status: "landed", nodesAdded: 7, pageTierNodes: 6 })
  })

  it("carries the zero gate record whole rather than as a hole", () => {
    const v = viewOf(fixtureRun({ report: { scorecard: liveScorecard } }))
    expect(v.scorecard!.gate).toEqual({ refusals: 0, objections: [], carriedObjections: [], refusedFinish: null })
  })

  it("carries a nonzero gate's exchange verbatim — the sentences were written to be read", () => {
    const objection = "2 of 3 planned families have zero page-tier nodes (competitors_x, integrations_y)"
    const carried = "the pool holds $3.55 of $5.00"
    const v = viewOf(
      fixtureRun({
        report: {
          scorecard: {
            ...liveScorecard,
            gate: {
              refusals: 1,
              objections: [objection, carried],
              carriedObjections: [carried],
              refusedFinish: { reason: "mapped", summary: "Map completed within budget and time", unresolved: [] },
            },
          },
        },
      }),
    )
    const gate = v.scorecard!.gate
    expect(gate.refusals).toBe(1)
    expect(gate.objections).toEqual([objection, carried])
    expect(gate.carriedObjections).toEqual([carried])
    expect(gate.refusedFinish).toMatchObject({ summary: "Map completed within budget and time" })
  })

  it("leaves scorecard undefined on a run that never wrote one", () => {
    expect(viewOf(fixtureRun({ report: {} })).scorecard).toBeUndefined()
  })

  it("refuses to invent a scorecard from a malformed one", () => {
    expect(viewOf(fixtureRun({ report: { scorecard: "yes" } })).scorecard).toBeUndefined()
    expect(viewOf(fixtureRun({ report: { scorecard: { families: [] } } })).scorecard).toBeUndefined()
  })
})

describe("evidence tier and grounding", () => {
  it("carries each entity's tier onto its NoteRef and NoteView", () => {
    const r = fixtureRun({
      entities: [
        { ...entity("a.com", "competitor"), tier: "own-page" },
        { ...entity("b.com", "competitor"), tier: "snippet" },
      ],
    })
    const byPath = new Map(viewOf(r).notes.map((n) => [n.path, n]))
    expect(byPath.get("players/a.com.md")?.tier).toBe("own-page")
    expect(byPath.get("players/b.com.md")?.tier).toBe("snippet")
    expect(noteOf(r, "players/a.com.md")?.tier).toBe("own-page")
  })

  it("leaves tier absent on a run recorded before tiers existed", () => {
    const r = fixtureRun({ entities: [entity("a.com", "competitor")] })
    expect(viewOf(r).notes.find((n) => n.path.includes("a.com"))?.tier).toBeUndefined()
    expect(noteOf(r, "players/a.com.md")?.tier).toBeUndefined()
  })

  it("carries descGrounded per entity, and only when it is a number", () => {
    const r = fixtureRun({
      entities: [
        { ...entity("a.com", "competitor"), descGrounded: 0.72 },
        { ...entity("b.com", "competitor"), descGrounded: "high" },
        entity("c.com", "competitor"),
      ],
    })
    const byPath = new Map(viewOf(r).notes.map((n) => [n.path, n]))
    expect(byPath.get("players/a.com.md")?.descGrounded).toBe(0.72)
    expect(byPath.get("players/b.com.md")?.descGrounded).toBeUndefined()
    expect(byPath.get("players/c.com.md")?.descGrounded).toBeUndefined()
    expect(noteOf(r, "players/a.com.md")?.descGrounded).toBe(0.72)
  })

  it("carries the merged-away accounts (also) onto NoteRef and NoteView", () => {
    const also = [
      { name: "Scrapy Cloud", what: "a hosted scrapy runner" },
      { what: "an account that lost only its wording, not a name" },
    ]
    const r = fixtureRun({ entities: [{ ...entity("zyte.com", "competitor"), also }] })
    expect(viewOf(r).notes.find((n) => n.path.includes("zyte.com"))?.also).toEqual(also)
    expect(noteOf(r, "players/zyte.com.md")?.also).toEqual(also)
  })

  it("leaves also absent when the row never merged, and drops malformed entries", () => {
    const r = fixtureRun({
      entities: [
        entity("a.com", "competitor"),
        { ...entity("b.com", "competitor"), also: [] },
        { ...entity("c.com", "competitor"), also: [{ name: "no what at all" }, "not an object"] },
        { ...entity("d.com", "competitor"), also: [{ name: 7, what: "kept, name was not a string" }] },
      ],
    })
    const byPath = new Map(viewOf(r).notes.map((n) => [n.path, n]))
    expect(byPath.get("players/a.com.md")?.also).toBeUndefined()
    expect(byPath.get("players/b.com.md")?.also).toBeUndefined()
    expect(byPath.get("players/c.com.md")?.also).toBeUndefined()
    expect(byPath.get("players/d.com.md")?.also).toEqual([{ what: "kept, name was not a string" }])
  })

  it("surfaces the kernel's groundingMean on the manifest", () => {
    const r = fixtureRun({ report: { kernel: { fetched: 10, groundingMean: 0.68 } } })
    expect(manifestOf(r).groundingMean).toBe(0.68)
  })

  it("leaves groundingMean off a manifest whose kernel never measured it", () => {
    expect(manifestOf(fixtureRun({ report: { kernel: { fetched: 10 } } })).groundingMean).toBeUndefined()
    expect(manifestOf(fixtureRun({ report: {} })).groundingMean).toBeUndefined()
    expect(manifestOf(fixtureRun({ report: { kernel: { groundingMean: null } } })).groundingMean).toBeUndefined()
  })
})
