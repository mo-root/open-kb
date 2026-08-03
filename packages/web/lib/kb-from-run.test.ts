import { describe, it, expect } from "vitest"
import { graphOf } from "./kb-from-run"
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
