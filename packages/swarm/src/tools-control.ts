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

const EPSILON = 1e-9

/**
 * WHO PUT A MISSION ON THE BOARD. Five sites can, and the finish gate has to
 * tell them apart, because it charges the LEAD and four of the five are not
 * the lead:
 *
 *   lead          spawnTool through the lead's own control ctx (agent.ts
 *                 `leadControlTools`), and reviewTool's promote OF AN
 *                 UNREVIEWED ROW — the lead ranking an investigator's
 *                 proposal into its own band with whole-map context is the
 *                 lead commissioning it, and the money still comes out of the
 *                 pool it steers. A promote of a row the HARNESS pushed is not
 *                 a commission at all: it was already funded and already in
 *                 the band, so the promote moves a number and nothing else.
 *                 See reviewTool for the measurement. NOR is a kill and a
 *                 re-spawn: a key one of the four below put on the board, and
 *                 the lead then killed, keeps that name however it gets back
 *                 on (`RunControl.commissionerBeforeKill`) — re-asking the
 *                 same question under the same key is the same work, funded
 *                 out of the refund the kill just handed back. A kill is the
 *                 ONLY door: a queued duplicate and a claimed one are both
 *                 refused by `Board.push`, and a landed mission stays claimed
 *                 for the rest of the run, so its key never comes free.
 *   seed          the orient dig the harness writes before any model runs
 *                 (orchestrator.ts `seedMission`).
 *   family-floor  seed-families.ts's deck, spawned by the orchestrator when
 *                 the seed lands. ON BY DEFAULT (`DEFAULT_FAMILY_FLOOR = 4`).
 *   sweep         from-sweep.ts's handoff board, spawned by the orchestrator
 *                 on the same landing.
 *   investigator  proposeTool: a lane's find, queued unreviewed in the 1-60
 *                 band. It can still be popped and land without the lead ever
 *                 touching it.
 *
 * It is a property of the CONTEXT the tools are held through, not of the
 * Mission, and that is deliberate: a Mission is a value the model writes, and
 * the lead's zod schema would have to be trusted not to carry this field. The
 * ctx is built by the harness at four distinct wiring sites and the model
 * never sees one.
 */
export type Commissioner = "lead" | "seed" | "family-floor" | "sweep" | "investigator"

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
  /**
   * The APPEND-ONLY LOG of work the run gained for the lead, and the whole of
   * what a refusal is priced in: pages the LEAD's own fetch tool bought that
   * the run held nothing for, plus missions THE LEAD COMMISSIONED coming home.
   * Its length is the number the gate charges against — stored at a refusal,
   * read again at the next finish — so what clears a refusal is a fact the
   * loop counted for its own reasons and not a claim the lead makes about
   * itself.
   *
   * A LOG rather than a counter because the entries are also the answer to
   * "what did the refusal buy?": `GateRecord.answeredBy` is a slice of this
   * array, which is exact only while the array is append-only. Both writers
   * (orchestrator.ts) push at the moment the thing happens, so the slice at a
   * stored length is always the work that came after that moment.
   *
   * Every word of the rest is load-bearing, because the obvious cheaper
   * counters are all buyable for nothing:
   *
   *   - GAINED, not attempted. A fetch CALL is free to fail: the direct branch
   *     of providers/src/brightdata.ts catches a network error and resolves
   *     `{httpStatus: 0, body: "", usd: 0}`, so an unreachable host is a
   *     completed call at $0.00. The log grows only where the sniffer said
   *     `found` and the run held neither that ADDRESS nor that READING yet
   *     (tools-paid.ts `onPageGained`) — so a dead host, a 403, an empty body
   *     dressed as success, a re-fetch, an ALIAS of a page already held, a
   *     REDIRECT onto one, a second read of an address already visited, and a
   *     soft 404 that prints the path it was handed all cost the lead a turn
   *     and buy it nothing. The last two matter most, because they were the
   *     only remaining UNBOUNDED supplies: a direct fetch is $0, so one host
   *     with an echoing error template was `https://anchor.com/<anything>` as
   *     many times as the lead cared to type it.
   *   - THE LEAD's pages. The old counter was the run-wide fetch tally, which
   *     investigators and harvest also move, so a lead could sit still and be
   *     credited with its lanes' pages. The lead's paid toolset is built per
   *     turn against its own claim (agent.ts), and only that toolset carries
   *     the hook.
   *   - A LANDING, whatever its status. A timed-out or crashed mission still
   *     spent the pool and still reports (the orchestrator gives even a crash
   *     a digest), so a market that will not answer cannot trap a lead.
   *     It counts ONCE — under the old counter a mission paid twice, once for
   *     its investigator's page and once for its own landing.
   *   - A LANDING THE LEAD COMMISSIONED. This used to count run-wide, on a
   *     premise this file stated as fact: "there is no second commissioner".
   *     There are four besides the lead. `DEFAULT_FAMILY_FLOOR = 4` is on by
   *     default (seed-families.ts, orchestrator.ts), the seed dig is the
   *     harness's,
   *     and a sweep handoff mints a board of its own — so a lead that never
   *     spawned, fetched or searched (turn 1 `next {landings: 1}`, then finish
   *     forever) read `{refusals: 2, workAnswered: 4, stood: "work"}` on the
   *     DEFAULT path, its debt paid entirely by `orient:anchor.com`,
   *     `family:market`, `family:competitors`, `family:substitutes` and
   *     `family:buyers`. The same lead with `familyFloor: false` read
   *     `{workAnswered: 0, stood: "refusals-spent"}`: the whole difference was
   *     missions the HARNESS wrote. `RunControl.commissionedBy` is what keeps
   *     them apart now — and neither free verb of `review` buys an entry in
   *     it: a `promote` re-stamps only an UNREVIEWED row, and a `kill` cannot
   *     launder one by returning the key to the board for the lead to re-spawn
   *     (both in reviewTool; the memory is `commissionerBeforeKill`).
   *   - NOT a SERP. Run 2 kept 8 nodes with 6 at snippet tier, each minted
   *     from a single SERP page (runs/swarm-*-202608052348.json): searching is
   *     the work that PRODUCES the single-sourced objection, not the work that
   *     answers it.
   *   - NOT a spawn. Money reserved is not work done; the landing is.
   *
   * THE ESCAPE HATCH STAYS OPEN either way, and it has to: a direct fetch
   * costs the pool $0, so a lead with an empty pool and no lanes always has a
   * free move that answers a refusal honestly.
   *
   * A page counts when it lands, not when it is asked for — one still in
   * flight past `PENDING_AFTER_MS` has not arrived. A lead that fetches
   * something slow and finishes in the same breath can therefore hear the
   * second refusal; the page lands during that refusal's own model turn, and
   * the finish after it stands.
   */
  work: readonly string[]
}

/** Why an armed gate let a finish stand. One of these is recorded on every
 *  accepted finish that had an instrument to read, so a reader can tell a
 *  clean pass from an escape hatch without re-deriving the arithmetic.
 *
 *    clean           nothing was standing to object to.
 *    work            a refusal was outstanding and the LEAD recorded work.
 *    disarmed        the harness had already told the lead to close.
 *    turn-cap        a refusal's answer would collide with the loop detector.
 *    budget-floor    the pool is under the price the loop closes runs at.
 *    refusals-spent  GATE_MAX_REFUSALS were issued and answered in words.
 */
export type GateStood = "clean" | "work" | "disarmed" | "turn-cap" | "budget-floor" | "refusals-spent"

/**
 * The gate's record of what happened at finish, for serialization. `null`
 * until a finish met a scorecard thunk.
 */
export interface GateRecord {
  /** How many refusals the gate issued: 0, 1 or 2 by construction. Repeat
   *  finish calls inside ONE lead turn re-issue a refusal without spending
   *  one, so this counts turns the gate spoke in, never tool calls. */
  refusals: number
  /** The objection sentences as the FIRST refusal delivered them — the
   *  exchange's opening, kept whole through a second refusal and through an
   *  objection that later resolves — or, when no refusal ever happened, the
   *  sentences standing at the accepted finish. */
  objections: string[]
  /** Still-standing objections the accepted finish's unresolved[] omitted.
   *  Kept OUT of the lead's array; serialization prefixes each `[scorecard] `
   *  so the instrument's words and the lead's stay distinguishable. */
  carried: string[]
  /** Amendment 2: the refused finish's own words, stashed whole, so a run
   *  that never reaches an accepted finish (wall hard-cancel, turn-cap,
   *  fault) still ships the conclusion it would have ended on. The LATEST
   *  refused conclusion, not the first: with two refusals the second is the
   *  fresher of the two, and it is the one the run would have ended on. */
  refusedFinish: FinishState | null
  /** How long `GateReading.work` was when the last refusal read it; null when
   *  no refusal ever happened. This is the number the next finish is measured
   *  against. */
  workAtRefusal: number | null
  /** Pages the lead gained plus lead-commissioned missions landed between that
   *  refusal and the finish that ended the exchange — what the refusal
   *  actually bought. 0 beside a non-zero `refusals` is the run saying, on its
   *  own record, that the lead was asked for a page or a landing and produced
   *  neither. */
  workAnswered: number
  /**
   * And WHICH work that was: `GateReading.work` sliced from `workAtRefusal`,
   * each entry `page:<url>(<chars>c)` or `mission:<dedupeKey>(<status>,+<nodes>)`
   * — both halves carry what the unit was worth, because "the lead paid" and
   * "the lead paid with a 210-character stub" are different claims and only the
   * second can be argued with. Empty when no refusal
   * happened or when none was answered.
   *
   * `stood: "work"` on its own says the lead paid without saying for what, and
   * a lead can pay with one fetch of an unrelated blog and end with an empty
   * map on a record that reads like a clean exchange. This does not change the
   * rule — charging the CLEARING of an objection was rejected and stays
   * rejected, because objections are computed from the map and some cannot be
   * cleared at all — it makes the rule AUDITABLE: the reader sees the receipt
   * and judges it, exactly as `carried` shows the objections the gate accepted
   * a finish over without accepting them itself.
   *
   * Deliberately NOT "did the map grow". The orchestrator does compute
   * per-landing added/merged, but a lead that re-reads a market and confirms
   * what is already there has done real work, and putting a map delta in the
   * gate's record would invite the next reader to make it the price.
   */
  answeredBy: string[]
  /** `GateReading.turns` at the last refusal; null when none happened. The
   *  gate's budget is per TURN, so it has to remember which turn it spoke in:
   *  a lead may emit several finish calls in one message, and `stepCountIs(1)`
   *  bounds steps, not the tool calls inside one. NOT serialized — it is the
   *  rule's own bookkeeping, and `refusals` beside `workAnswered` is what a
   *  reader needs.
   *
   *  DECIDED, NOT OVERLOOKED: the snapshot is taken when the refusal is
   *  SPOKEN, so work done later in that same turn answers it. A message of
   *  `[finish, fetch]` fires the refusal first and the fetch second, and the
   *  next turn's bare finish then stands on a page bought inside the refused
   *  turn — driven on the real loop as `leadTurns: 3, workAnswered: 1` against
   *  the 4 turns the intended shape takes. It is accepted, for two reasons.
   *  The page is real, new and paid for, so no false sentence is emitted and
   *  the failure this gate exists for — a refusal answered with a restated
   *  sentence — is untouched. And moving the snapshot to the END of the
   *  refused turn would price that message at TWO pages rather than the one
   *  unit of work per refusal the rule states, while handing the decision to
   *  a race: a page bought in the refused turn but landing past
   *  `PENDING_AFTER_MS` would count or not according to how slow its host was. */
  refusedAtTurn: number | null
  /** Why the accepted finish was not refused; null while the exchange is
   *  still open (a refusal issued, no finish accepted yet). */
  stood: GateStood | null
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
  /** Who put each board item there, by dedupeKey — written at the moment the
   *  push succeeds, cleared when a kill takes the key out of the dedupe
   *  universe so a re-push re-tags. The finish gate reads it to tell the
   *  lead's landings from the harness's; nothing else in the loop steers by
   *  it. Missing means nobody recorded a commissioner, which the gate reads as
   *  "not the lead" — the conservative direction. */
  commissionedBy: Map<string, Commissioner>
  /**
   * THE NAME A KILL CANNOT ERASE. For every key a commissioner OTHER than the
   * lead put on the board and a `review kill` then removed: who that was. A
   * later push of the SAME key wears this name instead of the pusher's, so the
   * entry above can never be re-tagged `lead` by killing the row first.
   *
   * It exists because `commissionedBy.delete` in the kill loop was the promote
   * laundry one door over, and a cheaper one. Driven on the real loop at
   * DEFAULT lanes against a ten-mission sweep handoff: the lead killed
   * `gap:unknowns-2` — which frees the reservation (`ledger.settle(claimId,
   * 0)`), drops the commissioner, and returns the key to the dedupe universe —
   * and re-spawned a mission byte-identical to the handoff's own. The re-push
   * stamped `lead`, and the gate read `{refusals: 1, workAnswered: 1,
   * answeredBy: ["mission:gap:unknowns-2(done,+0)"], stood: "work"}` at
   * fetchCalls 0 and $0.0010, against the same script minus those two calls
   * reading `{refusals: 2, workAnswered: 0, stood: "refusals-spent"}` at the
   * same money to four decimals, the same eleven landings and the same empty
   * map. Nothing had changed but the name.
   *
   * THE HONEST CASES STAY PAID, and they are the reason this keys on the
   * dedupeKey and on nothing else. A lead that kills a dead harness row and
   * spawns a DIFFERENT question spawns it under a different key, which is
   * unpinned. A re-spawn under a fresh key is a different mission by the
   * board's own definition of identity — the dedupeKey IS the question's name
   * here, and the lead writes it. And a promote of an unreviewed proposal is
   * untouched: nothing killed it, so nothing is pinned.
   *
   * WHAT IT DOES NOT CATCH, stated rather than implied. Kill `gap:unknowns-2`
   * and spawn the identical brief under `gap:unknowns-2b` and the landing is
   * the lead's, at the same money and the same work. Kill two funded harness
   * reads and spawn one throwaway peek and the gate is satisfied by a run that
   * did STRICTLY LESS work than it would have (measured). Both are the
   * fresh-key case the paragraph above deliberately allows — a lead re-aiming
   * the pool is the behaviour the board exists for, and the same two calls are
   * an honest re-allocation and a dodge depending only on what the lead meant.
   * Closing them would mean pinning on the mission's TEXT, a hash of a field
   * the model writes, which one reworded word defeats. Left open, on the
   * record, rather than papered over with a discriminator that reads strict
   * and is not.
   */
  commissionerBeforeKill: Map<string, Commissioner>
  /** How many times an investigator's wake cleared the lead's condition. */
  wakes: number
  /** The finish gate's record; null until a finish met a scorecard thunk. */
  gate: GateRecord | null
}

export function newRunControl(): RunControl {
  return {
    next: null,
    finished: null,
    claims: new Map(),
    commissionedBy: new Map(),
    commissionerBeforeKill: new Map(),
    wakes: 0,
    gate: null,
  }
}

/**
 * Write who commissioned this key, at the moment a push or a promote takes.
 * The pusher's own name, EXCEPT where a kill already recorded a non-lead one
 * for this key — see `RunControl.commissionerBeforeKill`. One expression, used
 * at the three sites in THIS file that can name a commissioner, so the pin
 * cannot be honoured at two of them and forgotten at the third. The fourth
 * writer is the orchestrator's own seed push, which names `"seed"` directly:
 * it is harness-side and can never say `"lead"`, so it has nothing to pin.
 */
function stamp(ctx: ControlCtx, dedupeKey: string): void {
  ctx.control.commissionedBy.set(dedupeKey, ctx.control.commissionerBeforeKill.get(dedupeKey) ?? ctx.commissioner)
}

export interface ControlCtx {
  board: Board
  ledger: Ledger
  control: RunControl
  /**
   * Who is holding these tools. REQUIRED, and required rather than defaulted
   * because the bug this closes was a default: the landing half of the finish
   * gate's price was run-wide on the premise that only the lead commissions
   * work, and four other sites do. A new commissioner now cannot be added
   * without the compiler asking who it is, and the answer cannot be "whoever
   * called last".
   */
  commissioner: Commissioner
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
    // Who commissioned it, recorded at the push rather than carried on the
    // Mission: the Mission is a value the model writes. Not necessarily THIS
    // caller — a key a kill took off the harness's board keeps the harness's
    // name however it gets back on.
    stamp(ctx, m.dedupeKey)
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
    // A proposal nobody promoted can still be popped and land, so it is
    // commissioned by whoever proposed it — never by the lead, whose only act
    // here would be a promote (which re-stamps it below).
    stamp(ctx, m.dedupeKey)
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
 * be pushed later — but it does not leave the run's memory of WHO put it
 * there, so re-pushing a harness key does not make the harness's landing the
 * lead's (`RunControl.commissionerBeforeKill`). Promote moves no money — the
 * mission is funded when popped, or was funded at spawn.
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
    // Read BEFORE the promote, and it has to be: `Board.promote` clears
    // `unreviewed` itself, so the residue row the family-event branch below
    // looks up always says false and cannot stand in for this.
    const wasUnreviewed = ctx.board.residue().find((r) => r.dedupeKey === p.dedupeKey)?.unreviewed === true
    const out = ctx.board.promote(p.dedupeKey, p.priority)
    promoted.push(out.ok ? { dedupeKey: p.dedupeKey, ok: true } : { dedupeKey: p.dedupeKey, ok: false, reason: out.reason })
    // A promote of an UNREVIEWED row is a commission: an investigator's
    // proposal sits in the 1-60 band holding no reservation (proposeTool
    // reserves nothing) and is only reached once the lead band is empty, so
    // ranking it into 61-100 genuinely commits pool money to a question that
    // would otherwise have waited or died. That is the lead spending what it
    // steers, and it cannot be self-dealt: propose is investigator-only
    // (agent.ts `proposeToolFor`; the lead's set is `leadControlTools`), so an
    // unreviewed row always cost some lane to exist.
    //
    // A promote of anything ELSE is a re-label, and it was the whole bypass.
    // Every harness row — seed, family-floor, sweep handoff — is pushed with
    // `board.push(m, "lead")`, so it arrives already funded, already in the
    // 61-100 band, and WILL be popped whatever the lead does; `Board.promote`
    // mutates only `priority`. Re-ranking one changes nothing about whether
    // the work happens, only whose name is on it — and the finish gate then
    // read `stood: "work"` naming the HARNESS's own mission as the payment.
    // Driven at DEFAULT lanes against a sweep handoff: one promote, no fetch,
    // no search, no spawn, `{refusals: 1, workAnswered: 1, stood: "work"}` at
    // $0.0000. `unreviewed` is the discriminator and it already existed
    // (core/src/board.ts sets it from `from === "investigator"` at push).
    //
    // `stamp` rather than a bare set, for the row that is unreviewed BECAUSE
    // the lead killed the harness's copy and a lane re-proposed the same key:
    // the promote is a real commission, the key is still the harness's.
    if (out.ok && wasUnreviewed) stamp(ctx, p.dedupeKey)
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
    // The key leaves the dedupe universe, so it leaves the live record too —
    // but NOT the run's memory of who put it there, unless that was the lead.
    // A kill releases the reservation and frees the key; a spawn of the same
    // key then re-reserves the same allowance for the same question, so the
    // run does exactly the work it was already going to do and the only thing
    // that changed is whose name is on the landing. The next push reads this
    // and wears the old name (`stamp`); a DIFFERENT question, which is a
    // different key, reads nothing and is the pusher's own.
    const was = ctx.control.commissionedBy.get(k.dedupeKey)
    if (was !== undefined && was !== "lead") ctx.control.commissionerBeforeKill.set(k.dedupeKey, was)
    ctx.control.commissionedBy.delete(k.dedupeKey)
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
 * The teaching half of every refusal, appended after the fact-sentences. One
 * string in one place: the skill (T8) quotes this shape, and the refusal must
 * stay byte-stable for that byte-match to mean anything.
 *
 * Amendment 9 rewrote it because the old tail taught the answer it did not
 * want. It ended "address them or carry them into unresolved verbatim; your
 * next finish stands", and both live refusals took it at its word:
 * runs/swarm-brightdata-com-202608060833 refused the turn-19 finish at seq 371
 * and the lead pasted BOTH objection sentences into `unresolved` and called
 * finish again 9.6s later in turn 20 — "Concluding with the established
 * high-confidence nodes while acknowledging the remaining gaps as directed";
 * runs/swarm-resend-com-202608060732 refused at seq 227 (turn 22) and the lead
 * answered at seq 229 5.8s later in turn 23, one intervening model turn, zero
 * paid work. The gate had offered a sentence as a way through, so it got
 * sentences. It now names the two acts it can actually check, and it does not
 * promise that the next finish stands — only that a finish standing on
 * recorded work does.
 */
export const GATE_REFUSAL_TAIL =
  "; words do not clear these — fetch a page, or spawn a mission and let it land; the next finish after recorded work stands, carrying what still stands into unresolved verbatim"

/**
 * The second refusal's own fact, in the instrument's voice and first among
 * the sentences because it is the only thing the gate learned since the
 * first: the turn it bought was spent on words. Checkable like every other
 * sentence the gate speaks — `GateReading.work` did not move.
 */
export const GATE_NO_WORK_SENTENCE =
  "no page was fetched and no mission landed in the turn the last refusal bought"

/**
 * How many TURNS one run may hear a refusal in. Two, and the second is the
 * last because it is the last new fact the gate has: refusal 1 is the
 * readings, refusal 2 is the readings plus `GATE_NO_WORK_SENTENCE`. A third
 * would repeat refusal 2 word for word and charge a metered lead turn to say
 * nothing new — in runs/swarm-brightdata-com-202608060833 the turn the
 * refusal bought (turn 20; spans seq 373-375) cost $0.0941.
 *
 * The alternative — refuse until the objections clear — is bounded only by the
 * turn cap and is the wrong bound twice over. It buys turns of argument with
 * the same pool the work would come out of, and some objections cannot be
 * cleared at all: a market with three real players never clears a
 * page-tier-per-family floor.
 *
 * How much room that alternative actually has, measured rather than imagined.
 * In 060833 the lead first called finish in turn 19 of a 24 cap (the finish
 * span, seq 371, precedes that turn's own model span at seq 372 — the SDK runs
 * a step's tools before `oneTurn` reports the call), and the cap guard refuses
 * only at `turns <= cap - 2`, so an unbounded gate had three more refusals,
 * not the nineteen a lead finishing at turn 3 would have. No lead finishes at
 * turn 3: FIVE stored runs called finish, and of the four whose first finish
 * can be located in a span stream it landed at turn 12, 19, 20 and 22 (median
 * 19.5). The fifth, runs/swarm-brightdata-com-202608052316, ended
 * `lead-finished` and is simply not measurable — it ships no .spans.jsonl and
 * its report carries no turn count — so it is excluded from the four rather
 * than counted as agreeing with them. So the cap guard, not this ceiling, is
 * what usually binds — this is the cheap belt beside a brace the record shows
 * is load-bearing, and it is set at two because two is where the gate runs out
 * of things to say.
 */
export const GATE_MAX_REFUSALS = 2

/**
 * The intended ending: the context that watched the whole run says it is
 * done, in its own words. The first ACCEPTED finish stands; the summary and
 * unresolved questions print verbatim above the map, and residue ships
 * beside them — both the orchestrator's job to emit.
 *
 * The scorecard gate, when a `scorecard` thunk is present: an armed finish is
 * refused in the instrument's fact-sentences — the finish does not take
 * effect, spawn stays open (nothing is finishing), and the refused conclusion
 * is stashed whole in `control.gate.refusedFinish` so no ending can lose it.
 *
 * THE REFUSAL IS PRICED IN WORK, NOT WORDS. What clears it is
 * `GateReading.work` growing: a page the LEAD gained — a new address AND a new
 * reading, not a new spelling of a place the run has been or of bytes it
 * already holds — or a mission THE LEAD COMMISSIONED coming home, which means
 * spawned, or promoted out of the unreviewed band; never merely re-ranked,
 * and never a harness key the lead killed and spawned again under the same
 * name.
 * Both are counted by the loop for its own reasons (see
 * `work` for why each cheaper counter is buyable for nothing). A finish with
 * recorded work behind it stands whatever the readings then say — the gate
 * charges one unit of work per refusal, never the clearing of an objection,
 * because objections are computed from the map and some cannot be cleared at
 * all; `answeredBy` records which unit it was. A finish with
 * nothing behind it hears the second and last refusal, which adds the one new
 * fact (`GATE_NO_WORK_SENTENCE`); the third stands. Live precedent for why:
 * both refusals the eight runs contain were answered inside ten seconds with
 * a restated sentence and no paid work (runs/swarm-brightdata-com-
 * 202608060833 seq 371→374, runs/swarm-resend-com-202608060732 seq 227→229),
 * and the old gate accepted both.
 *
 * THE BUDGET IS PER TURN. `refusals` counts lead turns the gate spoke in, not
 * finish calls: several finish calls can ride one assistant message, and
 * `oneTurn`'s `stopWhen: stepCountIs(1)` bounds STEPS, not the tool calls
 * inside a step. Counting calls let a lead spend the whole budget in one turn
 * and never see a refusal in its transcript. A finish in the turn a refusal
 * was already issued in re-issues that same refusal, word for word, and
 * spends nothing.
 *
 * WHAT IT WOULD REPLAY AS, honestly: of the eight stored runs, five ended
 * `lead-finished`; three of those predate the scorecard entirely and carry no
 * gate record, so they cannot be replayed at all. Of the two that can, 060833
 * is refused a second time (turn 19 → turn 20, no work between), and 060732 is
 * not — its second finish is in turn 23 of a 24 cap, where the cap guard
 * accepts it regardless of work, so it replays byte-identically to what it
 * actually did. One run in eight changes.
 *
 * WHICH OBJECTIONS ACTUALLY SPEAK: both live refusals were driven entirely by
 * `familiesWithPageTier` and `singleSourced`. `poolUnspent` measured 0.35 and
 * 0.15 against a 0.5 threshold (core/src/scorecard.ts) — the unspent-pool
 * sentence has never fired in a run that reached a gate.
 *
 * THE RUN STILL ENDS, and the accepted finish records WHICH of these let it
 * through, in `gate.stood`, so a reader can tell an escape hatch from a clean
 * pass:
 *   1. `budget-floor` — `spendable() < ALLOWANCES.peek`. Not "the price of
 *      work": a direct fetch, the first act the refusal names, costs the pool
 *      nothing. It is the LOOP's own floor, the same expression as
 *      orchestrator.ts `floorHit()`, which wakes the lead to close the run.
 *      Reading it here rather than waiting for `disarmed` catches a pool that
 *      empties DURING the lead's own turn, in that turn. Below it the gate is
 *      agreeing with the floor one iteration early — which is a hatch, and
 *      says so on the record.
 *   2. `disarmed` — the harness already said close: the wall warning, the
 *      budget-floor wake, the free closing turn.
 *   3. `turn-cap` — the answer would collide with the loop detector
 *      (`turns > cap - 2`); and if the lead stops finishing altogether,
 *      `turn-cap` still ships a conclusion because `refusedFinish` holds the
 *      latest refused one.
 *   4. `refusals-spent` — the lead will not work: two refusals, then the
 *      finish stands, at a bounded cost of two metered turns, with
 *      `refusals: 2, workAnswered: 0` saying exactly that.
 *   5. `work` — the lead paid, and `answeredBy` names what with. The
 *      objections may still stand (the unclearable case); they are recorded
 *      as `carried`.
 *   6. `clean` — nothing was standing.
 * Beyond the six: a lead that commissions work which never comes home rides
 * the tier deadline (a landing counts whatever its status) and, failing that,
 * the wall — `wall-clock`, shipping `refusedFinish`. A lead waiting on work
 * that can never be funded gets the loop's dry-board wake. No path where the
 * gate holds a run open forever, and none where it holds the lead ASLEEP: a
 * refusal always clears `control.next`, so the answering turn is immediate.
 *
 * WHAT THIS DOES NOT FIX. `report.finish` is still null on a `turn-cap` or
 * `wall-clock` ending — the lead never had an accepted finish, so the run ends
 * on the harness's word. The gate only stops making that WORSE: it never
 * withholds the answering turn, and `refusedFinish` carries the latest refused
 * conclusion into whichever ending arrives. A run whose lead simply stops
 * calling finish is a different problem, still open.
 *
 * WHY NO WAIT-FOR-THE-LANDING BRANCH. A refusal issued while a lane is live
 * looks like it should park the lead on `{landings: 1}` rather than spend a
 * turn on a board that cannot answer yet. It was tried and removed. It is a
 * no-op for the outcome — the landing that wakes the lead is itself +1 work,
 * so the finish after it stands either way — and it is not a no-op for the
 * risk: `{landings: 1}` carries no clock, the loop only arms a timer for
 * `next.seconds`, and against a wall shorter than the 45s warning band there
 * is no warning to disarm the gate. Driven on the real loop, a parked lead
 * never came back: `leadTurns: 2`, ending `wall-clock`, `finish: null` — the
 * harness deciding the ending, which is what this gate exists NOT to do. The
 * orchestrator suite keeps that run as a regression test ("a wall too short
 * for its own warning"). It also overwrote the lead's own
 * re-entry condition, so a lead waiting `{seconds: 5}` was made to wait for a
 * landing instead: longer, not shorter. The lead already owns that decision —
 * it holds `next`.
 *
 * The gate never speaks when the thunk is absent or the objections are empty.
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
  const prior = ctx.control.gate
  // What the run RECORDED since the last refusal, counted by the loop rather
  // than claimed by the lead. Zero when no refusal is outstanding: the first
  // refusal is about the map, not about effort, and is owed nothing.
  const owed = prior?.workAtRefusal ?? null
  const workLog = reading?.work ?? []
  const workSince = owed === null ? 0 : workLog.length - owed
  // A finish in the turn a refusal was already issued in is the same finish
  // asked twice, not a second attempt: the turn the refusal buys has not
  // happened yet, so there is nothing new to judge and nothing to charge.
  const sameTurn = reading !== undefined && prior?.refusedAtTurn === reading.turns
  // The loop's own budget floor, expression for expression (orchestrator.ts
  // `floorHit()`). Below it the harness is already waking the lead to close.
  const aboveFloor = poolLeftUsd + EPSILON >= ALLOWANCES.peek

  /** Why this finish is NOT refused — null means it is. One ladder, so the
   *  precedence is stated once and the record cannot disagree with the rule. */
  const stood: GateStood | null =
    reading === undefined
      ? null
      : objections.length === 0
        ? "clean"
        : workSince > 0
          ? "work"
          : reading.disarmed
            ? "disarmed"
            : reading.turns > reading.turnCap - 2
              ? "turn-cap"
              : !aboveFloor
                ? "budget-floor"
                : (prior?.refusals ?? 0) >= GATE_MAX_REFUSALS && !sameTurn
                  ? "refusals-spent"
                  : null

  if (reading !== undefined && stood === null) {
    // Which refusal this IS: a re-issue inside the same turn repeats the one
    // already spoken, so it neither advances the count nor moves the number
    // the next turn will be measured against.
    //
    // `prior?.refusals ?? 1` has no honest seam: `sameTurn` (above) is
    // `... && prior?.refusedAtTurn === reading.turns`, so sameTurn===true
    // already proves `prior` is defined — an undefined `refusedAtTurn` can
    // never equal a number — and `refusals` is typed `number`, never
    // optional, so a defined `prior` always carries one. A scoped v8 coverage
    // pass on this file (97.63% branch) names the `?? 1` arm's hit count as 0
    // across all 409 swarm tests, including "three finish calls in ONE turn"
    // below, the test this line exists for.
    const nth = sameTurn ? (prior?.refusals ?? 1) : (prior?.refusals ?? 0) + 1
    ctx.control.gate = {
      refusals: nth,
      objections: prior?.objections ?? objections, // the first refusal's sentences are the record
      carried: [],
      refusedFinish: { reason: input.reason, summary: input.summary, unresolved: [...input.unresolved] },
      // `prior?.workAtRefusal ?? workLog.length`'s `??` arm is dead for the
      // same reason plus one more: the only OTHER site that creates a gate
      // record (below, `workAtRefusal: null`) always coincides with
      // `ctx.control.finished` being set in that same call, which blocks
      // every later call at the top-of-function guard before it could read
      // this `prior` again. So a `prior` reached via `sameTurn===true` was
      // always created HERE, on an earlier call, and always carries a real
      // number.
      workAtRefusal: sameTurn ? (prior?.workAtRefusal ?? workLog.length) : workLog.length,
      workAnswered: 0,
      answeredBy: [],
      refusedAtTurn: reading.turns,
      stood: null,
    }
    // The lead's next turn IS the answer to this refusal, and it is immediate:
    // any standing re-entry condition is cleared. Never replaced with one of
    // the gate's own — see "why no wait-for-the-landing branch" above.
    ctx.control.next = null
    const facts = nth > 1 ? [GATE_NO_WORK_SENTENCE, ...objections] : objections
    return { ok: false, reason: `${facts.join("; ")}${GATE_REFUSAL_TAIL}`, poolLeftUsd }
  }
  if (reading !== undefined && stood !== null) {
    // The record, on every accepted finish that had an instrument to read:
    // which standing sentences the lead's unresolved[] left out, what the
    // refusals bought, and which rule let this finish through. The lead's
    // array itself is never touched — serialization labels the carried ones.
    const carried = objections.filter((o) => !input.unresolved.includes(o))
    if (prior) {
      prior.carried = carried // objections keep the first refusal's record
      prior.workAnswered = Math.max(0, workSince)
      // The receipt, not a recount: the log is append-only, so everything past
      // the length the refusal froze is what the refusal bought.
      //
      // `owed === null` is the same dead arm documented above, reached from
      // the other direction: `prior` here can only be the refusal-created
      // record (never the `workAtRefusal: null` one below, which ends the run
      // in the same call it is created), and that record's `workAtRefusal` is
      // never null.
      prior.answeredBy = owed === null ? [] : [...workLog.slice(owed)]
      prior.stood = stood
    } else {
      ctx.control.gate = {
        refusals: 0,
        objections,
        carried,
        refusedFinish: null,
        workAtRefusal: null,
        workAnswered: 0,
        answeredBy: [],
        refusedAtTurn: null,
        stood,
      }
    }
  }
  ctx.control.finished = { reason: input.reason, summary: input.summary, unresolved: [...input.unresolved] }
  ctx.control.next = null
  return { ok: true, poolLeftUsd }
}
