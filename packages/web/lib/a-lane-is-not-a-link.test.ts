import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { graphOf } from "./kb-from-run"
import type { CompletedRun } from "./runs"

/**
 * TWO DEFECTS THAT LOOKED LIKE ONE HEALTHY MAP.
 *
 * The canvas reported 0.5% orphans across the corpus while 57% of its nodes had
 * no measured neighbour, and it did that for two reasons that pointed the same
 * way.
 *
 * One: `graphOf` built its endpoint index from `kept`, and `place` drops the
 * anchor's own entity row, so the anchor host resolved to nothing and every
 * measured edge with the anchor at either end failed the both-ends test. 944
 * distinct pairs across the six gallery maps, 2,704 across the current-engine
 * runs on disk. Nothing else was being lost: self-edges and off-map ends both
 * measured 0.
 *
 * Two: every entity hangs off the market its `foundBy` names, so almost every
 * node touches an edge and `orphans` — which counts edges of any kind — is
 * structurally incapable of reporting a linking failure. That lane means "a
 * query in this market returned this host", not "these two are related", and
 * it now says so in the data: `provenance: true`, and `unlinked` counts the
 * entities that only ever got that kind.
 */

const MAPS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "demo", "maps")

function entity(domain: string, relation: string, foundBy?: string[]) {
  return {
    name: domain,
    domain,
    kind: "company",
    what: `what ${domain} does`,
    relation,
    why: `why ${domain}`,
    ...(foundBy ? { foundBy } : {}),
  }
}

/** The smallest run this reader accepts, anchored on anchor.com. `markets`
 *  names the capabilities the decomposition planned, which is what a `foundBy`
 *  lane has to match to resolve. */
function run(entities: unknown[], edges: unknown[] = [], markets: string[] = []): CompletedRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    domain: "anchor.com",
    queries: 4,
    startedAt: 0,
    endedAt: 1,
    status: "complete",
    result: {
      anchor: "anchor.com",
      decomposition: {
        sells: "s",
        buyer: "b",
        products: [],
        capabilities: markets.map((name) => ({ name, does: `does ${name}`, covers: [] })),
        coinages: [],
      },
      queries: [],
      entities,
      edges,
      stats: { queries: 4, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, serpCalls: 0, unlockerCalls: 0, usd: 0, seconds: 1 },
      report: {},
    } as never,
  }
}

const stored = (file: string): CompletedRun => ({
  id: file,
  domain: "",
  queries: 0,
  startedAt: 0,
  endedAt: 1,
  status: "complete",
  result: JSON.parse(readFileSync(join(MAPS, file), "utf8")),
})

/** The anchor's end of an edge, whichever end it landed on. */
const touchingAnchor = (g: { edges: { source: string; target: string; label: string; provenance?: true }[] }) =>
  g.edges.filter((e) => (e.source === "company.md" || e.target === "company.md") && e.provenance !== true)

describe("the anchor is an endpoint too", () => {
  it("draws a measured edge that lands on the anchor", () => {
    const g = graphOf(
      run(
        [entity("a.com", "none")],
        [{ from: "a.com", to: "anchor.com", relation: "competitor", why: "a page names both", confidence: "measured" }],
      ),
    )
    const mine = touchingAnchor(g)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.label).toBe("competitor")
    expect(mine[0]!.source).toBe("players/a.com.md")
    expect(mine[0]!.target).toBe("company.md")
  })

  it("matches the anchor the same way it matches every other host", () => {
    const g = graphOf(
      run(
        [entity("a.com", "none")],
        [{ from: "WWW.Anchor.COM", to: "a.com", relation: "integration", why: "x", confidence: "measured" }],
      ),
    )
    expect(touchingAnchor(g).map((e) => e.label)).toEqual(["integration"])
  })

  it("still drops a self-edge, however the anchor spells itself", () => {
    const g = graphOf(
      run(
        [entity("a.com", "none")],
        [{ from: "anchor.com", to: "www.anchor.com", relation: "competitor", why: "x", confidence: "inferred" }],
      ),
    )
    expect(touchingAnchor(g)).toEqual([])
  })

  it("still drops an edge whose other end the run never recorded", () => {
    const g = graphOf(
      run([entity("a.com", "none")], [{ from: "anchor.com", to: "never-found.com", relation: "competitor", why: "x" }]),
    )
    expect(touchingAnchor(g)).toEqual([])
  })

  /* THE RESTATEMENT RULE. 645 of the 944 recovered pairs (68%) carry the
     relation the entity's own home lane is already labelled with — the audit
     measured 66% over 18 maps — so drawing them puts a second wire on the
     canvas making a claim the reader can already read off the first. */
  it("does not restate the relation the market lane already carries", () => {
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network"])],
        [{ from: "anchor.com", to: "a.com", relation: "competitor", why: "x", confidence: "measured" }],
        ["proxy network"],
      ),
    )
    expect(touchingAnchor(g)).toEqual([])
    // and the lane itself is untouched, still saying what it always said
    const lane = g.edges.find((e) => e.source === "markets/proxy-network.md")!
    expect(lane).toMatchObject({ target: "players/a.com.md", label: "competitor", provenance: true })
  })

  it("draws the edge when it says something the lane does not", () => {
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network"])],
        [{ from: "anchor.com", to: "a.com", relation: "dependency", why: "x", confidence: "measured" }],
        ["proxy network"],
      ),
    )
    expect(touchingAnchor(g).map((e) => e.label)).toEqual(["dependency"])
  })

  /** Where the entity fell back to the anchor star, a restatement is literally
   *  the same wire — same two ends, same label — 45 times across the gallery. */
  it("does not double the star edge an unattributed entity already has", () => {
    const g = graphOf(
      run(
        [entity("a.com", "competitor")],
        [{ from: "a.com", to: "anchor.com", relation: "competitor", why: "x", confidence: "measured" }],
      ),
    )
    const wires = g.edges.filter((e) => e.target === "players/a.com.md" || e.source === "players/a.com.md")
    expect(wires).toHaveLength(1)
    expect(wires[0]).toMatchObject({ source: "company.md", label: "competitor", provenance: true })
  })

  it("rescues the only edge a relation-none host has", () => {
    // Placed in a market, refused against the anchor, so its lane reads "found"
    // and nothing else on this map says it is related to anything. The measured
    // edge is the whole of what the run learned about it.
    const g = graphOf(
      run(
        [entity("quiet.com", "none", ["proxy network"])],
        [{ from: "anchor.com", to: "quiet.com", relation: "substitute", why: "x", confidence: "measured" }],
        ["proxy network"],
      ),
    )
    expect(touchingAnchor(g).map((e) => e.label)).toEqual(["substitute"])
    expect(g.unlinked).toBe(0)
  })

  /** The committed gallery, measured off the files being served — the
   *  2026-08-18 rebuild, one engine generation, orphan-ask and integration
   *  edges live. `measured` is every edge the run asserted between two hosts
   *  and this reader drew: 20,065 over the six, against 10,901 for the set
   *  this replaced. */
  it.each([
    ["sweep-brightdata-com-20260818131026.json", 3554],
    ["sweep-neon-tech-20260818225808.json", 3115],
    ["sweep-sentry-io-20260818232602.json", 4178],
    ["sweep-stripe-com-20260818214527.json", 2870],
    ["sweep-supabase-com-20260818210215.json", 2920],
    ["sweep-vercel-com-20260818212925.json", 3428],
  ])("%s draws %i measured edges", (file, measured) => {
    const g = graphOf(stored(file))
    expect(g.edges.filter((e) => e.provenance !== true)).toHaveLength(measured)
  })
})

describe("a lane is not a link", () => {
  it("stamps every wire this reader draws, and none the run measured", () => {
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network", "search api"]), entity("b.com", "none")],
        [{ from: "a.com", to: "b.com", relation: "integration", why: "x", confidence: "inferred" }],
        ["proxy network", "search api"],
      ),
    )
    const drawn = g.edges.filter((e) => e.provenance === true).map((e) => `${e.source} -> ${e.target}`)
    expect(drawn.sort()).toEqual([
      "company.md -> markets/proxy-network.md",
      "company.md -> markets/search-api.md",
      "markets/proxy-network.md -> players/a.com.md",
      "markets/search-api.md -> players/a.com.md",
    ])
    const measured = g.edges.filter((e) => e.provenance !== true)
    expect(measured).toHaveLength(1)
    expect(measured[0]).toMatchObject({ label: "integration", confidence: "inferred" })
  })

  it("keeps confidence meaning what it meant — inferred is not provenance", () => {
    // The straddle lane wears `inferred` for the dashed style and is provenance;
    // a real edge wears `inferred` because the model reasoned it and is not.
    // 73-88% of a map's edges are inferred, so conflating the two would have
    // rewritten what every real edge claims.
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network", "search api"]), entity("b.com", "none")],
        [{ from: "a.com", to: "b.com", relation: "competitor", why: "x", confidence: "inferred" }],
        ["proxy network", "search api"],
      ),
    )
    const inferred = g.edges.filter((e) => e.confidence === "inferred")
    expect(inferred).toHaveLength(2)
    expect(inferred.filter((e) => e.provenance === true)).toHaveLength(1)
    expect(inferred.filter((e) => e.provenance !== true)).toHaveLength(1)
  })

  /* THE NUMBER THE OLD ONE COULD NOT REPORT. */
  it("reports no orphan and one unlinked for a host the run only ever found", () => {
    const g = graphOf(run([entity("a.com", "competitor", ["proxy network"])], [], ["proxy network"]))
    expect(g.orphans).toEqual([])
    expect(g.unlinked).toBe(1)
  })

  it("counts an entity as linked only once a measured edge touches it", () => {
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network"]), entity("b.com", "competitor", ["proxy network"]), entity("c.com", "competitor", ["proxy network"])],
        [{ from: "a.com", to: "b.com", relation: "substitute", why: "x", confidence: "measured" }],
        ["proxy network"],
      ),
    )
    expect(g.orphans).toEqual([])
    expect(g.unlinked).toBe(1) // c.com
  })

  it("does not count the market lane, the straddle or the anchor star as linking", () => {
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network", "search api"]), entity("b.com", "competitor")],
        [],
        ["proxy network", "search api"],
      ),
    )
    expect(g.edges.length).toBeGreaterThan(0)
    expect(g.orphans).toEqual([])
    expect(g.unlinked).toBe(2)
  })

  it("does not count an edge the restatement rule dropped", () => {
    // The wire is not on the canvas, so the node is not wired by it. `unlinked`
    // describes the map a reader is looking at, not the file behind it.
    const g = graphOf(
      run(
        [entity("a.com", "competitor", ["proxy network"])],
        [{ from: "anchor.com", to: "a.com", relation: "competitor", why: "x", confidence: "measured" }],
        ["proxy network"],
      ),
    )
    expect(g.unlinked).toBe(1)
  })

  /** The gallery again, and the whole reason `unlinked` exists — updated for
   *  the 2026-08-18 rebuild: `unlinked` fell from 4,472 of 8,563 (52.2%) on
   *  the previous set to 2,252 of 6,981 (32.3%) here, most of the drop bought
   *  by the orphan ask. Both numbers are true and only `unlinked` answers "is
   *  this map linking". */
  it.each([
    ["sweep-brightdata-com-20260818131026.json", 4, 606],
    ["sweep-neon-tech-20260818225808.json", 13, 247],
    ["sweep-sentry-io-20260818232602.json", 8, 271],
    ["sweep-stripe-com-20260818214527.json", 0, 486],
    ["sweep-supabase-com-20260818210215.json", 6, 406],
    ["sweep-vercel-com-20260818212925.json", 0, 236],
  ])("%s reports %i orphans and %i unlinked", (file, orphans, unlinked) => {
    const g = graphOf(stored(file))
    expect(g.orphans).toHaveLength(orphans)
    expect(g.unlinked).toBe(unlinked)
  })
})
