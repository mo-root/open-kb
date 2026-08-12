import { describe, it, expect } from "vitest"
import { viewOf } from "./kb-from-run"
import type { CompletedRun } from "./runs"

/**
 * `RELATION_WEIGHT` listed eleven relations and not `unknown`, so the
 * `?? RELATION_WEIGHT.none` fallback gave every unsettled host 15 — the weight
 * reserved for a host the classifier looked at and affirmatively ruled out.
 * 5,770 rows across the runs on disk carry `relation: unknown`, and the export's
 * own doctrine is that it means "not proven", not "not a competitor". Placement
 * is the only ordering these surfaces have, so ranking the two alike told a
 * reader the run had decided something it had refused to decide.
 */

function row(domain: string, relation: string, kind = "company") {
  return { name: domain, domain, kind, what: "", relation, why: "" }
}

function run(entities: unknown[]): CompletedRun {
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
      edges: [],
      stats: { queries: 4, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, serpCalls: 0, unlockerCalls: 0, usd: 0, seconds: 1 },
      report: {},
    } as never,
  }
}

const placementOf = (r: CompletedRun, path: string) => viewOf(r).notes.find((n) => n.path === path)!.relevance

describe("a refusal is not a rejection", () => {
  it("places an unknown row above one the classifier ruled out", () => {
    const r = run([row("unsettled.com", "unknown", "unknown"), row("ruled-out.com", "none")])
    expect(placementOf(r, "unplaced/unsettled.com.md")).toBe(20)
    expect(placementOf(r, "players/ruled-out.com.md")).toBe(15)
  })

  it("keeps it below every relation the run did settle", () => {
    const r = run([
      row("unsettled.com", "unknown", "unknown"),
      row("venue.com", "discusses", "community"),
      row("rival.com", "competitor"),
    ])
    const unknown = placementOf(r, "unplaced/unsettled.com.md")
    expect(unknown).toBeLessThan(placementOf(r, "communities/venue.com.md"))
    expect(unknown).toBeLessThan(placementOf(r, "players/rival.com.md"))
  })

  it("sorts the refusal ahead of the rejection on the notes list", () => {
    // The list is ordered by placement, so this is what a reader actually sees:
    // before the fix the two tied at 15 and fell back to alphabetical, which
    // put the ruled-out host first for no reason anyone could defend.
    const r = run([row("zz-unsettled.com", "unknown", "unknown"), row("aa-ruled-out.com", "none")])
    const paths = viewOf(r).notes.map((n) => n.path)
    expect(paths.indexOf("unplaced/zz-unsettled.com.md")).toBeLessThan(paths.indexOf("players/aa-ruled-out.com.md"))
  })

  it("still falls back to the rejection weight for a relation nobody has heard of", () => {
    // The fallback is the guard against a run written by a later engine, and it
    // stays: an unrecognised relation is not evidence of anything.
    expect(placementOf(run([row("odd.com", "co-marketing")]), "players/odd.com.md")).toBe(15)
  })
})
