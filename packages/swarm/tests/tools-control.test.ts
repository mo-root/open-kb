import { describe, it, expect } from "vitest"
import { Board, Ledger, ALLOWANCES, type Mission, type MissionTier } from "@open-kb/core"
import {
  spawnTool,
  proposeTool,
  nextTool,
  finishTool,
  reviewTool,
  newRunControl,
  type ControlCtx,
  type FamilyEvent,
} from "../src/index.js"

const mission = (dedupeKey: string, over: Partial<Mission> = {}): Mission => ({
  lens: "rivals",
  brief: `who else sells this: ${dedupeKey}`,
  why: "the registry will name licensed firms no comparison content lists",
  priority: 80,
  tier: "read",
  dedupeKey,
  ...over,
})

function ctxOf(ceilingUsd = 1.5): ControlCtx {
  return { board: new Board(), ledger: new Ledger(ceilingUsd), control: newRunControl() }
}

describe("spawnTool", () => {
  it("funds missions in the lead's stated order, each holding its tier's allowance", () => {
    const ctx = ctxOf()
    const r = spawnTool(ctx, {
      missions: [mission("a", { tier: "dig" }), mission("b", { tier: "peek" })],
      why: "open the market",
    })
    expect(r.queued).toEqual([
      { i: 0, allowanceUsd: ALLOWANCES.dig },
      { i: 1, allowanceUsd: ALLOWANCES.peek },
    ])
    expect(r.refused).toEqual([])
    expect(r.poolLeftUsd).toBeCloseTo(1.35 - ALLOWANCES.dig - ALLOWANCES.peek)
    expect(ctx.board.residue().map((m) => m.dedupeKey)).toEqual(["a", "b"])
    expect(ctx.control.claims.get("a")).toBeDefined()
    expect(ctx.control.claims.get("b")).toBeDefined()
  })

  it("an unaffordable tier is refused with the exact re-tier sentence, and cheaper later items still fund", () => {
    // Ceiling 0.30: finish reserve 0.12, spendable 0.18.
    const ctx = ctxOf(0.3)
    const r = spawnTool(ctx, {
      missions: [mission("a", { tier: "read" }), mission("b", { tier: "dig" }), mission("c", { tier: "peek" })],
      why: "t",
    })
    expect(r.queued.map((q) => q.i)).toEqual([0, 2])
    expect(r.refused).toEqual([{ i: 1, reason: "the pool no longer funds a dig; re-tier it or drop it" }])
    expect(r.poolLeftUsd).toBeCloseTo(0.18 - ALLOWANCES.read - ALLOWANCES.peek)
  })

  it("the stated order is load-bearing: an early dig takes the money a later read wanted", () => {
    // Ceiling 0.45: finish reserve 0.12, spendable 0.33 — room for the dig
    // (0.25) OR the read (0.10) after it, not both.
    const ctx = ctxOf(0.45)
    const r = spawnTool(ctx, {
      missions: [mission("expensive", { tier: "dig" }), mission("cheap", { tier: "read" })],
      why: "t",
    })
    expect(r.queued.map((q) => q.i)).toEqual([0])
    expect(r.refused[0]).toMatchObject({ i: 1 })
  })

  it("a board refusal hands the reservation straight back", () => {
    const ctx = ctxOf()
    spawnTool(ctx, { missions: [mission("a")], why: "t" })
    const before = ctx.ledger.spendable()
    const dup = spawnTool(ctx, { missions: [mission("a")], why: "again" })
    expect(dup.queued).toEqual([])
    expect(dup.refused[0]!.reason).toContain('"a" is already queued')
    expect(ctx.ledger.spendable()).toBeCloseTo(before) // no money leaked into a refused push
  })

  it("a priority outside the lead's band is the board's sentence, money refunded", () => {
    const ctx = ctxOf()
    const r = spawnTool(ctx, { missions: [mission("low", { priority: 40 })], why: "t" })
    expect(r.refused[0]!.reason).toContain("the lead ranks 61-100")
    expect(r.poolLeftUsd).toBeCloseTo(1.35)
  })

  it("a tier money does not know is refused in words", () => {
    const ctx = ctxOf()
    const r = spawnTool(ctx, { missions: [mission("x", { tier: "excavate" as MissionTier })], why: "t" })
    expect(r.refused[0]!.reason).toBe('"excavate" is not a tier money knows; use peek, read or dig')
  })

  it("nothing is funded after finish", () => {
    const ctx = ctxOf()
    finishTool(ctx, { reason: "mapped", summary: "done", unresolved: [] })
    const r = spawnTool(ctx, { missions: [mission("late")], why: "t" })
    expect(r.queued).toEqual([])
    expect(r.refused[0]!.reason).toContain("the run is finishing (mapped)")
  })
})

describe("proposeTool", () => {
  it("queues into the 1-60 band unreviewed, reserving nothing", () => {
    const ctx = ctxOf()
    const r = proposeTool(ctx, { missions: [mission("found", { priority: 30 })] })
    expect(r.queued).toBe(1)
    expect(r.deduped).toEqual([])
    expect(r.poolLeftUsd).toBeCloseTo(1.35) // proposals cost money only when popped
    expect(ctx.board.residue()[0]).toMatchObject({ dedupeKey: "found", unreviewed: true })
  })

  it("reports every dedupe collision and band violation by key, in the board's words", () => {
    const ctx = ctxOf()
    spawnTool(ctx, { missions: [mission("taken")], why: "t" })
    const r = proposeTool(ctx, {
      missions: [mission("taken", { priority: 20 }), mission("high", { priority: 90 })],
    })
    expect(r.queued).toBe(0)
    expect(r.deduped).toHaveLength(2)
    expect(r.deduped[0]!.reason).toContain('"taken" is already queued')
    expect(r.deduped[1]!.reason).toContain("a proposal ranks 1-60")
  })

  it("wake:true clears the lead's re-entry condition", () => {
    const ctx = ctxOf()
    nextTool(ctx, { after: { landings: 3 }, why: "let the first wave land" })
    expect(ctx.control.next).not.toBeNull()
    proposeTool(ctx, { missions: [mission("urgent", { priority: 55 })], wake: true })
    expect(ctx.control.next).toBeNull()
    expect(ctx.control.wakes).toBe(1)
  })

  it("a closed board answers in words after finish", () => {
    const ctx = ctxOf()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    const r = proposeTool(ctx, { missions: [mission("late", { priority: 10 })], wake: true })
    expect(r.queued).toBe(0)
    expect(r.deduped[0]!.reason).toContain("the board is closed")
    expect(ctx.control.wakes).toBe(0)
  })
})

describe("reviewTool", () => {
  it("promote lifts a proposal into the upper band, clears unreviewed, and popAffordable reaches it", () => {
    const ctx = ctxOf()
    proposeTool(ctx, { missions: [mission("found", { priority: 30 }), mission("other", { priority: 45 })] })
    const r = reviewTool(ctx, { promote: [{ dedupeKey: "found", priority: 86 }], why: "the whole map says so" })
    expect(r.promoted).toEqual([{ dedupeKey: "found", ok: true }])
    expect(r.killed).toEqual([])
    expect(ctx.board.residue()[0]).toMatchObject({ dedupeKey: "found", priority: 86, unreviewed: false })
    const popped = ctx.board.popAffordable(ctx.ledger.spendable(), ALLOWANCES)
    expect(popped.mission?.dedupeKey).toBe("found")
  })

  it("promote moves no money", () => {
    const ctx = ctxOf()
    proposeTool(ctx, { missions: [mission("found", { priority: 30 })] })
    const before = ctx.ledger.spendable()
    const r = reviewTool(ctx, { promote: [{ dedupeKey: "found", priority: 70 }], why: "t" })
    expect(ctx.ledger.spendable()).toBeCloseTo(before)
    expect(r.poolLeftUsd).toBeCloseTo(before)
  })

  it("an out-of-band promote target gets the board's own band sentence, and the item is untouched", () => {
    const ctx = ctxOf()
    proposeTool(ctx, { missions: [mission("found", { priority: 30 })] })
    const r = reviewTool(ctx, { promote: [{ dedupeKey: "found", priority: 50 }], why: "t" })
    expect(r.promoted).toEqual([
      { dedupeKey: "found", ok: false, reason: "the lead ranks 61-100; priority 50 belongs in the proposal band" },
    ])
    expect(ctx.board.residue()[0]).toMatchObject({ dedupeKey: "found", priority: 30, unreviewed: true })
  })

  it("promote refuses an unknown key and a claimed mission, each in the board's words", () => {
    const ctx = ctxOf()
    spawnTool(ctx, { missions: [mission("running")], why: "t" })
    ctx.board.claim("running")
    const r = reviewTool(ctx, {
      promote: [
        { dedupeKey: "ghost", priority: 80 },
        { dedupeKey: "running", priority: 80 },
      ],
      why: "t",
    })
    expect(r.promoted[0]!.reason).toBe('"ghost" is not queued; nothing to promote')
    expect(r.promoted[1]!.reason).toContain("a running mission cannot be re-ranked")
  })

  it("killing a funded queued mission settles its reservation back to the pool in the same call", () => {
    const ctx = ctxOf()
    spawnTool(ctx, { missions: [mission("dead", { tier: "read" })], why: "t" })
    expect(ctx.ledger.spendable()).toBeCloseTo(1.35 - ALLOWANCES.read)
    const r = reviewTool(ctx, {
      kill: [{ dedupeKey: "dead", because: "the rivals lens already asks this" }],
      why: "duplicate angle",
    })
    expect(r.killed).toEqual([{ dedupeKey: "dead", ok: true }])
    expect(r.poolLeftUsd).toBeCloseTo(1.35) // the read's $0.10 returned before the tool answered
    expect(ctx.ledger.spendable()).toBeCloseTo(1.35)
    expect(ctx.control.claims.has("dead")).toBe(false)
    expect(ctx.board.residue()).toHaveLength(0)
  })

  it("killing an unfunded proposal moves no money", () => {
    const ctx = ctxOf()
    proposeTool(ctx, { missions: [mission("idea", { priority: 20 })] })
    const r = reviewTool(ctx, { kill: [{ dedupeKey: "idea", because: "dead angle" }], why: "t" })
    expect(r.killed).toEqual([{ dedupeKey: "idea", ok: true }])
    expect(ctx.ledger.spendable()).toBeCloseTo(1.35)
  })

  it("a claimed mission is not killable: the sentence says review does not abort lanes, the money stays held", () => {
    const ctx = ctxOf()
    spawnTool(ctx, { missions: [mission("running", { tier: "read" })], why: "t" })
    ctx.board.claim("running")
    const r = reviewTool(ctx, { kill: [{ dedupeKey: "running", because: "changed my mind" }], why: "t" })
    expect(r.killed[0]!.ok).toBe(false)
    expect(r.killed[0]!.reason).toContain('"running" is already claimed')
    expect(r.killed[0]!.reason).toContain("review does not abort lanes")
    expect(ctx.ledger.spendable()).toBeCloseTo(1.35 - ALLOWANCES.read) // still reserved for the lane
    expect(ctx.control.claims.has("running")).toBe(true)
  })

  it("an unknown key is refused in words", () => {
    const ctx = ctxOf()
    const r = reviewTool(ctx, { kill: [{ dedupeKey: "ghost", because: "x" }], why: "t" })
    expect(r.killed).toEqual([{ dedupeKey: "ghost", ok: false, reason: '"ghost" is not queued; nothing to kill' }])
  })

  it("a killed key leaves the dedupe universe: a re-phrased question may return", () => {
    const ctx = ctxOf()
    spawnTool(ctx, { missions: [mission("q")], why: "t" })
    reviewTool(ctx, { kill: [{ dedupeKey: "q", because: "too vague" }], why: "t" })
    const again = proposeTool(ctx, { missions: [mission("q", { priority: 40 })] })
    expect(again.queued).toBe(1)
    expect(again.deduped).toEqual([])
  })
})

describe("the family seam: onFamilyEvent", () => {
  const listening = (ceilingUsd = 1.5): { ctx: ControlCtx; events: FamilyEvent[] } => {
    const events: FamilyEvent[] = []
    const ctx = { ...ctxOf(ceilingUsd), onFamilyEvent: (e: FamilyEvent) => events.push(e) }
    return { ctx, events }
  }

  it("spawn emits opened for each queued mission, in the lead's order, and nothing for a refusal", () => {
    // Ceiling 0.30: spendable 0.18 — the read funds, the dig is refused.
    const { ctx, events } = listening(0.3)
    spawnTool(ctx, {
      missions: [
        mission("m-rivals", { lens: "rivals", priority: 90 }),
        mission("m-deep", { lens: "depth", tier: "dig", priority: 85 }),
      ],
      why: "t",
    })
    expect(events).toEqual([{ kind: "opened", lens: "rivals", dedupeKey: "m-rivals", priority: 90 }])
  })

  it("review kill emits killed carrying the lead's because; a refused kill emits nothing", () => {
    const { ctx, events } = listening()
    spawnTool(ctx, { missions: [mission("dead"), mission("running")], why: "t" })
    ctx.board.claim("running")
    events.length = 0
    reviewTool(ctx, {
      kill: [
        { dedupeKey: "dead", because: "the rivals lens already asks this" },
        { dedupeKey: "running", because: "changed my mind" }, // claimed: refused, no event
        { dedupeKey: "ghost", because: "x" }, // unknown: refused, no event
      ],
      why: "t",
    })
    expect(events).toEqual([{ kind: "killed", dedupeKey: "dead", because: "the rivals lens already asks this" }])
  })

  it("promote into the lead band emits opened with the row's own lens and its NEW priority", () => {
    const { ctx, events } = listening()
    proposeTool(ctx, { missions: [mission("found", { lens: "vendors", priority: 30 })] })
    expect(events).toEqual([]) // a proposal is not a family
    reviewTool(ctx, { promote: [{ dedupeKey: "found", priority: 70 }], why: "the whole map says so" })
    expect(events).toEqual([{ kind: "opened", lens: "vendors", dedupeKey: "found", priority: 70 }])
  })

  it("a refused promote emits nothing — the band sentence already answered", () => {
    const { ctx, events } = listening()
    proposeTool(ctx, { missions: [mission("found", { priority: 30 })] })
    reviewTool(ctx, {
      promote: [
        { dedupeKey: "found", priority: 50 }, // out of the lead's band
        { dedupeKey: "ghost", priority: 80 }, // unknown key
      ],
      why: "t",
    })
    expect(events).toEqual([])
  })

  it("a ctx without the hook behaves exactly as before", () => {
    const ctx = ctxOf()
    const r = spawnTool(ctx, { missions: [mission("a")], why: "t" })
    expect(r.queued).toHaveLength(1)
    expect(reviewTool(ctx, { kill: [{ dedupeKey: "a", because: "b" }], why: "t" }).killed[0]!.ok).toBe(true)
  })
})

describe("nextTool", () => {
  it("records the lead's re-entry condition and says what it waits for", () => {
    const ctx = ctxOf()
    const r = nextTool(ctx, { after: { landings: 3, seconds: 20 }, why: "let the wave land" })
    expect(r).toMatchObject({ ok: true, waitingFor: "waking after 3 landings or 20s, whichever comes first" })
    expect(ctx.control.next).toEqual({ landings: 3, seconds: 20, why: "let the wave land" })
  })

  it("a condition that names nothing is refused with the fix", () => {
    const ctx = ctxOf()
    const r = nextTool(ctx, { after: {}, why: "t" })
    expect(r).toMatchObject({ ok: false, reason: "say what wakes you: landings, seconds, or both" })
    expect(ctx.control.next).toBeNull()
  })

  it("a later next replaces the earlier one", () => {
    const ctx = ctxOf()
    nextTool(ctx, { after: { landings: 3 }, why: "first" })
    nextTool(ctx, { after: { seconds: 45 }, why: "second" })
    expect(ctx.control.next).toEqual({ seconds: 45, why: "second" })
  })
})

describe("finishTool", () => {
  it("marks the run ending and clears any pending re-entry", () => {
    const ctx = ctxOf()
    nextTool(ctx, { after: { seconds: 30 }, why: "t" })
    const r = finishTool(ctx, {
      reason: "the remaining gaps need a phone call, not a search",
      summary: "14 companies across three markets; the registry lens carried the run",
      unresolved: ["who licenses the two firms the registry lists without websites"],
    })
    expect(r.ok).toBe(true)
    expect(ctx.control.finished).toMatchObject({ reason: "the remaining gaps need a phone call, not a search" })
    expect(ctx.control.finished!.unresolved).toHaveLength(1)
    expect(ctx.control.next).toBeNull()
  })

  it("the first finish stands; the second is told so", () => {
    const ctx = ctxOf()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    const again = finishTool(ctx, { reason: "changed my mind", summary: "x", unresolved: [] })
    expect(again).toMatchObject({ ok: false })
    if (!again.ok) expect(again.reason).toBe("the run is already finishing (mapped); the first finish stands")
    expect(ctx.control.finished!.reason).toBe("mapped")
  })

  it("every control return carries poolLeftUsd", () => {
    const ctx = ctxOf()
    expect(spawnTool(ctx, { missions: [], why: "t" }).poolLeftUsd).toBeCloseTo(1.35)
    expect(proposeTool(ctx, { missions: [] }).poolLeftUsd).toBeCloseTo(1.35)
    expect(nextTool(ctx, { after: { landings: 1 }, why: "t" }).poolLeftUsd).toBeCloseTo(1.35)
    expect(reviewTool(ctx, { why: "t" }).poolLeftUsd).toBeCloseTo(1.35)
    expect(finishTool(ctx, { reason: "r", summary: "s", unresolved: [] }).poolLeftUsd).toBeCloseTo(1.35)
  })
})
