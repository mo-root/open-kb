import { describe, it, expect } from "vitest"
import { Board, type Mission, type MissionTier } from "../src/board.js"

const ALLOWANCES: Record<MissionTier, number> = { peek: 0.03, read: 0.1, dig: 0.25, harvest: 0.45 }

function mission(over: Partial<Mission> = {}): Mission {
  return {
    lens: "rivals",
    brief: "who else sells anti-bot bypass APIs",
    why: "the seed page names the category",
    priority: 80,
    tier: "read",
    dedupeKey: "rivals:anti-bot-bypass",
    ...over,
  }
}

describe("Board push and the two bands", () => {
  it("accepts a lead mission in the 61-100 band, not marked unreviewed", () => {
    const b = new Board()
    const r = b.push(mission({ priority: 61 }), "lead")
    expect(r.ok).toBe(true)
    const rows = b.residue()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.unreviewed).toBe(false)
  })

  it("accepts an investigator proposal in the 1-60 band, marked unreviewed", () => {
    const b = new Board()
    const r = b.push(mission({ priority: 60, dedupeKey: "k1" }), "investigator")
    expect(r.ok).toBe(true)
    expect(b.residue()[0]!.unreviewed).toBe(true)
  })

  it("rejects a lead priority below its band with a sentence naming the band", () => {
    const b = new Board()
    const r = b.push(mission({ priority: 60 }), "lead")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/61-100/)
    expect(b.residue()).toHaveLength(0)
  })

  it("rejects a lead priority above 100", () => {
    const b = new Board()
    expect(b.push(mission({ priority: 101 }), "lead").ok).toBe(false)
  })

  it("rejects an investigator priority above its band with a sentence naming the band", () => {
    const b = new Board()
    const r = b.push(mission({ priority: 61 }), "investigator")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/1-60/)
  })

  it("rejects an investigator priority below 1", () => {
    const b = new Board()
    expect(b.push(mission({ priority: 0 }), "investigator").ok).toBe(false)
  })

  it("keeps seeds on the mission when given", () => {
    const b = new Board()
    b.push(mission({ seeds: ["https://a.com/x"] }), "lead")
    expect(b.residue()[0]!.seeds).toEqual(["https://a.com/x"])
  })
})

describe("Board dedupe", () => {
  it("rejects an exact dedupeKey already queued, and the sentence names the key", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "rivals:x" }), "lead")
    const r = b.push(mission({ dedupeKey: "rivals:x", priority: 95 }), "lead")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("rivals:x")
    expect(b.residue()).toHaveLength(1)
  })

  it("rejects an exact dedupeKey already claimed, with a sentence saying it is being worked", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "rivals:x" }), "lead")
    b.popAffordable(1, ALLOWANCES)
    const r = b.push(mission({ dedupeKey: "rivals:x", priority: 40 }), "investigator")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("rivals:x")
  })

  it("dedupe is exact-string, never fuzzy: a near-identical key is a different question", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "rivals:anti-bot" }), "lead")
    expect(b.push(mission({ dedupeKey: "rivals:antibot", priority: 70 }), "lead").ok).toBe(true)
  })

  it("dedupes across bands: a proposal cannot restate a queued lead mission", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "k" }), "lead")
    expect(b.push(mission({ dedupeKey: "k", priority: 30 }), "investigator").ok).toBe(false)
  })
})

describe("Board popAffordable", () => {
  it("returns the highest-priority mission whose allowance fits", () => {
    const b = new Board()
    b.push(mission({ priority: 70, dedupeKey: "a" }), "lead")
    b.push(mission({ priority: 90, dedupeKey: "b" }), "lead")
    const { mission: m, skipped } = b.popAffordable(1, ALLOWANCES)
    expect(m?.dedupeKey).toBe("b")
    expect(skipped).toHaveLength(0)
  })

  it("scans DOWN past an unaffordable dig to a cheaper read, reporting the skip", () => {
    const b = new Board()
    b.push(mission({ priority: 84, tier: "dig", dedupeKey: "expensive" }), "lead")
    b.push(mission({ priority: 70, tier: "read", dedupeKey: "cheap" }), "lead")
    const { mission: m, skipped } = b.popAffordable(0.1, ALLOWANCES)
    expect(m?.dedupeKey).toBe("cheap")
    expect(skipped.map((s) => s.dedupeKey)).toEqual(["expensive"])
  })

  it("never promotes: the skipped item keeps its place for the next pop", () => {
    const b = new Board()
    b.push(mission({ priority: 84, tier: "dig", dedupeKey: "expensive" }), "lead")
    b.push(mission({ priority: 70, tier: "read", dedupeKey: "cheap" }), "lead")
    b.popAffordable(0.1, ALLOWANCES)
    // Money returned; the dig is next because it was never re-ranked, only passed over.
    const { mission: m } = b.popAffordable(1, ALLOWANCES)
    expect(m?.dedupeKey).toBe("expensive")
  })

  it("returns no mission and lists everything scanned when nothing fits", () => {
    const b = new Board()
    b.push(mission({ priority: 90, tier: "dig", dedupeKey: "a" }), "lead")
    b.push(mission({ priority: 50, tier: "read", dedupeKey: "b" }), "investigator")
    const { mission: m, skipped } = b.popAffordable(0.01, ALLOWANCES)
    expect(m).toBeUndefined()
    expect(skipped.map((s) => s.dedupeKey)).toEqual(["a", "b"])
    // Nothing was consumed: the board still holds both.
    expect(b.residue()).toHaveLength(2)
  })

  it("returns nothing on an empty board", () => {
    const b = new Board()
    expect(b.popAffordable(1, ALLOWANCES)).toEqual({ mission: undefined, skipped: [] })
  })

  it("claims what it returns: the popped key leaves residue and rejects a duplicate push", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "k" }), "lead")
    b.popAffordable(1, ALLOWANCES)
    expect(b.residue()).toHaveLength(0)
    expect(b.push(mission({ dedupeKey: "k" }), "lead").ok).toBe(false)
  })

  it("breaks priority ties by insertion order, deterministically", () => {
    const b = new Board()
    b.push(mission({ priority: 80, dedupeKey: "first" }), "lead")
    b.push(mission({ priority: 80, dedupeKey: "second" }), "lead")
    b.push(mission({ priority: 80, dedupeKey: "third" }), "lead")
    expect(b.popAffordable(1, ALLOWANCES).mission?.dedupeKey).toBe("first")
    expect(b.popAffordable(1, ALLOWANCES).mission?.dedupeKey).toBe("second")
    expect(b.popAffordable(1, ALLOWANCES).mission?.dedupeKey).toBe("third")
  })

  it("works proposals only when nothing better exists: the bands order themselves", () => {
    const b = new Board()
    b.push(mission({ priority: 55, dedupeKey: "proposal" }), "investigator")
    b.push(mission({ priority: 61, dedupeKey: "lead-item" }), "lead")
    expect(b.popAffordable(1, ALLOWANCES).mission?.dedupeKey).toBe("lead-item")
    expect(b.popAffordable(1, ALLOWANCES).mission?.dedupeKey).toBe("proposal")
  })
})

describe("Board claim and release", () => {
  it("claims a queued mission by key", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "k" }), "lead")
    expect(b.claim("k").ok).toBe(true)
    expect(b.residue()).toHaveLength(0)
  })

  it("refuses to claim a key that is not queued, with a sentence", () => {
    const b = new Board()
    const r = b.claim("ghost")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("ghost")
  })

  it("refuses to claim an already-claimed key", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "k" }), "lead")
    b.claim("k")
    expect(b.claim("k").ok).toBe(false)
  })

  it("release returns a claimed mission to the queue with its original tie-break intact", () => {
    const b = new Board()
    b.push(mission({ priority: 80, dedupeKey: "first" }), "lead")
    b.push(mission({ priority: 80, dedupeKey: "second" }), "lead")
    b.claim("first")
    expect(b.release("first").ok).toBe(true)
    // Released, it is still ahead of "second" at equal priority: insertion order survives.
    expect(b.popAffordable(1, ALLOWANCES).mission?.dedupeKey).toBe("first")
  })

  it("release of an unclaimed key refuses with a sentence", () => {
    const b = new Board()
    expect(b.release("ghost").ok).toBe(false)
  })

  it("a released mission's key dedupes again as queued", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "k" }), "lead")
    b.claim("k")
    b.release("k")
    expect(b.push(mission({ dedupeKey: "k" }), "lead").ok).toBe(false)
  })
})

describe("Board promote and kill (lead review of proposals)", () => {
  it("promote re-ranks a proposal and clears its unreviewed flag", () => {
    const b = new Board()
    b.push(mission({ priority: 40, dedupeKey: "p" }), "investigator")
    b.push(mission({ priority: 70, dedupeKey: "lead-item" }), "lead")
    expect(b.promote("p", 85).ok).toBe(true)
    const popped = b.popAffordable(1, ALLOWANCES).mission
    expect(popped?.dedupeKey).toBe("p")
    expect(popped?.priority).toBe(85)
    expect(popped?.unreviewed).toBe(false)
  })

  it("promote refuses a priority outside 1-100", () => {
    const b = new Board()
    b.push(mission({ priority: 40, dedupeKey: "p" }), "investigator")
    expect(b.promote("p", 0).ok).toBe(false)
    expect(b.promote("p", 101).ok).toBe(false)
  })

  it("promote refuses a key that is not queued", () => {
    const b = new Board()
    expect(b.promote("ghost", 80).ok).toBe(false)
  })

  it("promote refuses a claimed mission: it is already being worked", () => {
    const b = new Board()
    b.push(mission({ dedupeKey: "k" }), "lead")
    b.claim("k")
    const r = b.promote("k", 90)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("k")
  })

  it("kill removes a queued proposal; it no longer ships in residue", () => {
    const b = new Board()
    b.push(mission({ priority: 30, dedupeKey: "p" }), "investigator")
    expect(b.kill("p", "restates the seed question").ok).toBe(true)
    expect(b.residue()).toHaveLength(0)
  })

  it("a killed key may be pushed again: exact dedupe guards queued and claimed only", () => {
    const b = new Board()
    b.push(mission({ priority: 30, dedupeKey: "p" }), "investigator")
    b.kill("p", "too vague")
    expect(b.push(mission({ priority: 45, dedupeKey: "p" }), "investigator").ok).toBe(true)
  })

  it("kill refuses a key that is not queued, and refuses a claimed mission", () => {
    const b = new Board()
    expect(b.kill("ghost", "x").ok).toBe(false)
    b.push(mission({ dedupeKey: "k" }), "lead")
    b.claim("k")
    expect(b.kill("k", "x").ok).toBe(false)
  })
})

describe("Board residue", () => {
  it("ships every unclaimed item ranked by priority, ties in insertion order", () => {
    const b = new Board()
    b.push(mission({ priority: 70, dedupeKey: "a", why: "first why" }), "lead")
    b.push(mission({ priority: 90, dedupeKey: "b", why: "second why" }), "lead")
    b.push(mission({ priority: 70, dedupeKey: "c", why: "third why" }), "lead")
    b.push(mission({ priority: 20, dedupeKey: "d", why: "fourth why" }), "investigator")
    b.claim("b")
    const rows = b.residue()
    expect(rows.map((r) => r.dedupeKey)).toEqual(["a", "c", "d"])
    expect(rows[0]!.priority).toBe(70)
    expect(rows[0]!.why).toBe("first why")
    expect(rows[2]!.unreviewed).toBe(true)
  })

  it("is empty on a fresh board", () => {
    expect(new Board().residue()).toEqual([])
  })
})
