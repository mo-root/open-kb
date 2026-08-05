import { ALLOWANCES, type Board, type Ledger, type Mission } from "@open-kb/core"

/**
 * The control tools: spawn, propose, next, finish. No model call, no provider
 * call — these move money and questions, and they mutate one small RunControl
 * the orchestrator reads. Spawn is the lead's only way to fund work and it is
 * non-blocking by construction: reserving and queueing are arithmetic, so it
 * returns in about a millisecond and the lead keeps thinking.
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
 * What the run's steering looks like right now. The tools write it; the
 * orchestrator's loop reads it. Plain data on purpose — there is nothing to
 * serialize and nothing to checkpoint, it lives and dies with the run.
 */
export interface RunControl {
  /** The lead's own re-entry condition; null means wake on the next landing. */
  next: NextCondition | null
  /** Set once by finish(); the run is ending and nothing new is funded. */
  finished: FinishState | null
  /** Claim ids held for spawned missions, by dedupeKey. The orchestrator
   *  settles a claim when its mission lands, at actuals. */
  claims: Map<string, string>
  /** How many times an investigator's wake cleared the lead's condition. */
  wakes: number
}

export function newRunControl(): RunControl {
  return { next: null, finished: null, claims: new Map(), wakes: 0 }
}

export interface ControlCtx {
  board: Board
  ledger: Ledger
  control: RunControl
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
      refused.push({ i, reason: `"${m.tier}" is not a tier money knows; use peek, read or dig` })
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
 * The intended ending: the context that watched the whole run says it is
 * done, in its own words. First finish stands; the summary and unresolved
 * questions print verbatim above the map, and residue ships beside them —
 * both the orchestrator's job to emit.
 */
export function finishTool(ctx: ControlCtx, input: FinishInput): FinishReturn {
  const poolLeftUsd = ctx.ledger.spendable()
  if (ctx.control.finished) {
    return {
      ok: false,
      reason: `the run is already finishing (${ctx.control.finished.reason}); the first finish stands`,
      poolLeftUsd,
    }
  }
  ctx.control.finished = { reason: input.reason, summary: input.summary, unresolved: [...input.unresolved] }
  ctx.control.next = null
  return { ok: true, poolLeftUsd }
}
