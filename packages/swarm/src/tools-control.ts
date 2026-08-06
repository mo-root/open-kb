import { ALLOWANCES, type Board, type Ledger, type Mission } from "@open-kb/core"
import type { FamilyEvent } from "./family-ledger.js"

/**
 * The control tools: spawn, propose, review, next, finish. No model call, no
 * provider call — these move money and questions, and they mutate one small
 * RunControl the orchestrator reads. Spawn is the lead's only way to fund work
 * and it is non-blocking by construction: reserving and queueing are
 * arithmetic, so it returns in about a millisecond and the lead keeps thinking.
 *
 * Refusals are sentences. "the pool no longer funds a dig; re-tier it or drop
 * it" is a decision the lead can make on its next line; a thrown error is not.
 */

export interface NextCondition {
  landings?: number
  seconds?: number
  why: string
}

export interface FinishState {
  reason: string
  summary: string
  unresolved: string[]
}

/**
 * What the finish gate reads at the moment finish is called — supplied as a
 * thunk over live state because the gate is finishTool's own synchronous
 * return (audit amendment 8): the refusal must reach the model in the same
 * turn, and an orchestrator-side gate would overturn an ok:true the model
 * was already told.
 */
export interface GateReading {
  /** `scorecardObjections()` over the live scorecard: fact-sentences, never verdicts. */
  objections: string[]
  /** Lead turns used so far, counting the one in flight. */
  turns: number
  /** The loop detector's cap. Amendment 1: refuse only at turns <= cap - 2 —
   *  a refusal whose answer would collide with the cap hands the ending to
   *  `turn-cap` and discards the lead's summary, the exact substitution of
   *  harness judgement for the lead's that the design forbids. */
  turnCap: number
  /** True once the harness itself told the lead to close (the wall warning,
   *  the budget-floor wake, the free closing turn): refusing finish then
   *  would fight the harness's own instruction. */
  disarmed: boolean
}

/**
 * The gate's record of what happened at finish, for serialization. `null`
 * until a finish met a scorecard thunk.
 */
export interface GateRecord {
  /** How many refusals the gate issued: 0 or 1 by construction. */
  refusals: number
  /** The objection sentences as the refusal delivered them — or, when no
   *  refusal ever happened, the sentences standing at the accepted finish. */
  objections: string[]
  /** Still-standing objections the accepted finish's unresolved[] omitted.
   *  Kept OUT of the lead's array; serialization prefixes each `[scorecard] `
   *  so the instrument's words and the lead's stay distinguishable. */
  carried: string[]
  /** Amendment 2: the refused finish's own words, stashed whole, so a run
   *  that never reaches a second finish (wall hard-cancel, turn-cap, fault)
   *  still ships the conclusion it would have ended on. */
  refusedFinish: FinishState | null
}

/**
 * What the run's steering looks like right now. The tools write it; the
 * orchestrator's loop reads it. Plain data on purpose — there is nothing to
 * serialize and nothing to checkpoint, it lives and dies with the run.
 */
export interface RunControl {
  /** The lead's own re-entry condition; null means wake on the next landing. */
  next: NextCondition | null
  /** Set once by an accepted finish(); the run is ending and nothing new is funded. */
  finished: FinishState | null
  /** Claim ids held for spawned missions, by dedupeKey. The orchestrator
   *  settles a claim when its mission lands, at actuals. */
  claims: Map<string, string>
  /** How many times an investigator's wake cleared the lead's condition. */
  wakes: number
  /** The finish gate's record; null until a finish met a scorecard thunk. */
  gate: GateRecord | null
}

export function newRunControl(): RunControl {
  return { next: null, finished: null, claims: new Map(), wakes: 0, gate: null }
}

export interface ControlCtx {
  board: Board
  ledger: Ledger
  control: RunControl
  /**
   * The family ledger's ear (T3): a lead-band open (spawn, or a promote into
   * the band — reviewTool band-validates first, so every successful promote
   * qualifies) and a review kill with the lead's because. The hook exists
   * because the kill's reason reaches the orchestrator no other way —
   * board.kill discards it by documented contract ("the caller records"),
   * and this caller is where the recording happens. Optional: a ctx without
   * it behaves exactly as before.
   */
  onFamilyEvent?: (event: FamilyEvent) => void
  /**
   * The finish gate's reading (T5), taken synchronously inside finishTool.
   * The orchestrator supplies it over live scorecard state; a ctx without it
   * never refuses a finish and records nothing.
   */
  scorecard?: () => GateReading
}

// ── spawn ────────────────────────────────────────────────────────────────────

export interface SpawnInput {
  missions: Mission[]
  why: string
}

export interface SpawnReturn {
  queued: Array<{ i: number; allowanceUsd: number }>
  refused: Array<{ i: number; reason: string }>
  poolLeftUsd: number
}

/**
 * Fund missions, in the lead's stated order — the ordering is load-bearing:
 * an early expensive mission takes its money before a later cheap one asks.
 * Each queued mission holds a reservation sized by its tier's allowance; a
 * mission the pool cannot fund is refused by name, and the board's own
 * refusals (band, duplicate) hand their reservation straight back.
 */
export function spawnTool(ctx: ControlCtx, input: SpawnInput): SpawnReturn {
  const queued: SpawnReturn["queued"] = []
  const refused: SpawnReturn["refused"] = []

  for (const [i, m] of input.missions.entries()) {
    if (ctx.control.finished) {
      refused.push({ i, reason: `the run is finishing (${ctx.control.finished.reason}); nothing new is funded` })
      continue
    }
    const allowanceUsd = (ALLOWANCES as Record<string, number>)[m.tier]
    if (allowanceUsd === undefined) {
      refused.push({ i, reason: `"${m.tier}" is not a tier money knows; use peek, read, dig or harvest` })
      continue
    }
    const held = ctx.ledger.reserve(allowanceUsd)
    if (!held.ok) {
      refused.push({ i, reason: `the pool no longer funds a ${m.tier}; re-tier it or drop it` })
      continue
    }
    const pushed = ctx.board.push(m, "lead")
    if (!pushed.ok) {
      ctx.ledger.settle(held.claimId, 0) // the board said no; the money goes straight back
      refused.push({ i, reason: pushed.reason })
      continue
    }
    ctx.control.claims.set(m.dedupeKey, held.claimId)
    queued.push({ i, allowanceUsd })
    ctx.onFamilyEvent?.({ kind: "opened", lens: m.lens, dedupeKey: m.dedupeKey, priority: m.priority })
  }

  return { queued, refused, poolLeftUsd: ctx.ledger.spendable() }
}

// ── propose ──────────────────────────────────────────────────────────────────

export interface ProposeInput {
  missions: Mission[]
  /** Clears the lead's re-entry condition so it thinks about this within a
   *  second. For picture-changing finds only — a routine find can wait. */
  wake?: boolean
}

export interface ProposeReturn {
  queued: number
  deduped: Array<{ dedupeKey: string; reason: string }>
  poolLeftUsd: number
}

/**
 * An investigator's find it cannot chase, into the 1-60 band, unreviewed.
 * Nothing is reserved here — proposals cost money only when the lead's board
 * pop funds them. Dedupe is exact-key against queued and claimed items, and
 * every collision is reported back rather than silently swallowed.
 */
export function proposeTool(ctx: ControlCtx, input: ProposeInput): ProposeReturn {
  const deduped: ProposeReturn["deduped"] = []
  let queued = 0

  for (const m of input.missions) {
    if (ctx.control.finished) {
      deduped.push({ dedupeKey: m.dedupeKey, reason: `the run is finishing (${ctx.control.finished.reason}); the board is closed` })
      continue
    }
    const pushed = ctx.board.push(m, "investigator")
    if (!pushed.ok) {
      deduped.push({ dedupeKey: m.dedupeKey, reason: pushed.reason })
      continue
    }
    queued += 1
  }

  if (input.wake && !ctx.control.finished) {
    ctx.control.next = null
    ctx.control.wakes += 1
  }

  return { queued, deduped, poolLeftUsd: ctx.ledger.spendable() }
}

// ── review ───────────────────────────────────────────────────────────────────

export interface ReviewInput {
  promote?: Array<{ dedupeKey: string; priority: number }>
  kill?: Array<{ dedupeKey: string; because: string }>
  why: string
}

export interface ReviewOutcomeRow {
  dedupeKey: string
  ok: boolean
  reason?: string
}

export interface ReviewReturn {
  promoted: ReviewOutcomeRow[]
  killed: ReviewOutcomeRow[]
  poolLeftUsd: number
}

/**
 * The lead's board review, free like recall: promote proposals into the upper
 * band with whole-map context, kill duplicates and dead angles with the reason
 * stated. Killing a FUNDED queued mission hands its reservation straight back
 * to the pool — the mirror of spawn's board-refusal refund: nothing was
 * worked, so the money returns in the same call. A claimed mission is refused
 * in words: review re-ranks the queue, it does not abort lanes. A killed key
 * leaves the dedupe universe, so a better-phrased version of the question may
 * be pushed later. Promote moves no money — the mission is funded when popped,
 * or was funded at spawn.
 */
export function reviewTool(ctx: ControlCtx, input: ReviewInput): ReviewReturn {
  const promoted: ReviewOutcomeRow[] = []
  const killed: ReviewOutcomeRow[] = []

  for (const p of input.promote ?? []) {
    // Band-validate here with the board's own sentence: promote is the lead's
    // act, and a target below 61 is not a review, it is a re-file into the
    // worker band the item already sits in.
    if (!(p.priority >= 61 && p.priority <= 100)) {
      promoted.push({
        dedupeKey: p.dedupeKey,
        ok: false,
        reason: `the lead ranks 61-100; priority ${p.priority} belongs in the proposal band`,
      })
      continue
    }
    const out = ctx.board.promote(p.dedupeKey, p.priority)
    promoted.push(out.ok ? { dedupeKey: p.dedupeKey, ok: true } : { dedupeKey: p.dedupeKey, ok: false, reason: out.reason })
    if (out.ok && ctx.onFamilyEvent) {
      // Promotion into the lead band is what CREATES a family — the row needs
      // the mission's own lens, and promote only succeeds on a queued item, so
      // the board's residue still holds it (now wearing the new priority).
      const row = ctx.board.residue().find((r) => r.dedupeKey === p.dedupeKey)
      if (row) ctx.onFamilyEvent({ kind: "opened", lens: row.lens, dedupeKey: row.dedupeKey, priority: row.priority })
    }
  }

  for (const k of input.kill ?? []) {
    const out = ctx.board.kill(k.dedupeKey, k.because)
    if (!out.ok) {
      // The board says "kill the lane" for a claimed item; the lead holds no
      // lane-killing tool, so the sentence it acts on says what review is not.
      const reason = out.reason.includes("already claimed")
        ? `"${k.dedupeKey}" is already claimed; review does not abort lanes — a running mission finishes on its own clock`
        : out.reason
      killed.push({ dedupeKey: k.dedupeKey, ok: false, reason })
      continue
    }
    const claimId = ctx.control.claims.get(k.dedupeKey)
    if (claimId !== undefined) {
      ctx.ledger.settle(claimId, 0) // funded but never worked; the money goes straight back
      ctx.control.claims.delete(k.dedupeKey)
    }
    killed.push({ dedupeKey: k.dedupeKey, ok: true })
    ctx.onFamilyEvent?.({ kind: "killed", dedupeKey: k.dedupeKey, because: k.because })
  }

  return { promoted, killed, poolLeftUsd: ctx.ledger.spendable() }
}

// ── next ─────────────────────────────────────────────────────────────────────

export interface NextInput {
  after: { landings?: number; seconds?: number }
  why: string
}

export type NextReturn =
  | { ok: true; waitingFor: string; poolLeftUsd: number }
  | { ok: false; reason: string; poolLeftUsd: number }

/**
 * The lead declares its own re-entry: there is no barrier to wait at, only a
 * condition to come back on. The harness also wakes it if the board runs dry
 * or the budget floor is hit — that part belongs to the orchestrator, not here.
 */
export function nextTool(ctx: ControlCtx, input: NextInput): NextReturn {
  const poolLeftUsd = ctx.ledger.spendable()
  if (ctx.control.finished) {
    return { ok: false, reason: "the run is finishing; there is no next turn to wait for", poolLeftUsd }
  }
  const landings = input.after.landings
  const seconds = input.after.seconds
  const validLandings = landings !== undefined && landings > 0
  const validSeconds = seconds !== undefined && seconds > 0
  if (!validLandings && !validSeconds) {
    return { ok: false, reason: "say what wakes you: landings, seconds, or both", poolLeftUsd }
  }
  ctx.control.next = {
    ...(validLandings ? { landings } : {}),
    ...(validSeconds ? { seconds } : {}),
    why: input.why,
  }
  const parts = [
    ...(validLandings ? [`${landings} landing${landings === 1 ? "" : "s"}`] : []),
    ...(validSeconds ? [`${seconds}s`] : []),
  ]
  return { ok: true, waitingFor: `waking after ${parts.join(" or ")}${parts.length > 1 ? ", whichever comes first" : ""}`, poolLeftUsd }
}

// ── finish ───────────────────────────────────────────────────────────────────

export interface FinishInput {
  reason: string
  summary: string
  unresolved: string[]
}

export type FinishReturn =
  | { ok: true; poolLeftUsd: number }
  | { ok: false; reason: string; poolLeftUsd: number }

/**
 * The teaching half of the one refusal, appended after the objection
 * sentences. One string in one place: the skill (T8) quotes this shape, and
 * the refusal must stay byte-stable for that byte-match to mean anything.
 */
export const GATE_REFUSAL_TAIL =
  "; finishing now records these as unresolved — address them or carry them into unresolved verbatim; your next finish stands"

/**
 * The intended ending: the context that watched the whole run says it is
 * done, in its own words. The first ACCEPTED finish stands; the summary and
 * unresolved questions print verbatim above the map, and residue ships
 * beside them — both the orchestrator's job to emit.
 *
 * The scorecard gate, when a `scorecard` thunk is present: an armed first
 * finish is refused ONCE, in the instrument's fact-sentences — the finish
 * does not take effect, spawn stays open (nothing is finishing), and the
 * refused conclusion is stashed whole in `control.gate.refusedFinish` so no
 * ending can lose it. The second finish ALWAYS stands, whatever the numbers:
 * the lead's unresolved[] ships byte-identical, and any still-standing
 * objection it omitted is recorded separately as `carried`. The gate never
 * speaks when the thunk is absent, the objections are empty, the harness
 * already told the lead to close (`disarmed`), or the lead's next turn would
 * collide with the turn cap (refuse only at turns <= cap - 2).
 */
export function finishTool(ctx: ControlCtx, input: FinishInput): FinishReturn {
  const poolLeftUsd = ctx.ledger.spendable()
  if (ctx.control.finished) {
    return {
      ok: false,
      reason: `the run is already finishing (${ctx.control.finished.reason}); the first accepted finish stands`,
      poolLeftUsd,
    }
  }
  const reading = ctx.scorecard?.()
  const objections = reading ? [...reading.objections] : []
  const refuse =
    reading !== undefined &&
    objections.length > 0 &&
    !reading.disarmed &&
    reading.turns <= reading.turnCap - 2 &&
    (ctx.control.gate?.refusals ?? 0) === 0
  if (refuse) {
    ctx.control.gate = {
      refusals: 1,
      objections,
      carried: [],
      refusedFinish: { reason: input.reason, summary: input.summary, unresolved: [...input.unresolved] },
    }
    // The lead's next turn is the answer to this refusal: clear any standing
    // re-entry condition so the loop grants that turn immediately.
    ctx.control.next = null
    return { ok: false, reason: `${objections.join("; ")}${GATE_REFUSAL_TAIL}`, poolLeftUsd }
  }
  if (reading !== undefined) {
    // The record, on every accepted finish that had an instrument to read:
    // which standing sentences the lead's unresolved[] left out. The lead's
    // array itself is never touched — serialization labels the carried ones.
    const carried = objections.filter((o) => !input.unresolved.includes(o))
    if (ctx.control.gate) {
      ctx.control.gate.carried = carried // objections keep the refusal's record
    } else {
      ctx.control.gate = { refusals: 0, objections, carried, refusedFinish: null }
    }
  }
  ctx.control.finished = { reason: input.reason, summary: input.summary, unresolved: [...input.unresolved] }
  ctx.control.next = null
  return { ok: true, poolLeftUsd }
}
