import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { Board, Ledger, ALLOWANCES, type Mission, type MissionTier } from "@open-kb/core"
import {
  spawnTool,
  proposeTool,
  nextTool,
  finishTool,
  reviewTool,
  newRunControl,
  GATE_REFUSAL_TAIL,
  GATE_NO_WORK_SENTENCE,
  GATE_MAX_REFUSALS,
  type ControlCtx,
  type FamilyEvent,
  type GateReading,
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

/** The LEAD's own control ctx — the one the finish gate charges. The
 *  harness's three (seed, family floor, sweep handoff) and the
 *  investigator's are exercised where they are built: orchestrator.test.ts. */
function ctxOf(ceilingUsd = 1.5): ControlCtx {
  return { board: new Board(), ledger: new Ledger(ceilingUsd), control: newRunControl(), commissioner: "lead" }
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
    expect(r.refused[0]!.reason).toBe('"excavate" is not a tier money knows; use peek, read, dig or harvest')
  })

  it("nothing is funded after finish", () => {
    const ctx = ctxOf()
    finishTool(ctx, { reason: "mapped", summary: "done", unresolved: [] })
    const r = spawnTool(ctx, { missions: [mission("late")], why: "t" })
    expect(r.queued).toEqual([])
    expect(r.refused[0]!.reason).toContain("the run is finishing (mapped)")
  })

  it("records WHO commissioned each queued mission, and nothing for a refusal", () => {
    // The discriminator the finish gate's landing half reads. It comes off the
    // CTX, not off the Mission — a Mission is a value the model writes — so
    // the same tool called through the family floor's ctx tags differently.
    const lead = ctxOf()
    spawnTool(lead, { missions: [mission("mine"), mission("low", { priority: 40 })], why: "t" })
    expect([...lead.control.commissionedBy]).toEqual([["mine", "lead"]])

    const floor: ControlCtx = { ...ctxOf(), commissioner: "family-floor" }
    spawnTool(floor, { missions: [mission("family:market", { priority: 70 })], why: "the floor" })
    expect(floor.control.commissionedBy.get("family:market")).toBe("family-floor")
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

  it("a promote is a commission, and a kill hands the key back to whoever pushes it next", () => {
    // A proposal nobody promoted stays the proposer's: it can be popped and
    // land without the lead ever seeing it, and that landing must not pay the
    // lead's debt. Ranking it into the 61-100 band with whole-map context is
    // the lead spending its own pool, and does — an UNREVIEWED row holds no
    // reservation (proposeTool reserves nothing) and sits below every funded
    // item, so promoting it commits money nothing else would have spent. That
    // flag is the discriminator; the test below it is the other direction.
    const lane: ControlCtx = { ...ctxOf(), commissioner: "investigator" }
    proposeTool(lane, { missions: [mission("theirs", { priority: 30 }), mission("untouched", { priority: 20 })] })
    expect(lane.control.commissionedBy.get("theirs")).toBe("investigator")

    const boss: ControlCtx = { ...lane, commissioner: "lead" }
    reviewTool(boss, { promote: [{ dedupeKey: "theirs", priority: 80 }], why: "the whole map says so" })
    expect(boss.control.commissionedBy.get("theirs")).toBe("lead")
    expect(boss.control.commissionedBy.get("untouched")).toBe("investigator")

    // A killed key leaves the dedupe universe, so it leaves the record too.
    reviewTool(boss, { kill: [{ dedupeKey: "untouched", because: "a dead angle" }], why: "t" })
    expect(boss.control.commissionedBy.has("untouched")).toBe(false)
  })

  it("a promote of a row the HARNESS pushed is a re-label, not a commission — the free re-rank", () => {
    // The bypass this closes. Every harness row — the seed dig, the family
    // floor's deck, the sweep handoff — goes on the board through
    // `board.push(m, "lead")`, so it arrives ALREADY FUNDED, already in the
    // 61-100 band, and will be popped whatever the lead does. `Board.promote`
    // mutates `priority` and nothing else. So re-ranking one changes nothing
    // about whether the work happens — only whose name is on it — and the
    // finish gate then charged the lead's refusal to the harness's own lane.
    const harness: ControlCtx = { ...ctxOf(), commissioner: "sweep" }
    spawnTool(harness, { missions: [mission("verify:rival.com", { priority: 70, tier: "peek" })], why: "the handoff" })
    expect(harness.control.commissionedBy.get("verify:rival.com")).toBe("sweep")
    // The premise, pinned: it is already funded, already in the band, and NOT
    // unreviewed — the three facts that make the promote a no-op.
    expect(harness.control.claims.has("verify:rival.com")).toBe(true)
    expect(harness.board.residue()[0]).toMatchObject({ priority: 70, unreviewed: false })

    const boss: ControlCtx = { ...harness, commissioner: "lead" }
    const before = boss.ledger.spendable()
    const r = reviewTool(boss, { promote: [{ dedupeKey: "verify:rival.com", priority: 95 }], why: "mine now" })

    // The re-rank itself still works, and still costs nothing: the board is
    // the lead's to order. Only the NAME does not move.
    expect(r.promoted).toEqual([{ dedupeKey: "verify:rival.com", ok: true }])
    expect(boss.board.residue()[0]).toMatchObject({ priority: 95, unreviewed: false })
    expect(boss.ledger.spendable()).toBeCloseTo(before)
    expect(boss.control.commissionedBy.get("verify:rival.com")).toBe("sweep")
  })

  it("a kill and a re-spawn of the same key is a re-label too — the name survives the kill", () => {
    // The same bypass through the other free verb, and a cheaper one: the
    // kill releases the harness's reservation, drops the commissioner and
    // frees the key, so the re-spawn re-reserves the same allowance for the
    // same question and used to stamp it `lead`. The run does exactly the
    // work it was already going to do.
    const harness: ControlCtx = { ...ctxOf(), commissioner: "sweep" }
    spawnTool(harness, { missions: [mission("gap:unknowns-2", { priority: 62 })], why: "the handoff" })
    const boss: ControlCtx = { ...harness, commissioner: "lead" }
    const before = boss.ledger.spendable()

    reviewTool(boss, { kill: [{ dedupeKey: "gap:unknowns-2", because: "I want this one myself" }], why: "t" })
    // The premises: the key really left the board and the money really came
    // back, which is what makes the re-spawn affordable and identical.
    expect(boss.board.residue()).toEqual([])
    expect(boss.ledger.spendable()).toBeCloseTo(before + ALLOWANCES.read)
    expect(boss.control.commissionedBy.has("gap:unknowns-2")).toBe(false)

    const again = spawnTool(boss, { missions: [mission("gap:unknowns-2", { priority: 62 })], why: "mine now" })
    expect(again.queued).toEqual([{ i: 0, allowanceUsd: ALLOWANCES.read }]) // the push took
    expect(boss.ledger.spendable()).toBeCloseTo(before) // and paid the same allowance again
    expect(boss.control.commissionedBy.get("gap:unknowns-2")).toBe("sweep")
    expect(boss.control.commissionerBeforeKill.get("gap:unknowns-2")).toBe("sweep") // and where that came from
  })

  it("...but the lead's OWN killed key comes back as the lead's, and a different question always does", () => {
    // The pin is one-directional and keyed on the question's name: it can only
    // ever keep a landing OFF the lead's tab. A lead that kills its own
    // mission and asks it again is funding it again, and a lead that kills a
    // harness row and asks something ELSE has re-aimed the pool — both are
    // commissions, and neither reads a pin, because nothing non-lead was ever
    // killed under those keys.
    const harness: ControlCtx = { ...ctxOf(), commissioner: "family-floor" }
    spawnTool(harness, { missions: [mission("family:buyers")], why: "the floor" })
    const boss: ControlCtx = { ...harness, commissioner: "lead" }
    spawnTool(boss, { missions: [mission("mine")], why: "my own question" })

    reviewTool(boss, {
      kill: [
        { dedupeKey: "family:buyers", because: "the sweep already settled this" },
        { dedupeKey: "mine", because: "badly phrased" },
      ],
      why: "clearing the board",
    })
    expect(boss.control.commissionerBeforeKill.get("family:buyers")).toBe("family-floor")
    expect(boss.control.commissionerBeforeKill.has("mine")).toBe(false) // the lead's own kill pins nothing

    spawnTool(boss, { missions: [mission("mine"), mission("who-licenses-them")], why: "again, and something new" })
    expect(boss.control.commissionedBy.get("mine")).toBe("lead")
    expect(boss.control.commissionedBy.get("who-licenses-them")).toBe("lead")
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

  it("the first accepted finish stands; the second is told so", () => {
    const ctx = ctxOf()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    const again = finishTool(ctx, { reason: "changed my mind", summary: "x", unresolved: [] })
    expect(again).toMatchObject({ ok: false })
    if (!again.ok) expect(again.reason).toBe("the run is already finishing (mapped); the first accepted finish stands")
    expect(ctx.control.finished!.reason).toBe("mapped")
  })

  it("without a scorecard thunk the gate record stays null and the finish stands first time", () => {
    const ctx = ctxOf()
    const r = finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toBeNull()
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

describe("finishTool: the scorecard gate", () => {
  const OBJ_A = "2 of 3 planned families have zero page-tier nodes (m1, m2)"
  const OBJ_B = "the pool holds $3.55 of $5.00"

  /**
   * A ctx whose gate reads LIVE state the test can move between finishes —
   * the way the orchestrator's thunk reads what the loop records for its own
   * reasons. `work.push(...)` is a page the LEAD gained or a mission THE LEAD
   * COMMISSIONED coming home; nothing else in these tests can move it, which
   * is the point, and it is append-only here because it is append-only there.
   * `live.turns += 1` is the metered lead turn passing: the gate's budget is
   * per turn, so a test that never advances it is a test about ONE turn.
   */
  const gatedCtx = (
    over: Partial<Omit<GateReading, "work">> = {},
    ceilingUsd = 1.5,
  ): { ctx: ControlCtx; live: Omit<GateReading, "work">; work: string[] } => {
    const live: Omit<GateReading, "work"> = {
      objections: [OBJ_A, OBJ_B],
      turns: 5,
      turnCap: 24,
      disarmed: false,
      ...over,
    }
    const work: string[] = []
    const ctx: ControlCtx = { ...ctxOf(ceilingUsd), scorecard: () => ({ ...live, work: [...work] }) }
    return { ctx, live, work }
  }

  it("an armed first finish is refused: objection sentences verbatim, the finish does not take effect", () => {
    const { ctx } = gatedCtx()
    nextTool(ctx, { after: { seconds: 30 }, why: "t" })
    const r = finishTool(ctx, { reason: "mapped", summary: "done early", unresolved: ["my own gap"] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(`${OBJ_A}; ${OBJ_B}${GATE_REFUSAL_TAIL}`)
    if (!r.ok) expect(r.reason).toContain("; words do not clear these — fetch a page")
    // The finish did NOT take effect, and the answering turn is IMMEDIATE: the
    // gate clears the lead's standing 30s condition and never installs one of
    // its own. A gate that parked the lead on a landing could outlive a short
    // wall and hand the ending to the harness.
    expect(ctx.control.finished).toBeNull()
    expect(ctx.control.next).toBeNull()
    // The exchange is on the record, the refused conclusion stashed whole, the
    // work counter the next finish will be measured against pinned, and the
    // turn it was spoken in remembered so a repeat call cannot spend another.
    expect(ctx.control.gate).toEqual({
      refusals: 1,
      objections: [OBJ_A, OBJ_B],
      carried: [],
      refusedFinish: { reason: "mapped", summary: "done early", unresolved: ["my own gap"] },
      workAtRefusal: 0,
      workAnswered: 0,
      answeredBy: [],
      refusedAtTurn: 5,
      stood: null,
    })
  })

  it("the refusal never parks the lead: a live board does not turn the answer into a wait", () => {
    // The branch this replaces installed `{landings: 1}` when work was already
    // commissioned. It was a no-op for the outcome (the waking landing is
    // itself the payment) and a real risk against a wall shorter than the 45s
    // warning band: nothing else arms a timer for a landings-only condition.
    const { ctx } = gatedCtx()
    spawnTool(ctx, { missions: [mission("live-lane")], why: "a lane is already running" })
    nextTool(ctx, { after: { landings: 6 }, why: "let the whole wave land" })
    expect(finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] }).ok).toBe(false)
    expect(ctx.control.next).toBeNull()
  })

  it("spawn stays open after a refusal — nothing is finishing", () => {
    const { ctx } = gatedCtx()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    const r = spawnTool(ctx, { missions: [mission("late-lane")], why: "answer the objection with work" })
    expect(r.queued).toHaveLength(1)
    expect(r.refused).toEqual([])
  })

  // ── the refusal is priced in work ─────────────────────────────────────────

  it("a restated objection does not clear the refusal: the next turn's finish is refused too, naming the missing work", () => {
    // The measured failure, exactly: runs/swarm-brightdata-com-202608060833
    // refused the turn-19 finish at seq 371 and the lead pasted both objection
    // sentences into unresolved and called finish again in turn 20, 9.6s later,
    // having fetched nothing and landed nothing. The old gate accepted that.
    const { ctx, live } = gatedCtx()
    finishTool(ctx, { reason: "mapped", summary: "first try", unresolved: [] })
    live.turns += 1 // the turn the refusal bought, spent on words
    const r = finishTool(ctx, {
      reason: "mapped",
      summary: "concluding as directed",
      unresolved: [OBJ_A, OBJ_B], // both readings carried verbatim, nothing bought
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(`${GATE_NO_WORK_SENTENCE}; ${OBJ_A}; ${OBJ_B}${GATE_REFUSAL_TAIL}`)
    expect(ctx.control.finished).toBeNull()
    expect(ctx.control.gate).toMatchObject({ refusals: 2, workAtRefusal: 0, workAnswered: 0, refusedAtTurn: 6 })
    // The latest refused conclusion is the one an ending would ship.
    expect(ctx.control.gate!.refusedFinish).toEqual({
      reason: "mapped",
      summary: "concluding as directed",
      unresolved: [OBJ_A, OBJ_B],
    })
    // And the record keeps the exchange's opening sentences, unrepeated.
    expect(ctx.control.gate!.objections).toEqual([OBJ_A, OBJ_B])
  })

  it("three finish calls in ONE turn are one finish: the budget counts turns, and the lead still gets both refusals", () => {
    // `oneTurn` stops at one STEP, not one tool call, and parallel tool calls
    // in a single assistant message are ordinary provider behaviour. Counting
    // calls let a lead spend the whole refusal budget inside turn 5 and reach
    // an accepted finish without a refusal ever appearing in its transcript.
    const { ctx, live } = gatedCtx()
    const a = finishTool(ctx, { reason: "1", summary: "s", unresolved: [] })
    const b = finishTool(ctx, { reason: "2", summary: "s", unresolved: [] })
    const c = finishTool(ctx, { reason: "3", summary: "s", unresolved: [] })
    expect([a.ok, b.ok, c.ok]).toEqual([false, false, false])
    expect(ctx.control.finished).toBeNull()
    // One turn, one refusal — and the repeats are that refusal again, word for
    // word, not the second one's stronger sentence.
    expect(ctx.control.gate).toMatchObject({ refusals: 1, refusedAtTurn: 5 })
    if (!c.ok) expect(c.reason).toBe(`${OBJ_A}; ${OBJ_B}${GATE_REFUSAL_TAIL}`)
    if (!c.ok) expect(c.reason).not.toContain(GATE_NO_WORK_SENTENCE)
    // The budget is intact: the next TWO turns are where it is spent.
    live.turns += 1
    expect(finishTool(ctx, { reason: "4", summary: "s", unresolved: [] }).ok).toBe(false)
    expect(ctx.control.gate).toMatchObject({ refusals: 2 })
    live.turns += 1
    expect(finishTool(ctx, { reason: "5", summary: "s", unresolved: [] }).ok).toBe(true)
  })

  it("real work clears it: one page gained between the turns and the restated finish stands", () => {
    const { ctx, live, work } = gatedCtx()
    finishTool(ctx, { reason: "mapped", summary: "first try", unresolved: [] })
    live.turns += 1
    work.push("page:https://rival.com/pricing") // the lead's fetch tool gained a page — the loop recorded it, not the lead
    const unresolved = [OBJ_A, "who licenses the two firms without websites"]
    const r = finishTool(ctx, { reason: "still mapped", summary: "second try", unresolved })
    expect(r.ok).toBe(true)
    expect(ctx.control.finished).toEqual({ reason: "still mapped", summary: "second try", unresolved })
    // The lead carried OBJ_A verbatim and omitted OBJ_B: only the omission is
    // carried, and it never enters the lead's own array.
    expect(ctx.control.gate).toMatchObject({ refusals: 1, carried: [OBJ_B], workAnswered: 1, stood: "work" })
    // And the record says WHAT it was paid with, not only that it was paid:
    // `stood: "work"` beside an empty map is a sentence a reader must be able
    // to argue with.
    expect(ctx.control.gate!.answeredBy).toEqual(["page:https://rival.com/pricing"])
    expect(ctx.control.gate!.refusedFinish).toEqual({ reason: "mapped", summary: "first try", unresolved: [] })
  })

  it("work done INSIDE the refused turn answers it — decided, and this is the decision", () => {
    // A message of `[finish, fetch]` fires the refusal first and the fetch
    // second, so the snapshot the refusal froze is already stale when the next
    // turn's bare finish reads it: driven on the real loop as `leadTurns: 3,
    // workAnswered: 1` against the intended shape's 4. Accepted rather than
    // fixed, and the reasoning is on `GateRecord.refusedAtTurn` — the page is
    // real, new and paid for, and moving the snapshot to the end of the
    // refused turn would price that message at two pages while letting a slow
    // host decide whether the first one counted. Pinned so the decision
    // survives someone rediscovering the shape.
    const { ctx, live, work } = gatedCtx()
    expect(finishTool(ctx, { reason: "1", summary: "s", unresolved: [] }).ok).toBe(false)
    work.push("page:https://rival.com/pricing") // the second tool call of the SAME message
    expect(ctx.control.gate!.workAtRefusal).toBe(0) // frozen when the refusal was spoken
    live.turns += 1
    const r = finishTool(ctx, { reason: "2", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toMatchObject({
      refusals: 1,
      workAnswered: 1,
      stood: "work",
      answeredBy: ["page:https://rival.com/pricing"],
    })
  })

  it("...and `[finish, fetch, finish]` in ONE message stands inside that turn — the same decision, one turn earlier", () => {
    // The far edge of the same decision, pinned because it looks alarming and
    // is not. The lead never reads the refusal; it emitted all three calls
    // before the first result came back. But the price was paid in full — a
    // page the run did not hold, recorded by the loop — and the snapshot was
    // NOT re-frozen around it (`workAtRefusal` stays 0), so the second finish
    // is measured against the first refusal and not against itself.
    const { ctx, work } = gatedCtx()
    expect(finishTool(ctx, { reason: "1", summary: "s", unresolved: [] }).ok).toBe(false)
    work.push("page:https://rival.com/pricing")
    const r = finishTool(ctx, { reason: "1 again", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toMatchObject({
      refusals: 1,
      workAtRefusal: 0,
      refusedAtTurn: 5,
      workAnswered: 1,
      stood: "work",
      answeredBy: ["page:https://rival.com/pricing"],
    })
    // A lead that fetches nothing gets the ordinary same-turn re-issue instead:
    // refusal 1 again, word for word, and no acceptance. (Pinned in full by
    // "three finish calls in ONE turn are one finish".)
  })

  it("the price is work, not resolution: an objection that cannot be cleared still lets a worked finish stand", () => {
    // A market with genuinely few players never clears a page-tier-per-family
    // floor. The gate charges a page or a landing, then accepts and records
    // what still stands — inventing an ending that cannot arrive would be
    // worse than the bug this gate was written for.
    const { ctx, live, work } = gatedCtx()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    live.turns += 1
    work.push("mission:m3")
    const r = finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate!.carried).toEqual([OBJ_A, OBJ_B]) // both still standing, both recorded
  })

  it("an obstinate lead still ends the run: two refusals is the ceiling, and the record says what they bought", () => {
    const { ctx, live } = gatedCtx()
    expect(finishTool(ctx, { reason: "1", summary: "s", unresolved: [] }).ok).toBe(false)
    live.turns += 1
    expect(finishTool(ctx, { reason: "2", summary: "s", unresolved: [] }).ok).toBe(false)
    live.turns += 1
    const third = finishTool(ctx, { reason: "3", summary: "s", unresolved: [] })
    expect(third.ok).toBe(true)
    expect(ctx.control.finished!.reason).toBe("3")
    expect(ctx.control.gate).toMatchObject({
      refusals: GATE_MAX_REFUSALS,
      workAnswered: 0,
      stood: "refusals-spent", // the record says which hatch, not just that it passed
    })
    expect(GATE_MAX_REFUSALS).toBe(2)
  })

  it("below the loop's own budget floor the gate declines, and the record calls it a hatch", () => {
    // Ceiling 0.14: the finish reserve carves $0.12, leaving $0.02 spendable
    // against a $0.03 peek — the same expression the orchestrator's floorHit()
    // uses to wake the lead and tell it to close. The gate agrees with the
    // floor one loop-iteration early. It is NOT "the price of the work": a
    // direct fetch, the first act the refusal names, costs the pool nothing,
    // which is exactly why `stood` has to say so rather than let this read as
    // a clean pass.
    const { ctx } = gatedCtx({}, 0.14)
    expect(ctx.ledger.spendable()).toBeCloseTo(0.02)
    const r = finishTool(ctx, { reason: "out of pool", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toMatchObject({
      refusals: 0,
      carried: [OBJ_A, OBJ_B],
      workAtRefusal: null,
      stood: "budget-floor",
    })
  })

  it("carried holds only STILL-standing objections: one resolved between the two turns drops out", () => {
    const { ctx, live, work } = gatedCtx()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    live.turns += 1
    work.push("page:https://second.com/")
    live.objections = [OBJ_B]
    const r = finishTool(ctx, { reason: "mapped", summary: "s", unresolved: ["my own gap"] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate!.carried).toEqual([OBJ_B]) // OBJ_A resolved; not carried
    expect(ctx.control.gate!.objections).toEqual([OBJ_A, OBJ_B]) // the refusal's record stays
  })

  it("cap boundary: at turns = cap-2 the gate still refuses; at cap-1 it never does", () => {
    const atCapMinus2 = gatedCtx({ turns: 22, turnCap: 24 }).ctx
    expect(finishTool(atCapMinus2, { reason: "r", summary: "s", unresolved: [] }).ok).toBe(false)
    expect(atCapMinus2.control.finished).toBeNull()

    const atCapMinus1 = gatedCtx({ turns: 23, turnCap: 24 }).ctx
    const r = finishTool(atCapMinus1, { reason: "r", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(atCapMinus1.control.finished).not.toBeNull()
    // Accepted with the objections on the record, the omissions carried.
    expect(atCapMinus1.control.gate).toEqual({
      refusals: 0,
      objections: [OBJ_A, OBJ_B],
      carried: [OBJ_A, OBJ_B],
      refusedFinish: null,
      workAtRefusal: null,
      workAnswered: 0,
      answeredBy: [],
      refusedAtTurn: null,
      stood: "turn-cap",
    })
  })

  it("the cap guard outranks the work rule: a second refusal near the cap never happens", () => {
    // The refusal that would be issued at cap-1 has no turn to be answered in,
    // so `turn-cap` would take the ending and discard the lead's summary. The
    // work rule does not get to override that. This is also the run the reach
    // claim rests on: resend-com-202608060732 refused its turn-22 finish and
    // accepted the turn-23 one, so the fix replays it byte-identically.
    const { ctx, live } = gatedCtx({ turns: 21, turnCap: 24 })
    expect(finishTool(ctx, { reason: "r", summary: "s", unresolved: [] }).ok).toBe(false)
    live.turns = 23 // the answering turn was spent on words, and the cap is now one away
    const r = finishTool(ctx, { reason: "r", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toMatchObject({ refusals: 1, workAnswered: 0, stood: "turn-cap" })
  })

  it("disarmed: the finish stands first time, objections recorded on acceptance for the record", () => {
    const { ctx } = gatedCtx({ disarmed: true })
    const r = finishTool(ctx, { reason: "closing as told", summary: "s", unresolved: [OBJ_B] })
    expect(r.ok).toBe(true)
    expect(ctx.control.finished!.unresolved).toEqual([OBJ_B])
    expect(ctx.control.gate).toEqual({
      refusals: 0,
      objections: [OBJ_A, OBJ_B],
      carried: [OBJ_A], // OBJ_B was carried by the lead itself
      refusedFinish: null,
      workAtRefusal: null,
      workAnswered: 0,
      answeredBy: [],
      refusedAtTurn: null,
      stood: "disarmed",
    })
  })

  it("disarmed mid-exchange: the wall warning after a refusal ends the argument, worked or not", () => {
    const { ctx, live } = gatedCtx()
    expect(finishTool(ctx, { reason: "r", summary: "s", unresolved: [] }).ok).toBe(false)
    live.turns += 1
    live.disarmed = true // the harness itself has now told the lead to close
    const r = finishTool(ctx, { reason: "the wall says close", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toMatchObject({ refusals: 1, workAnswered: 0, stood: "disarmed" })
  })

  it("a clean scorecard passes the first finish silently, gate record zeroed", () => {
    const { ctx } = gatedCtx({ objections: [] })
    const r = finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    expect(r.ok).toBe(true)
    expect(ctx.control.gate).toEqual({
      refusals: 0,
      objections: [],
      carried: [],
      refusedFinish: null,
      workAtRefusal: null,
      workAnswered: 0,
      answeredBy: [],
      refusedAtTurn: null,
      stood: "clean", // a clean pass, and it says so — unlike every hatch above
    })
  })

  it("after a finish stands, the next is told the first ACCEPTED finish stands", () => {
    const { ctx, live, work } = gatedCtx()
    finishTool(ctx, { reason: "mapped", summary: "s", unresolved: [] })
    live.turns += 1
    work.push("page:https://second.com/")
    finishTool(ctx, { reason: "mapped for real", summary: "s", unresolved: [] })
    const third = finishTool(ctx, { reason: "again", summary: "s", unresolved: [] })
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toBe("the run is already finishing (mapped for real); the first accepted finish stands")
  })

  it("the skill quotes the refusal tail byte for byte — the gate and the doctrine cannot drift", () => {
    // The LEAD section quotes the tail so the model recognises the refusal as
    // the taught exchange, not an error. One string in one place
    // (GATE_REFUSAL_TAIL); this assertion is the seam — the core suite pins
    // the same bytes from the skill's side (the commercialDowngradeHint
    // precedent, both directions).
    const skill = readFileSync("prompts/swarm/skill.md", "utf8")
    expect(skill).toContain(GATE_REFUSAL_TAIL)
  })
})
