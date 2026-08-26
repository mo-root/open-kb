import { describe, expect, it } from "vitest"
import { isSpendDecision, mergeEntities } from "./BuildWorkflow"
import type { EntityData } from "./FindingsPanel"

/**
 * BuildWorkflow.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history).
 *
 * `isSpendDecision` promotes a progress line from the feed to the stage rail —
 * get its match wrong and a routine "here is what I found" line reads as the
 * run deciding to spend more, or a real stopping decision never surfaces above
 * the fold. `mergeEntities` is the only place a streamed classification batch
 * is folded onto what a reader already sees; drop its "keep earlier fields"
 * behaviour and a later, thinner batch would blank out a domain's name and
 * kind rather than add to them. Neither function had ever been imported by a
 * test.
 */

describe("isSpendDecision: only the plan agent's own verdict lines count", () => {
  it("matches 'enough' at the start of a plan line", () => {
    expect(isSpendDecision("plan", "enough for now")).toBe(true)
  })

  it("matches 'round N' at the start of a plan line", () => {
    expect(isSpendDecision("plan", "round 2 added only 3 — stopping")).toBe(true)
  })

  it("matches a round with a multi-digit count", () => {
    expect(isSpendDecision("plan", "round 12 added nothing new")).toBe(true)
  })

  it("is case-insensitive and trims the agent name", () => {
    expect(isSpendDecision("Plan", "ENOUGH, stopping here")).toBe(true)
    expect(isSpendDecision(" PLAN ", "round 3: corroboration only")).toBe(true)
  })

  it("trims leading whitespace off the message before matching", () => {
    expect(isSpendDecision("plan", "   round 3: corroboration only")).toBe(true)
  })

  it("rejects a non-plan agent even with a matching message", () => {
    expect(isSpendDecision("search", "enough, stopping")).toBe(false)
    expect(isSpendDecision("classify", "round 2 added only 3")).toBe(false)
  })

  it("rejects a plan line that is not a verdict", () => {
    expect(isSpendDecision("plan", "catalog: 40 queries, none name the anchor")).toBe(false)
  })

  it("requires a word boundary after 'enough'", () => {
    expect(isSpendDecision("plan", "enoughify the budget")).toBe(false)
  })

  it("requires whitespace between 'round' and the number", () => {
    expect(isSpendDecision("plan", "roundabout 3 queries left")).toBe(false)
    expect(isSpendDecision("plan", "round2 added 3")).toBe(false)
  })

  it("does not match 'enough' or 'round N' mid-message", () => {
    expect(isSpendDecision("plan", "that was not enough, round 2 next")).toBe(false)
  })
})

describe("mergeEntities: folds a batch onto what is already on screen", () => {
  it("appends an entity for a domain not already present", () => {
    const current: EntityData[] = [{ domain: "a.com", name: "A" }]
    const incoming: EntityData[] = [{ domain: "b.com", name: "B" }]
    expect(mergeEntities(current, incoming)).toEqual([
      { domain: "a.com", name: "A" },
      { domain: "b.com", name: "B" },
    ])
  })

  it("merges a later batch's fields onto an existing entity without dropping earlier ones", () => {
    const current: EntityData[] = [{ domain: "a.com", name: "A", kind: "company" }]
    const incoming: EntityData[] = [{ domain: "a.com", why: "cites the anchor" }]
    expect(mergeEntities(current, incoming)).toEqual([
      { domain: "a.com", name: "A", kind: "company", why: "cites the anchor" },
    ])
  })

  it("lets a later batch overwrite a field an earlier one set", () => {
    const current: EntityData[] = [{ domain: "a.com", kind: "company" }]
    const incoming: EntityData[] = [{ domain: "a.com", kind: "competitor" }]
    expect(mergeEntities(current, incoming)[0]).toEqual({ domain: "a.com", kind: "competitor" })
  })

  it("drops a row with no domain rather than crashing or adding a blank entry", () => {
    const current: EntityData[] = [{ domain: "a.com", name: "A" }]
    const incoming = [{ name: "no domain here" }, { domain: "", name: "empty domain" }] as EntityData[]
    expect(mergeEntities(current, incoming)).toEqual([{ domain: "a.com", name: "A" }])
  })

  it("folds two incoming rows for the same new domain into one entity", () => {
    const incoming: EntityData[] = [
      { domain: "a.com", name: "A" },
      { domain: "a.com", kind: "company" },
    ]
    expect(mergeEntities([], incoming)).toEqual([{ domain: "a.com", name: "A", kind: "company" }])
  })

  it("returns a new array and leaves the current one untouched", () => {
    const current: EntityData[] = [{ domain: "a.com", name: "A" }]
    const result = mergeEntities(current, [{ domain: "b.com", name: "B" }])
    expect(result).not.toBe(current)
    expect(current).toEqual([{ domain: "a.com", name: "A" }])
  })

  it("passes an empty incoming batch through unchanged", () => {
    const current: EntityData[] = [{ domain: "a.com", name: "A" }]
    expect(mergeEntities(current, [])).toEqual(current)
  })
})
