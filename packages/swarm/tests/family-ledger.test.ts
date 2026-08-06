import { describe, it, expect } from "vitest"
import { FamilyLedger, MapState, type MapNode } from "../src/index.js"

/**
 * The family ledger: the run's planned questions as rows, orchestrator-side
 * (the audit's placement ruling — core board.ts untouched). A family is a
 * lead-band mission, the seed included; a proposal is not a family until
 * promoted, so events about keys never opened fall through in silence.
 */

const node = (
  key: string,
  contributions: Array<{ writer: string; tier: "own-page" | "page" | "snippet" }>,
  over: Partial<MapNode> = {},
): MapNode => ({
  key,
  name: key,
  domain: key,
  kind: "company",
  what: "fraud scoring",
  relation: "competitor",
  why: "same job, same buyer",
  tier: "page",
  evidence: [],
  also: [],
  contributions,
  ...over,
})

const emptyMap = () => new MapState("anchor.com")

describe("FamilyLedger lifecycle", () => {
  it("the seed opens family zero: queued, then claimed, then landed with its actuals", () => {
    const fam = new FamilyLedger()
    fam.opened("orientation", "orient:anchor.com", 100)
    expect(fam.rows(emptyMap())).toEqual([
      {
        lens: "orientation",
        dedupeKey: "orient:anchor.com",
        priority: 100,
        status: "queued",
        nodesAdded: 0,
        pageTierNodes: 0,
      },
    ])
    fam.claimed("orient:anchor.com")
    expect(fam.rows(emptyMap())[0]).toMatchObject({ status: "claimed" })
    fam.landed("orient:anchor.com", 5)
    expect(fam.rows(emptyMap())[0]).toMatchObject({ status: "landed", nodesAdded: 5 })
  })

  it("a killed family survives with its because — the denominator keeps it", () => {
    const fam = new FamilyLedger()
    fam.opened("orientation", "orient:anchor.com", 100)
    fam.opened("rivals", "m-rivals", 90)
    fam.killed("m-rivals", "the orientation lens already asks this")
    const rows = fam.rows(emptyMap())
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({
      lens: "rivals",
      dedupeKey: "m-rivals",
      priority: 90,
      status: "killed",
      because: "the orientation lens already asks this",
      nodesAdded: 0,
      pageTierNodes: 0,
    })
  })

  it("events about keys never opened are ignored: an unpromoted proposal that runs is not a family", () => {
    const fam = new FamilyLedger()
    fam.opened("orientation", "orient:anchor.com", 100)
    fam.claimed("p-proposal")
    fam.landed("p-proposal", 3)
    fam.killed("p-other", "board hygiene, not a family event")
    expect(fam.rows(emptyMap())).toHaveLength(1)
    expect(fam.rows(emptyMap())[0]!.dedupeKey).toBe("orient:anchor.com")
  })

  it("a killed key re-opened is the question asked again: one live row, the old because gone", () => {
    const fam = new FamilyLedger()
    fam.opened("rivals", "m-rivals", 90)
    fam.killed("m-rivals", "too vague")
    fam.opened("rivals", "m-rivals", 85)
    const rows = fam.rows(emptyMap())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      lens: "rivals",
      dedupeKey: "m-rivals",
      priority: 85,
      status: "queued",
      nodesAdded: 0,
      pageTierNodes: 0,
    })
  })

  it("rows keep open order — the seed first, whatever landed when", () => {
    const fam = new FamilyLedger()
    fam.opened("orientation", "orient:anchor.com", 100)
    fam.opened("rivals", "m-rivals", 90)
    fam.opened("substitutes", "m-subs", 95)
    fam.landed("m-subs", 2)
    fam.landed("orient:anchor.com", 1)
    expect(fam.rows(emptyMap()).map((r) => r.dedupeKey)).toEqual(["orient:anchor.com", "m-rivals", "m-subs"])
  })
})

describe("FamilyLedger.rows: pageTierNodes read lazily from the map's stamps", () => {
  it("counts each family's page-or-better contributions at rows() time, not at landing time", () => {
    const fam = new FamilyLedger()
    fam.opened("orientation", "orient:anchor.com", 100)
    fam.opened("rivals", "m-rivals", 90)
    fam.landed("m-rivals", 2)

    const map = new MapState("anchor.com")
    expect(fam.rows(map).map((r) => r.pageTierNodes)).toEqual([0, 0])

    // Stamps land after the landing — a later upgrade still counts, because
    // the number is computed from the live map when the scorecard asks.
    map.nodes.set("rival-one.com", node("rival-one.com", [{ writer: "m-rivals", tier: "page" }]))
    map.nodes.set(
      "rival-two.com",
      node("rival-two.com", [
        { writer: "m-rivals", tier: "own-page" },
        { writer: "orient:anchor.com", tier: "snippet" },
      ]),
    )
    const rows = fam.rows(map)
    expect(rows.find((r) => r.dedupeKey === "m-rivals")!.pageTierNodes).toBe(2)
    // The orientation stamp is snippet-tier: it does not count as a real answer.
    expect(rows.find((r) => r.dedupeKey === "orient:anchor.com")!.pageTierNodes).toBe(0)
  })

  it("a retracted node stops counting — the scorecard grades the map a reader gets", () => {
    const fam = new FamilyLedger()
    fam.opened("rivals", "m-rivals", 90)
    const map = new MapState("anchor.com")
    map.nodes.set("rival-one.com", node("rival-one.com", [{ writer: "m-rivals", tier: "page" }]))
    expect(fam.rows(map)[0]!.pageTierNodes).toBe(1)
    map.nodes.get("rival-one.com")!.retracted = { why: "a listicle, not a vendor" }
    expect(fam.rows(map)[0]!.pageTierNodes).toBe(0)
  })
})
