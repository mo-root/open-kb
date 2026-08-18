import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { graphOf, manifestOf, noteOf, summaryOf, viewOf } from "./kb-from-run"
import type { CompletedRun } from "./runs"

/**
 * The map used to be a star: on one live run all 367 edges touched the anchor
 * and none joined two other companies. These cover the reading half of the fix,
 * where a linked entity becomes a node with real neighbours.
 */

function entity(domain: string, relation: string, kind = "company") {
  return { name: domain, domain, kind, what: `what ${domain} does`, relation, why: `why ${domain}` }
}

function run(entities: unknown[], edges: unknown[] = []): CompletedRun {
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
 *  existing `CompletedRun` fixture in this file, so both stay one shape. */
function fixtureRun(overrides: {
  entities?: unknown[]
  edges?: unknown[]
  report?: Record<string, unknown>
}): CompletedRun {
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
    // liveScorecard is a run stored BEFORE the gate counted work, and the
    // reader must not invent the four fields it never had: null / 0 / [] / ""
    // all mean "not recorded" here, which is a different claim from "the lead
    // answered in words" and renders differently.
    const v = viewOf(fixtureRun({ report: { scorecard: liveScorecard } }))
    expect(v.scorecard!.gate).toEqual({
      refusals: 0,
      objections: [],
      carriedObjections: [],
      refusedFinish: null,
      workAtRefusal: null,
      workAnswered: 0,
      answeredBy: [],
      stood: "",
    })
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
              refusals: 2,
              objections: [objection, carried],
              carriedObjections: [carried],
              refusedFinish: { reason: "mapped", summary: "Map completed within budget and time", unresolved: [] },
              workAtRefusal: 4,
              workAnswered: 0,
              answeredBy: [],
              stood: "refusals-spent",
            },
          },
        },
      }),
    )
    const gate = v.scorecard!.gate
    expect(gate.refusals).toBe(2)
    expect(gate.objections).toEqual([objection, carried])
    expect(gate.carriedObjections).toEqual([carried])
    expect(gate.refusedFinish).toMatchObject({ summary: "Map completed within budget and time" })
    // The price and the answer travel too: asked twice, paid nothing, ended on
    // the ceiling rather than on work.
    expect(gate.workAtRefusal).toBe(4)
    expect(gate.workAnswered).toBe(0)
    expect(gate.answeredBy).toEqual([])
    expect(gate.stood).toBe("refusals-spent")
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

/**
 * The two receipts an entity has always carried and nothing ever read: `roads`,
 * the literal queries that returned this host, and `spans`, the quotes the
 * kernel checked in code as substrings of the page the model read.
 *
 * Both are optional in the strong sense. Every map in the committed gallery
 * predates `roads`, and a host whose front page could not be read carries no
 * spans on any run — so the reader has to degrade to nothing, the way
 * `families` does, rather than to an empty box a surface would draw a heading
 * over.
 */
describe("roads and spans, an entity's own receipts", () => {
  const roads = ["transactional email api for developers", "postmark alternative"]

  it("carries the surfacing queries onto NoteRef and NoteView", () => {
    const r = fixtureRun({ entities: [{ ...entity("a.com", "competitor"), roads }] })
    expect(viewOf(r).notes.find((n) => n.path.includes("a.com"))?.roads).toEqual(roads)
    expect(noteOf(r, "players/a.com.md")?.roads).toEqual(roads)
  })

  it("leaves roads absent on a run recorded before the sweep stored them", () => {
    const r = fixtureRun({ entities: [entity("a.com", "competitor")] })
    expect(viewOf(r).notes.find((n) => n.path.includes("a.com"))?.roads).toBeUndefined()
    expect(noteOf(r, "players/a.com.md")?.roads).toBeUndefined()
  })

  it("reads an empty or malformed roads list as no roads at all", () => {
    const r = fixtureRun({
      entities: [
        { ...entity("a.com", "competitor"), roads: [] },
        { ...entity("b.com", "competitor"), roads: "one query, unlisted" },
        { ...entity("c.com", "competitor"), roads: ["   ", 7, "kept"] },
      ],
    })
    const byPath = new Map(viewOf(r).notes.map((n) => [n.path, n]))
    expect(byPath.get("players/a.com.md")?.roads).toBeUndefined()
    expect(byPath.get("players/b.com.md")?.roads).toBeUndefined()
    expect(byPath.get("players/c.com.md")?.roads).toEqual(["kept"])
  })

  it("carries the verified quotes onto the whole entity", () => {
    const spans = ["Send transactional emails", "Deliverability you can measure"]
    const r = fixtureRun({ entities: [{ ...entity("a.com", "competitor"), spans }] })
    expect(noteOf(r, "players/a.com.md")?.spans).toEqual(spans)
  })

  /** The panel is the only surface that renders them, and a `NoteRef` rides in
   *  every list on this map. Sending three sentences per row to lists that draw
   *  none of them is the shape of the defect this change is fixing, one field
   *  over. */
  it("keeps spans off the list ref", () => {
    const r = fixtureRun({ entities: [{ ...entity("a.com", "competitor"), spans: ["a quote"] }] })
    const ref = viewOf(r).notes.find((n) => n.path.includes("a.com"))
    expect((ref as { spans?: unknown }).spans).toBeUndefined()
  })

  /** A span is a literal substring of the page the kernel read. Trimming it
   *  here would quietly break the one property that makes it a receipt, so the
   *  blank test decides whether an entry survives and never what it says. */
  it("hands a span on verbatim, edges and all", () => {
    const r = fixtureRun({
      entities: [{ ...entity("a.com", "competitor"), spans: ["  padded on both sides  ", "  "] }],
    })
    expect(noteOf(r, "players/a.com.md")?.spans).toEqual(["  padded on both sides  "])
  })

  it("leaves spans absent on a row whose page was never read", () => {
    const r = fixtureRun({ entities: [entity("a.com", "competitor")] })
    expect(noteOf(r, "players/a.com.md")?.spans).toBeUndefined()
  })
})

/**
 * What the anchor published about ITSELF, which is the one part of a map
 * nothing had to judge: the integrations its own docs claim, and the rivals it
 * names on its own comparison pages. Every run since the understand stage
 * learned to keep them has written both, and until now no surface read either.
 *
 * `found` is deliberately not carried across — it is `leads.length` in the
 * engine, and a tab that prints a count beside the list it is showing should
 * derive the count from that list. `reachedMap` is carried, because nothing on
 * the page can recompute it: it is a name-match the run performed against its
 * own kept rows.
 */
describe("the anchor's own account of itself", () => {
  const report = {
    discovery: {
      integrations: [
        {
          with: "Supabase",
          does: "Send transactional emails from Supabase projects.",
          foundAt: "https://resend.com/features/smtp-service",
        },
        { with: "Zapier", does: "Automate emails using Zapier." },
      ],
    },
    rivals: {
      found: 2,
      cap: 6,
      queries: 6,
      reachedMap: 1,
      leads: [
        { name: "postmark", seen: 1, foundAt: "https://resend.com/migrate/postmark" },
        { name: "mailgun", seen: 2, foundAt: "https://resend.com/migrate/mailgun" },
      ],
    },
  }

  it("reads the integrations the understand stage kept, with the page that claimed each", () => {
    expect(viewOf(fixtureRun({ report })).integrations).toEqual([
      {
        with: "Supabase",
        does: "Send transactional emails from Supabase projects.",
        foundAt: "https://resend.com/features/smtp-service",
      },
      { with: "Zapier", does: "Automate emails using Zapier." },
    ])
  })

  it("reads the rival leads and the run's own count of how many reached the map", () => {
    const v = viewOf(fixtureRun({ report }))
    expect(v.rivalLeads).toEqual([
      { name: "postmark", foundAt: "https://resend.com/migrate/postmark" },
      { name: "mailgun", foundAt: "https://resend.com/migrate/mailgun" },
    ])
    expect(v.rivalsOnMap).toBe(1)
  })

  it("is empty, not absent, on a map recorded before either existed", () => {
    const v = viewOf(fixtureRun({ report: {} }))
    expect(v.integrations).toEqual([])
    expect(v.rivalLeads).toEqual([])
    expect(v.rivalsOnMap).toBeUndefined()
  })

  it("drops rows that are missing the two things a card is made of", () => {
    const v = viewOf(
      fixtureRun({
        report: {
          discovery: {
            integrations: [
              { with: "Named but silent" },
              { does: "described but unnamed", foundAt: "https://x.test/" },
              { with: "  ", does: "blank name" },
              "not an object",
              { with: "Zapier", does: "Automate emails.", foundAt: 7 },
            ],
          },
          rivals: { leads: [{ seen: 1 }, "postmark", { name: "mailgun" }], reachedMap: "one" },
        },
      }),
    )
    expect(v.integrations).toEqual([{ with: "Zapier", does: "Automate emails." }])
    expect(v.rivalLeads).toEqual([{ name: "mailgun" }])
    expect(v.rivalsOnMap).toBeUndefined()
  })

  it("survives a report whose discovery and rivals are not objects at all", () => {
    const v = viewOf(fixtureRun({ report: { discovery: "steps", rivals: [1, 2] } }))
    expect(v.integrations).toEqual([])
    expect(v.rivalLeads).toEqual([])
  })
})

/**
 * The committed gallery maps, read exactly as they ship — the same argument
 * lib/demo-maps.test.ts makes for using the real files: a fixture proves the
 * reader works on a shape someone invented for the test, and what needs proving
 * is that six maps already on disk still render.
 *
 * The clerk map is the specimen because it sits on both sides of this change:
 * 378 of its 449 entities carry the kernel's verified quotes, and none of them
 * carries a road, because it was recorded before the sweep stored those. So one
 * file pins the receipt AND the graceful absence, on real data.
 */
describe("the receipts inside a committed gallery map", () => {
  const clerk = (): CompletedRun => ({
    id: "33333333-3333-4333-8333-333333333333",
    domain: "clerk.com",
    queries: 0,
    startedAt: 0,
    endedAt: 1,
    status: "complete",
    result: JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../..", "demo", "maps", "sweep-clerk-com-202608062258.json"),
        "utf8",
      ),
    ),
  })

  it("hands the panel the quotes the kernel checked word for word", () => {
    const note = noteOf(clerk(), "products/auth0.com.md")
    expect(note?.spans).toEqual([
      "Auth0 is an easy to implement, adaptable authentication and authorization platform",
      "Integrate Auth0 in any application in just 5 minutes",
      "B2B SaaS Applications",
    ])
    // The number the panel already printed, now standing beside the evidence
    // it was measured from rather than in place of it.
    expect(note?.descGrounded).toBe(0.5)
  })

  it("says nothing about roads or first-party claims on a map recorded before them", () => {
    const v = viewOf(clerk())
    expect(v.notes.some((n) => n.roads !== undefined)).toBe(false)
    expect(v.integrations).toEqual([])
    expect(v.rivalLeads).toEqual([])
    expect(v.rivalsOnMap).toBeUndefined()
  })
})

/**
 * Segments: provenance rendered as segmentation, nothing inferred. Every kept
 * entity carries `foundBy` — which market's queries surfaced it — so the map's
 * segments already exist in the data; this derivation only counts them. An
 * entity whose `foundBy` names several markets straddles them, and one that
 * carries no `foundBy` at all lands in an honest "unattributed" segment rather
 * than being folded into a market nobody measured it into.
 */
describe("segments, provenance rendered as segmentation", () => {
  const cap = (name: string) => ({ name, does: `does ${name}`, centrality: "core", covers: [] })
  const segRun = (entities: unknown[]) => {
    const r = run(entities)
    ;(r.result.decomposition as { capabilities?: unknown[] }).capabilities = [cap("Proxy Networks"), cap("Web Scraping APIs")]
    return r
  }
  const found = (domain: string, foundBy: string[], relation = "competitor") => ({ ...entity(domain, relation), foundBy })

  it("derives one segment per first foundBy market, largest first", () => {
    const v = viewOf(segRun([
      found("a.com", ["Web Scraping APIs"]),
      found("b.com", ["Web Scraping APIs"]),
      found("c.com", ["Proxy Networks"]),
    ]))
    expect(v.segments).toEqual([
      { name: "Web Scraping APIs", size: 2, straddlers: 0 },
      { name: "Proxy Networks", size: 1, straddlers: 0 },
    ])
  })

  it("rides on the summary too, same derivation", () => {
    const s = summaryOf(segRun([found("a.com", ["Proxy Networks"])]))
    expect(s.segments).toEqual([{ name: "Proxy Networks", size: 1, straddlers: 0 }])
  })

  it("counts an entity with several lanes as a straddler of its first segment", () => {
    const v = viewOf(segRun([
      found("oxylabs.io", ["Proxy Networks", "Web Scraping APIs"]),
      found("b.com", ["Proxy Networks"]),
    ]))
    expect(v.segments).toEqual([{ name: "Proxy Networks", size: 2, straddlers: 1 }])
  })

  it("does not call repeated spellings of one lane a straddle", () => {
    const v = viewOf(segRun([found("a.com", ["Proxy Networks", "  proxy networks "])]))
    expect(v.segments[0]!.straddlers).toBe(0)
  })

  it("names a segment in the decomposition's spelling when the lane matches a market", () => {
    const v = viewOf(segRun([found("a.com", ["proxy networks"])]))
    expect(v.segments[0]!.name).toBe("Proxy Networks")
  })

  it("keeps a lane the planner invented mid-run as its own segment, in its recorded spelling", () => {
    const v = viewOf(segRun([found("a.com", ["captcha solvers"])]))
    expect(v.segments).toEqual([{ name: "captcha solvers", size: 1, straddlers: 0 }])
  })

  it("counts no-foundBy entities into an unattributed segment, last regardless of size", () => {
    const v = viewOf(segRun([
      found("a.com", ["Web Scraping APIs"]),
      entity("blocked-1.com", "unknown", "unknown"),
      entity("blocked-2.com", "unknown", "unknown"),
    ]))
    expect(v.segments).toEqual([
      { name: "Web Scraping APIs", size: 1, straddlers: 0 },
      { name: "unattributed", size: 2, straddlers: 0 },
    ])
  })

  it("derives no segments at all for a run recorded before foundBy existed", () => {
    // Kernel-era runs carry no foundBy on any entity. All-unattributed would be
    // furniture, not a fact — so the overview's segments row simply does not
    // render (it conditions on this array being non-empty).
    const v = viewOf(segRun([entity("a.com", "competitor"), entity("b.com", "substitute")]))
    expect(v.segments).toEqual([])
    expect(summaryOf(segRun([entity("a.com", "competitor")])).segments).toEqual([])
  })
})

/**
 * A STORED MAP THAT GAVE A STRANGER THE ANCHOR'S NAME.
 *
 * `place` runs every row past `withoutStolenNames` (core/src/export-kb.ts,
 * where the rule and the corpus it was measured on are written down). These
 * cover what the four reader surfaces do with the verdict: the row stays, its
 * name becomes its host, its kind goes back to unsettled, and the edges the
 * name minted go with the name.
 */
describe("a name the stored map never owned", () => {
  /** The `run()` fixture's anchor is anchor.com, so "Anchor" is the label a
   *  foreign host has no business wearing. */
  const wearing = (domain: string, name: string, relation = "competitor", kind = "product") => ({
    ...entity(domain, relation, kind),
    name,
  })

  it("keeps the row, under its host, wearing the reason", () => {
    const r = run([entity("real.com", "competitor"), wearing("aws.example", "Anchor")])
    const g = graphOf(r)
    const node = g.nodes.find((n) => n.domain === "aws.example")!
    expect(node.title).toBe("aws.example")
    expect(node.kind).toBe("unknown")
    expect(node.relation).toBe("unknown")
    expect(node.group).toBe("unplaced")
    expect(node.what).toBe("")

    const note = noteOf(r, node.id)!
    expect(note.title).toBe("aws.example")
    expect(note.because).toBe(
      "the stored map gave this host the anchor's own identity, so nothing it said about it stands",
    )

    // Nothing was deleted: the anchor and both hosts are still notes, and only
    // the one that was really a company is counted as one.
    const s = summaryOf(r)
    expect(s.notes).toBe(3)
    expect(s.companies).toBe(1)
  })

  it("spares a host whose own spelling carries the name", () => {
    const g = graphOf(
      run([
        // The anchor reached another way — a second TLD and a subdomain. Both
        // are foreign to `registrableHost`, and both really are the anchor.
        wearing("anchor.fr", "Anchor", "competitor", "company"),
        wearing("docs.anchor.com", "Anchor", "integration"),
        // And a third party that is genuinely called this, the clerk.io case.
        wearing("anchor.io", "Anchor"),
      ]),
    )
    for (const host of ["anchor.fr", "docs.anchor.com", "anchor.io"]) {
      const node = g.nodes.find((n) => n.domain === host)!
      expect(node.title, host).toBe("Anchor")
      expect(node.kind, host).not.toBe("unknown")
    }
  })

  it("drops the links the name minted and keeps the links it did not", () => {
    const r = run(
      [
        wearing("aws.example", "Anchor"),
        wearing("anchor.fr", "Anchor", "competitor", "company"),
        entity("blog.example", "covers", "publisher"),
        entity("react.example", "integration"),
        entity("forum.example", "discusses", "community"),
      ],
      [
        // Bought with the stolen name, and the only evidence for it is that a
        // page said "Anchor" — which this row is not.
        { from: "blog.example", to: "aws.example", relation: "covers", why: 'a page on blog.example names "Anchor"', confidence: "measured" },
        // Same sentence, the other way round: the page really is on this host
        // and the end it lands on is the one that owns the name.
        { from: "aws.example", to: "anchor.fr", relation: "competitor", why: 'a page on aws.example names "Anchor"', confidence: "measured" },
        // A different term entirely.
        { from: "aws.example", to: "react.example", relation: "integration", why: 'a page on aws.example names "React"', confidence: "measured" },
        // The paid pass, which wrote prose rather than quoting a term.
        { from: "aws.example", to: "forum.example", relation: "discusses", why: "engineers argue about it there", confidence: "inferred" },
      ],
    )
    const peers = graphOf(r)
      .edges.filter((e) => !e.source.startsWith("markets/") && e.source !== "company.md")
      .map((e) => `${e.source} -> ${e.target}`)
      .sort()
    expect(peers).toEqual([
      "unplaced/aws.example.md -> communities/forum.example.md",
      "unplaced/aws.example.md -> players/anchor.fr.md",
      "unplaced/aws.example.md -> players/react.example.md",
    ])
    // And the card counts what the map has, not what the file holds.
    expect(summaryOf(r).edges).toBe(3)
  })

  it("changes nothing on a map that never did it", () => {
    const entities = [entity("a.com", "competitor"), entity("b.com", "integration")]
    const edges = [{ from: "a.com", to: "b.com", relation: "integration", why: 'a page on a.com names "b.com"', confidence: "measured" }]
    const s = summaryOf(run(entities, edges))
    expect(s.edges).toBe(1)
    expect(s.notes).toBe(3)
    expect(graphOf(run(entities, edges)).nodes.map((n) => n.title).sort()).toEqual(["a.com", "anchor.com", "b.com"])
  })
})

/**
 * AND THE SAME THING AGAINST THE FOUR COMMITTED MAPS THAT HAVE IT.
 *
 * `demo/maps/` is the public gallery, so these rows are what a stranger sees.
 * The fixtures above prove the rule; this proves it fires on the files being
 * served, and pins the price so a change to either side has to come past it.
 * Every number here was measured off the committed file.
 */
describe("the gallery's own stolen names", () => {
  const MAPS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "demo", "maps")
  const stored = (file: string): CompletedRun => ({
    id: file.slice("sweep-".length, -".json".length),
    domain: "",
    queries: 0,
    startedAt: 0,
    endedAt: 1,
    status: "complete",
    result: JSON.parse(readFileSync(join(MAPS, file), "utf8")),
  })

  /** file -> the hosts that were wearing the anchor's name, and what the map
   *  said each of them was before the reader withdrew it. */
  const THEFTS: Array<[string, Array<[string, string]>]> = [
    ["sweep-vercel-com-202608062351.json", [
      ["aws.amazon.com", "product/competitor, 328 links"],
      ["facebook.com", "product/none, 330"],
      ["redis.io", "product/competitor, 318"],
      ["expo.dev", "publisher/lists, 316"],
      ["exasol.com", "unknown/unknown, 315"],
      ["examples.tely.ai", "product/none, 315"],
      ["eginnovations.com", "unknown/unknown, 315"],
    ]],
    ["sweep-supabase-com-202608070017.json", [
      ["aws.amazon.com", "product/dependency, 105"],
      ["facebook.com", "product/none, 107"],
      ["exoscale.com", "product/competitor, 97"],
      ["widgets.weforum.org", "product/competitor, 97"],
    ]],
    ["sweep-stripe-com-202608070005.json", [["exalate.com", "product/shaper, 223"]]],
    ["sweep-clerk-com-202608062258.json", [
      ["shopify.com", "product/competitor, 9"],
      ["eginnovations.com", "product/competitor, 9"],
    ]],
  ]

  it.each(THEFTS)("%s: every borrowed name goes back to its host", (file, hosts) => {
    const g = graphOf(stored(file))
    for (const [host] of hosts) {
      const node = g.nodes.find((n) => n.domain === host)
      expect(node, host).toBeDefined()
      // Still on the map — the host was really found — and no longer claiming
      // to be the company the map is of.
      expect(node!.title, host).toBe(host)
      expect(node!.kind, host).toBe("unknown")
      expect(node!.relation, host).toBe("unknown")
    }
  })

  /** The headline each card prints, before and after, on the four maps that
   *  had it and the two that did not. `companies` only moves for a row the
   *  count included: 8 of the 14 were `product` with a relation. */
  it.each([
    ["sweep-vercel-com-202608062351.json", 842, 840, 6283, 4080],
    ["sweep-supabase-com-202608070017.json", 443, 440, 2351, 1969],
    ["sweep-stripe-com-202608070005.json", 1008, 1007, 3017, 2794],
    ["sweep-clerk-com-202608062258.json", 179, 177, 517, 499],
    ["sweep-brightdata-com-202608042230.json", 442, 442, 487, 487],
    ["sweep-cursor-com-202608070032.json", 321, 321, 1796, 1796],
  ])("%s: %i companies -> %i, %i links -> %i", (file, _was, companies, _hadLinks, links) => {
    const s = summaryOf(stored(file))
    expect(s.companies).toBe(companies)
    expect(s.edges).toBe(links)
  })

  it("leaves the anchor's own row alone", () => {
    const g = graphOf(stored("sweep-vercel-com-202608062351.json"))
    expect(g.nodes.find((n) => n.id === "company.md")!.title).toBe("vercel.com")
    // nextjs.org is Vercel's, and the run named it "Next.js by Vercel". A rule
    // matching anything CONTAINING the label would take that name too.
    expect(g.nodes.find((n) => n.domain === "nextjs.org")!.title).toBe("Next.js by Vercel")
  })
})

/**
 * Straddler edges: the one real structure `foundBy` adds to the map. The edge
 * builder used to keep only the first resolvable lane, so an entity found by
 * two markets sat wholly inside one. The remaining resolvable lanes now draw
 * as `found` edges with confidence `inferred` — the canvas already dashes
 * inferred, so a straddler visibly sits between its segments purely from data.
 */
describe("graphOf, straddler edges", () => {
  const cap = (name: string) => ({ name, does: `does ${name}`, centrality: "core", covers: [] })
  const withMarkets = (entities: unknown[]) => {
    const r = run(entities)
    ;(r.result.decomposition as { capabilities?: unknown[] }).capabilities = [cap("proxy network"), cap("search api"), cap("datasets")]
    return r
  }

  it("emits each remaining resolvable lane as an inferred found edge", () => {
    const g = graphOf(withMarkets([{ ...entity("oxylabs.io", "competitor"), foundBy: ["proxy network", "search api", "datasets"] }]))
    const mine = g.edges.filter((e) => e.target === "players/oxylabs.io.md")
    expect(mine).toHaveLength(3)
    const primary = mine.find((e) => e.source === "markets/proxy-network.md")
    expect(primary).toMatchObject({ label: "competitor" })
    expect(primary!.confidence).toBeUndefined()
    const rest = mine.filter((e) => e !== primary)
    expect(rest.map((e) => e.source).sort()).toEqual(["markets/datasets.md", "markets/search-api.md"])
    for (const e of rest) expect(e).toMatchObject({ label: "found", confidence: "inferred" })
  })

  it("does not duplicate the primary lane however it is spelled", () => {
    const g = graphOf(withMarkets([{ ...entity("a.com", "competitor"), foundBy: ["proxy network", " Proxy Network ", "search api"] }]))
    const mine = g.edges.filter((e) => e.target === "players/a.com.md")
    expect(mine).toHaveLength(2)
    expect(mine.filter((e) => e.source === "markets/proxy-network.md")).toHaveLength(1)
  })

  it("skips an extra lane the planner invented mid-run", () => {
    const g = graphOf(withMarkets([{ ...entity("a.com", "competitor"), foundBy: ["proxy network", "captcha solvers"] }]))
    expect(g.edges.filter((e) => e.target === "players/a.com.md")).toHaveLength(1)
  })

  it("draws a relation-none straddler as found in every lane, only the extras inferred", () => {
    const g = graphOf(withMarkets([{ ...entity("quiet.com", "none"), foundBy: ["datasets", "search api"] }]))
    const mine = g.edges.filter((e) => e.target === "players/quiet.com.md")
    expect(mine).toHaveLength(2)
    expect(mine.every((e) => e.label === "found")).toBe(true)
    expect(mine.find((e) => e.source === "markets/datasets.md")!.confidence).toBeUndefined()
    expect(mine.find((e) => e.source === "markets/search-api.md")!.confidence).toBe("inferred")
  })

  it("changes nothing for a single-lane entity", () => {
    const g = graphOf(withMarkets([{ ...entity("solo.com", "substitute"), foundBy: ["datasets"] }]))
    const mine = g.edges.filter((e) => e.target === "players/solo.com.md")
    expect(mine).toHaveLength(1)
    expect(mine[0]!.confidence).toBeUndefined()
  })
})

/**
 * The demonstration corpus, following drift.test.ts's walk-up: the validation
 * kernel's big brightdata sweep, whose provenance this feature renders.
 * `runs/` is gitignored and CI will not have it, so the suite skips honestly
 * when the file is absent instead of green-lighting numbers it never derived.
 */
const runsDir = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "runs", "sweep-brightdata-com-202608051650.json"))) return join(dir, "runs")
    dir = dirname(dir)
  }
  return null
})()

describe.skipIf(runsDir === null)("segments of the real brightdata run", () => {
  const stored = (): CompletedRun => ({
    id: "22222222-2222-4222-8222-222222222222",
    domain: "brightdata.com",
    queries: 0,
    startedAt: 0,
    endedAt: 1,
    status: "complete",
    result: JSON.parse(readFileSync(join(runsDir!, "sweep-brightdata-com-202608051650.json"), "utf8")),
  })

  it("derives the run's five markets plus the 13 unattributed, straddlers riding each", () => {
    const v = viewOf(stored())
    expect(v.segments.map((s) => s.name)).toEqual([
      "Web Scraping APIs",
      "Retail Competitive Intelligence",
      "Proxy Networks",
      "Pre-collected Datasets",
      "Managed Web Scraping Services",
      "unattributed",
    ])
    // The night's own numbers, pinned as windows: the derivation dedupes hosts
    // and drops the anchor and noise, so it counts a shade under the raw file.
    const by = new Map(v.segments.map((s) => [s.name, s]))
    expect(by.get("Web Scraping APIs")!.size).toBeGreaterThanOrEqual(285)
    expect(by.get("Web Scraping APIs")!.size).toBeLessThanOrEqual(300)
    expect(by.get("unattributed")).toEqual({ name: "unattributed", size: 13, straddlers: 0 })
    const straddlers = v.segments.reduce((n, s) => n + s.straddlers, 0)
    expect(straddlers).toBeGreaterThanOrEqual(140)
    expect(straddlers).toBeLessThanOrEqual(155)
    const sized = v.segments.reduce((n, s) => n + s.size, 0)
    expect(sized).toBe(v.notes.length - 1) // every kept entity sits in exactly one segment
  })

  it("draws every extra lane as an inferred found edge", () => {
    const g = graphOf(stored())
    const inferredFound = g.edges.filter((e) => e.label === "found" && e.confidence === "inferred")
    expect(inferredFound.length).toBeGreaterThanOrEqual(140)
    // oxylabs, the canonical straddler: one primary lane, the rest inferred.
    const oxylabs = g.edges.filter((e) => e.target === "players/oxylabs.io.md" && e.source.startsWith("markets/"))
    expect(oxylabs.length).toBeGreaterThanOrEqual(2)
    expect(oxylabs.filter((e) => e.confidence === "inferred")).toHaveLength(oxylabs.length - 1)
  })
})

/**
 * The overview's headline count. `stats.queries` is the OPENING hand and the
 * widening loop adds to it: on a measured brightdata map the opening was 86
 * and the run fired 190, so the page said "86 queries bought" beside 570 SERP
 * calls the same run had paid for.
 */
describe("queries bought is what was fired, not what was opened", () => {
  const withReport = (statsQueries: number, reportQueries?: number): CompletedRun => {
    const r = run([entity("rival.com", "competitor")])
    const res = r.result as unknown as { stats: { queries: number }; report: Record<string, unknown> }
    res.stats.queries = statsQueries
    if (reportQueries !== undefined) res.report.queries = reportQueries
    return r
  }

  it("prefers the fired count over the opening hand", () => {
    expect(viewOf(withReport(86, 190)).manifest?.queries).toBe(190)
  })

  it("falls back to the opening for a map stored before the field existed", () => {
    expect(viewOf(withReport(86)).manifest?.queries).toBe(86)
  })
})
