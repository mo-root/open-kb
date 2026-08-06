import {
  ALLOWANCES,
  answerKeyRecall,
  Board,
  BreakerTable,
  computeScorecard,
  Ledger,
  registrableHost,
  SCORECARD_DEFAULTS,
  scorecardObjections,
  scorecardSentences,
  type BoardRow,
  type FamilyRow,
  type FetchPort,
  type Mission,
  type MissionTier,
  type Scorecard,
  type ScorecardConfig,
  type ScorecardInput,
  type SearchPort,
  type SpanKind,
  type SpanStream,
} from "@open-kb/core"
import type { LanguageModel } from "ai"
import { RunEvidence, recallProbePool } from "./run-evidence.js"
import { MapState } from "./map.js"
import { FamilyLedger } from "./family-ledger.js"
import { DEFAULT_FAMILY_FLOOR, FAMILY_FLOOR_MAX, familyProfileFrom, seedFamilyMissions } from "./seed-families.js"
import { sweepSeedMissions, type SweepRunLike } from "./from-sweep.js"
import { newRunControl, spawnTool, type FinishState, type RunControl } from "./tools-control.js"
import type { SearchTrace } from "./tools-free.js"
import {
  LEAD_TURN_CAP,
  TIER_DEADLINE_MS,
  runInvestigator,
  runLead,
  type AgentHooks,
  type InvestigatorDeps,
  type InvestigatorDigest,
  type LeadTurnOutcome,
  type ModelPricing,
  type SwarmAgentDeps,
} from "./agent.js"

/**
 * The orchestrator. It is a while loop: FILL lanes greedily, THINK when the
 * lead's own condition is met, WAKE on the first landing of anything. Nothing
 * barriers — an investigator landing while the lead thinks is the normal case,
 * not an edge case.
 *
 * What it decides is arithmetic and set membership: which lane is free, which
 * board item's allowance fits inside spendable, whether a key is claimed,
 * whether a breaker is open, whether the lead's turn is affordable and due,
 * when to stop popping. What it NEVER decides: what anything sells, what to
 * search, what a priority is. It performs argmax and narrates the one honest
 * departure — popAffordable scanning down past an unaffordable item — every
 * time it happens, on screen and in-band to the lead.
 */

// ── config ───────────────────────────────────────────────────────────────────

export const DEFAULT_CEILING_USD = 1.5
export const DEFAULT_LANES = 6
export const DEFAULT_WALL_MS = 300_000
export const DEFAULT_GRACE_MS = 30_000
export const DEFAULT_STILLBORN_MS = 30_000
/** In-band warning lead time before the wall: "45 seconds left; call finish". */
export const WALL_WARN_BEFORE_MS = 45_000

const EPSILON = 1e-9

// ── shapes ───────────────────────────────────────────────────────────────────

export type SwarmEndReason =
  | "lead-finished"
  | "budget-floor"
  | "wall-clock"
  | "turn-cap"
  | "lead-fault"
  | "stillborn"
  | "aborted"

/** Every ending emits this; all seven produce a complete, renderable artifact. */
export interface SwarmEnding {
  kind: "terminated"
  reason: SwarmEndReason
  humanReason: string
  atSec: number
  spentUsd: number
  nodes: number
  edges: number
  /** Every unreached board item with its author's priority and reason —
   *  "here is precisely what we would have done next, ranked." */
  residue: BoardRow[]
}

export interface MissionLanding {
  mission: Mission
  digest: InvestigatorDigest
  actualUsd: number
  atSec: number
}

/** Counters accumulated as the run spends, never reconstructed afterwards. */
export interface SwarmTally {
  tokIn: number
  tokOut: number
  modelCalls: number
  serpCalls: number
  fetchCalls: number
  unlockerCalls: number
  leadTurns: number
}

export interface SwarmRun {
  ending: SwarmEnding
  /** The lead's own words, when it called finish; printed verbatim above the map. */
  finish: FinishState | null
  map: MapState
  evidence: RunEvidence
  board: Board
  ledger: Ledger
  control: RunControl
  searches: SearchTrace[]
  seen: Set<string>
  landings: MissionLanding[]
  /** The planned questions — one row per lead-band mission, the seed included,
   *  killed rows kept with their because. Read off the family ledger at the
   *  end, pageTierNodes from the map's writer stamps. The SAME array
   *  `scorecard.families` holds — one computation, one truth. */
  families: FamilyRow[]
  /** T6: the scorecard computed ONCE at the ending, after the drain — the
   *  same fold of live state (family rows, entities, ledger, landings,
   *  recall) the in-band block read every think turn, frozen for the report. */
  scorecard: Scorecard
  /** The thresholds the finish gate ran with; serialized beside the numbers. */
  scorecardConfig: ScorecardConfig
  tally: SwarmTally
  seconds: number
}

export interface SwarmOptions {
  domain: string
  /** The skill file's text — the runner never reads disk. */
  skill: string
  search: SearchPort
  fetch: FetchPort
  models: { lead: LanguageModel } & Record<MissionTier, LanguageModel>
  pricing: { lead: ModelPricing } & Record<MissionTier, ModelPricing>
  ceilingUsd?: number
  lanes?: number
  wallClockMs?: number
  graceMs?: number
  stillbornWindowMs?: number
  /**
   * Per-tier investigator deadlines (ms), merged over TIER_DEADLINE_MS's
   * measured defaults (60s peek / 180s read / 300s dig — the citations live
   * on the record itself). The tier walls are config, not law.
   */
  deadlines?: Partial<Record<MissionTier, number>>
  /**
   * The directory-shape gate's N (outbound hosts before a front page reads as
   * a document). DEFAULT NULL: calibration found no separation between vendor
   * and directory front pages on the measured sample, so the rule ships off
   * rather than shipping a guessed number. The readable-listicle defense in
   * the meantime is verification peeks + retraction, which the lead spawns
   * per the skill.
   */
  aggregatorThreshold?: number | null
  /**
   * Thresholds that arm the finish gate (T5), merged over the measured
   * defaults (SCORECARD_DEFAULTS). Set every field null to silence the gate
   * entirely — the escape hatch the design priced at one config flag.
   */
  scorecardConfig?: Partial<ScorecardConfig>
  /**
   * The family floor ("families survive as a code floor"): when the seed
   * landing arrives, the orchestrator templates this many band-61..70 read
   * missions from the orient answer and funds them through the normal spawn
   * economics — questions that exist regardless of what the lead chooses to
   * spawn (run 3's board went dry: 12 nodes, 3 of 6 lanes ever used). `true`
   * or absent means DEFAULT_FAMILY_FLOOR (4); a number sizes it (clamped to
   * the 5-template deck); `false` or 0 disables it. The lead can review,
   * re-rank or kill the floor's rows — they are ordinary board items.
   */
  familyFloor?: boolean | number
  /**
   * The sweep→swarm handoff: a prior sweep run of the SAME domain, as its
   * JSON serialized it. When present, the orchestrator mints board missions
   * from it the moment orientation lands — peek missions that verify the
   * sweep's head on the vendors' own pages, read missions that chase what the
   * sweep left unknown, a recall-gap mission when the sweep's own probes say
   * the map under-reached — funded through the normal spawn economics and
   * counted into the family ledger (they are questions). The run is CONTEXT,
   * never claims: the swarm map starts empty and re-proves everything
   * (from-sweep.ts carries the full honesty line). With a handoff in play the
   * family floor DEFAULTS OFF — the sweep's breadth IS the family questions
   * answered, and the handoff pool should buy what the sweep could not:
   * proof. An explicit `familyFloor` beside `fromSweep` restores it.
   */
  fromSweep?: SweepRunLike
  pendingAfterMs?: number
  spans?: SpanStream
  onLog?: (line: string) => void
  runId?: string
  signal?: AbortSignal
}

// ── the seed ─────────────────────────────────────────────────────────────────

/**
 * The first mission the harness itself writes: the orient question, the
 * design's p100 dig. Everything else de-brands from its answer — when it
 * lands, the family floor (seed-families.ts) templates the market's boring
 * questions from whatever it left. Deliberately a question, not a plan.
 */
export function seedMission(domain: string): Mission {
  const host = registrableHost(domain) || domain
  return {
    lens: "orientation",
    brief:
      `Open ${host}'s own pages and answer: what does it sell, to whom, against whom, and in ` +
      `which words? Record the company and its products with quotes, note its coinages and the ` +
      `generic words behind each, and propose the questions the map needs asked next.`,
    why: "every other question de-brands from this answer; nothing can be asked before it",
    priority: 100,
    tier: "dig",
    dedupeKey: `orient:${host}`,
    seeds: [`https://${host}`],
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const TOOL_SPAN_KIND: Record<string, SpanKind> = {
  search: "search",
  fetch: "fetch",
  read: "read",
  recall: "read",
  remember: "remember",
  spawn: "spawn",
  propose: "spawn",
  review: "spawn",
  next: "spawn",
  finish: "spawn",
}

const isAbortError = (e: unknown): boolean => {
  const err = e as { name?: string; message?: string }
  return err?.name === "AbortError" || /abort/i.test(String(err?.message ?? ""))
}

type Wake =
  | { type: "mission"; key: string; mission: Mission; digest: InvestigatorDigest; actualUsd: number }
  | { type: "lead"; outcome: LeadTurnOutcome }
  | { type: "lead-fault"; error: unknown }
  | { type: "timer" }
  | { type: "caller-abort" }

// ── the run ──────────────────────────────────────────────────────────────────

export async function runSwarm(opts: SwarmOptions): Promise<SwarmRun> {
  const t0 = Date.now()
  const sec = () => (Date.now() - t0) / 1000
  const say = (msg: string) => opts.onLog?.(`${String(Math.round(sec())).padStart(3)}s  ${msg}`)
  const runId = opts.runId ?? `swarm-${t0}`

  const ceilingUsd = opts.ceilingUsd ?? DEFAULT_CEILING_USD
  const laneCap = Math.max(1, opts.lanes ?? DEFAULT_LANES)
  const wallMs = opts.wallClockMs ?? DEFAULT_WALL_MS
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const stillbornMs = opts.stillbornWindowMs ?? DEFAULT_STILLBORN_MS
  /** Each tier's wall, caller-tuned over the measured defaults. */
  const tierDeadlineMs: Record<MissionTier, number> = { ...TIER_DEADLINE_MS, ...opts.deadlines }
  /** The family floor's size: default ON at DEFAULT_FAMILY_FLOOR, clamped to
   *  the deck — except under a sweep handoff, where the unset default is OFF:
   *  the sweep already asked the family questions at scale, and re-templating
   *  "best X" would spend the handoff pool re-buying the breadth the run file
   *  imports as context. Setting familyFloor explicitly restores it. */
  const familyFloorCount =
    opts.familyFloor === false
      ? 0
      : opts.familyFloor === true
        ? DEFAULT_FAMILY_FLOOR
        : opts.familyFloor === undefined
          ? opts.fromSweep
            ? 0
            : DEFAULT_FAMILY_FLOOR
          : Math.max(0, Math.min(FAMILY_FLOOR_MAX, Math.floor(opts.familyFloor)))

  const anchor = registrableHost(opts.domain) || opts.domain
  const ledger = new Ledger(ceilingUsd)
  const board = new Board()
  const evidence = new RunEvidence()
  const map = new MapState(opts.domain)
  const families = new FamilyLedger()
  const control = newRunControl()
  const breaker = new BreakerTable()
  const seen = new Set<string>()
  const searches: SearchTrace[] = []
  const landings: MissionLanding[] = []
  const tally: SwarmTally = {
    tokIn: 0,
    tokOut: 0,
    modelCalls: 0,
    serpCalls: 0,
    fetchCalls: 0,
    unlockerCalls: 0,
    leadTurns: 0,
  }

  /** The run's own abort: the wall's hard cancel, stillborn, and the caller's
   *  signal all land here, and every lane and model call hears it. */
  const aborter = new AbortController()

  // ── billing: nothing invisible ───────────────────────────────────────────
  // S6's hooks carry no tool dollars, so the ports are where paid spend lands
  // on the span stream — one span per SERP row and per fetch, with the real
  // usd the provider reported. Model calls ride through onModel. Tool calls
  // narrate at $0: their money already crossed the stream at the port.

  const emit = (input: {
    agentId: string
    kind: SpanKind
    name: string
    argsDigest: string
    ms: number
    ok: boolean
    usd: number
    tokensIn?: number
    tokensOut?: number
    error?: string
  }) => opts.spans?.emit({ runId, parentId: null, ...input })

  const search: SearchPort = {
    async search(queries) {
      const started = Date.now()
      try {
        const results = await opts.search.search(queries)
        for (const r of results) {
          tally.serpCalls += 1
          emit({ agentId: "swarm", kind: "search", name: "serp", argsDigest: r.query, ms: r.ms, ok: r.ok, usd: r.usd })
        }
        return results
      } catch (e) {
        emit({
          agentId: "swarm",
          kind: "search",
          name: "serp",
          argsDigest: queries.join(" | ").slice(0, 200),
          ms: Date.now() - started,
          ok: false,
          usd: 0,
          error: String((e as Error)?.message ?? e),
        })
        throw e
      }
    },
  }

  const fetchPort: FetchPort = {
    async get(url, mode, o) {
      const started = Date.now()
      try {
        const raw = await opts.fetch.get(url, mode, o)
        tally.fetchCalls += 1
        if (mode === "unlocked") tally.unlockerCalls += 1
        emit({
          agentId: "swarm",
          kind: "fetch",
          name: mode === "unlocked" ? "unlocker" : "fetch",
          argsDigest: url,
          ms: raw.ms,
          ok: raw.httpStatus > 0,
          usd: raw.usd,
        })
        return raw
      } catch (e) {
        emit({
          agentId: "swarm",
          kind: "fetch",
          name: mode === "unlocked" ? "unlocker" : "fetch",
          argsDigest: url,
          ms: Date.now() - started,
          ok: false,
          usd: 0,
          error: String((e as Error)?.message ?? e),
        })
        throw e
      }
    },
  }

  /** Spawn activity since the lead's last narrated turn. Only the lead holds
   *  the spawn tool, so no attribution is needed; the counts ride the turn
   *  line — zeros included, because run 1's silent zero was the failure. */
  const turnSpawns = { queued: 0, refused: 0 }

  const hooks: AgentHooks = {
    onModel: (i) => {
      tally.modelCalls += 1
      tally.tokIn += i.tokensIn
      tally.tokOut += i.tokensOut
      emit({
        agentId: i.role,
        kind: "model",
        name: i.label,
        argsDigest: "",
        ms: i.ms,
        ok: i.ok,
        usd: i.usd,
        tokensIn: i.tokensIn,
        tokensOut: i.tokensOut,
      })
    },
    onTool: (i) => {
      if (i.tool === "spawn" && i.spawn) {
        turnSpawns.queued += i.spawn.queued
        turnSpawns.refused += i.spawn.refused
      }
      emit({
        agentId: "swarm",
        kind: TOOL_SPAN_KIND[i.tool] ?? "spawn",
        name: i.tool,
        argsDigest: `${i.why} — ${i.argsDigest}`.slice(0, 300),
        ms: i.ms,
        ok: i.ok,
        usd: 0,
      })
    },
  }

  // ── shared state, one instance of everything ─────────────────────────────

  const base: SwarmAgentDeps = {
    skill: opts.skill,
    ledger,
    evidence,
    map,
    board,
    control,
    breaker,
    search,
    fetch: fetchPort,
    seen,
    searches,
    // Obligation (c): plumbed through, DEFAULT NULL per calibration — a
    // threshold is measured, never guessed.
    aggregatorThreshold: opts.aggregatorThreshold ?? null,
    pendingAfterMs: opts.pendingAfterMs,
    signal: aborter.signal,
    hooks,
    // The family verbs report here: spawn and promote open a row, a review
    // kill closes one wearing the lead's because. Claim and landing
    // transitions are this loop's own observations, called where they happen.
    onFamilyEvent: (e) => families.apply(e),
  }

  /** The anchor's own words, banned from every investigator's queries. The
   *  full coinage list is what orientation writes onto the map; this floor is
   *  what the harness knows before any page is read. */
  const coinages = [...new Set([anchor, opts.domain.toLowerCase(), anchor.split(".")[0] ?? ""])].filter(
    (w) => w.length > 2,
  )

  const scorecardConfig: ScorecardConfig = { ...SCORECARD_DEFAULTS, ...opts.scorecardConfig }

  /** T5: the finish gate's synchronous reading. Everything here is read lazily
   *  at the moment the lead calls finish — the live objections, the turn
   *  arithmetic for amendment 1's cap guard, and the two disarm states: after
   *  the wall warning or the budget-floor wake the harness has already told
   *  the lead to close, and refusing finish then would fight its own words. */
  const gateReading = () => ({
    objections: scorecardObjections(computeScorecard(scorecardInput()), scorecardConfig),
    turns: lead.turns,
    turnCap: LEAD_TURN_CAP,
    disarmed: wallWarned || floorWoken,
  })

  const leadLandings: Promise<void>[] = []
  const lead = runLead({
    ...base,
    trackPending: (p) => leadLandings.push(p),
    domain: opts.domain,
    model: opts.models.lead,
    pricing: opts.pricing.lead,
    scorecard: gateReading,
  })

  // ── the seed: the orient question, funded like any spawned mission ───────
  // Degraded down the ladder (never up) when a small ceiling cannot fund a
  // dig, with the transition said on screen.
  const seed = seedMission(opts.domain)
  {
    const ladder: MissionTier[] = ["dig", "read", "peek"]
    for (const tier of ladder.slice(ladder.indexOf(seed.tier))) {
      const held = ledger.reserve(ALLOWANCES[tier])
      if (!held.ok) continue
      if (tier !== seed.tier) say(`the pool no longer funds a ${seed.tier}; the seed opens as a ${tier}`)
      seed.tier = tier
      board.push(seed, "lead")
      control.claims.set(seed.dedupeKey, held.claimId)
      families.opened(seed.lens, seed.dedupeKey, seed.priority) // family zero — the code floor
      break
    }
    if (!control.claims.has(seed.dedupeKey)) {
      say("the pool cannot fund even a peek; there is nothing to open with")
    }
  }

  // ── loop state ───────────────────────────────────────────────────────────

  const inflight = new Map<string, Promise<Wake>>()
  const startedInfo = new Map<string, { claimId: string; tier: MissionTier }>()
  const settledKeys = new Set<string>()

  let stopping = false
  let stopReason: SwarmEndReason | null = null
  let leadDone = false
  let leadFaults = 0
  let lastFaultMsg = ""
  let landingsSince = 0
  let lastTurnEnd = t0
  let forceDue = false
  let floorWoken = false
  let wallWarned = false
  let wallStopped = false
  let hardCancelled = false
  let cutOffCount = 0
  let stillbornResolved = false
  let seedLanded = false
  let fillDry = false
  let lastDryStamp = ""

  const digestNotes: string[] = []
  const pendingNotes: string[] = []
  /** Per-item skip narration held for the lead's next turn; counts survive
   *  between turns via skipTotals so "skipped 3 times" is cumulative. */
  const skipNotes = new Map<string, { tier: string; priority: number; count: number }>()
  const skipTotals = new Map<string, number>()

  const missionsInFlight = () => inflight.size - (inflight.has("lead") ? 1 : 0)
  const floorHit = () => ledger.spendable() + EPSILON < ALLOWANCES.peek

  const callerAborted: Promise<Wake> = new Promise((resolve) => {
    const s = opts.signal
    if (!s) return
    if (s.aborted) resolve({ type: "caller-abort" })
    else s.addEventListener("abort", () => resolve({ type: "caller-abort" }), { once: true })
  })

  /** Wait for promises to settle, but never past a beat after the run-level
   *  abort: a port that ignores its signal must not hold the ending hostage. */
  const settleWithin = (ps: ReadonlyArray<Promise<unknown>>, graceAfterAbortMs = 1_500): Promise<void> =>
    new Promise((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        aborter.signal.removeEventListener("abort", arm)
        resolve()
      }
      const arm = () => {
        timer = setTimeout(finish, graceAfterAbortMs)
      }
      void Promise.allSettled(ps).then(finish)
      if (aborter.signal.aborted) arm()
      else aborter.signal.addEventListener("abort", arm, { once: true })
    })

  // ── FILL ─────────────────────────────────────────────────────────────────

  const fundedQueuedUsd = (): number => {
    let sum = 0
    for (const row of board.residue()) {
      if (control.claims.has(row.dedupeKey) && !startedInfo.has(row.dedupeKey)) sum += ALLOWANCES[row.tier]
    }
    return sum
  }

  const fillStamp = () => `${board.residue().length}|${ledger.spendable().toFixed(6)}`

  const narrateSkip = (row: BoardRow) => {
    const n = (skipTotals.get(row.dedupeKey) ?? 0) + 1
    skipTotals.set(row.dedupeKey, n)
    skipNotes.set(row.dedupeKey, { tier: row.tier, priority: row.priority, count: n })
    say(
      `the pool no longer funds a ${row.tier}; your p${row.priority} ${row.dedupeKey} has been skipped ` +
        `${n} ${n === 1 ? "time" : "times"}`,
    )
  }

  const launch = (mission: BoardRow, claimId: string) => {
    startedInfo.set(mission.dedupeKey, { claimId, tier: mission.tier })
    families.claimed(mission.dedupeKey) // a proposal's key is not a family; the ledger ignores it

    const missionLandings: Promise<void>[] = []
    const deps: InvestigatorDeps = {
      ...base,
      trackPending: (p) => missionLandings.push(p),
      claimId,
      coinages,
      models: { peek: opts.models.peek, read: opts.models.read, dig: opts.models.dig },
      pricing: { peek: opts.pricing.peek, read: opts.pricing.read, dig: opts.pricing.dig },
      deadlineMs: tierDeadlineMs[mission.tier],
    }
    const p: Promise<Wake> = runInvestigator(mission, deps)
      .catch(
        (e): InvestigatorDigest => ({
          status: "crashed",
          added: { nodes: 0, edges: 0 },
          findings: [String((e as Error)?.message ?? e).slice(0, 120)],
          spentUsd: 0,
        }),
      )
      .then(async (digest) => {
        // OBLIGATION (a): settle at actuals ONLY after this mission's pending
        // fetch landings drain — a late draw must land on the claim before
        // the number that closes it is read off the ledger.
        await settleWithin(missionLandings)
        const room = ledger.draw(claimId, 0)
        const actualUsd = room.ok ? ALLOWANCES[mission.tier] - room.remainingUsd : digest.spentUsd
        ledger.settle(claimId, actualUsd)
        settledKeys.add(mission.dedupeKey)
        // Recorded here, not in the wake handler: a mission that lands during
        // the final drain still belongs to the run's record.
        landings.push({ mission, digest, actualUsd, atSec: sec() })
        families.landed(mission.dedupeKey, digest.added.nodes)
        say(
          `lane frees: ${mission.lens} (${mission.dedupeKey}) — ${digest.status}, ` +
            `+${digest.added.nodes} nodes +${digest.added.edges} edges, $${actualUsd.toFixed(3)}`,
        )
        return { type: "mission" as const, key: mission.dedupeKey, mission, digest, actualUsd }
      })
    inflight.set(mission.dedupeKey, p)
  }

  const fill = () => {
    while (!stopping && !control.finished && missionsInFlight() < laneCap) {
      // Spawn-time reservations already hold each lead mission's allowance out
      // of spendable(); handing popAffordable the bare figure would demand the
      // same money twice. The funded-queued sum rides back in — and because
      // every funded mission outranks every unfunded proposal (bands 61-100
      // vs 1-60), an unfunded item is only reached once that sum is zero, so
      // its own check stays exact.
      const eff = ledger.spendable() + fundedQueuedUsd()
      const { mission, skipped } = board.popAffordable(eff, ALLOWANCES)
      for (const s of skipped) narrateSkip(s)
      if (!mission) {
        fillDry = true
        break
      }
      fillDry = false
      let claimId = control.claims.get(mission.dedupeKey)
      if (claimId === undefined) {
        const held = ledger.reserve(ALLOWANCES[mission.tier])
        if (!held.ok) {
          board.release(mission.dedupeKey)
          say(`"${mission.dedupeKey}" popped but cannot be funded: ${held.reason}`)
          fillDry = true
          break
        }
        claimId = held.claimId
        control.claims.set(mission.dedupeKey, claimId)
      }
      launch(mission, claimId)
      say(`lane takes p${mission.priority} ${mission.dedupeKey} (${mission.tier}${mission.unreviewed ? ", unreviewed" : ""})`)
    }
  }

  // ── THINK ────────────────────────────────────────────────────────────────

  const due = (): boolean => {
    if (leadDone || control.finished) return false
    if (forceDue) return true
    const n = control.next
    if (n === null) return true
    if (n.landings !== undefined && landingsSince >= n.landings) return true
    if (n.seconds !== undefined && (Date.now() - lastTurnEnd) / 1000 >= n.seconds) return true
    // The harness also wakes the lead when the board runs dry of anything fundable.
    if (missionsInFlight() === 0 && fillDry) return true
    return false
  }

  /** Live state folded into the scorecard's plain input, fresh at every think
   *  turn: family rows lazily off the writer stamps, per-landing node yield
   *  off the landings record, recall over the same anchor-excluded probe pool
   *  serialization uses — so the number the lead sees mid-run is the number
   *  the report ships. */
  const scorecardInput = (): ScorecardInput => {
    const live = [...map.nodes.values()].filter((n) => !n.retracted)
    // Recall grades the map's VENDORS, the same host set serialize.ts builds
    // from the map's own vocabulary (company/product).
    const mapHosts = new Set(
      live.filter((n) => n.kind === "company" || n.kind === "product").map((n) => registrableHost(n.domain || n.name)),
    )
    return {
      families: families.rows(map),
      entities: live.map((n) => ({ tier: n.tier, sources: new Set(n.evidence.map((e) => e.url)).size })),
      spendableUsd: ledger.spendable(),
      ceilingUsd,
      spentUsd: ledger.spentUsd(),
      elapsedMs: Date.now() - t0,
      wallMs,
      yieldHistory: landings.map((l) => l.digest.added.nodes),
      recall: answerKeyRecall(recallProbePool(evidence, anchor), { anchor: map.anchor, mapHosts }),
    }
  }

  const composeNotes = (): string[] => {
    const notes = digestNotes.splice(0)
    for (const [key, s] of skipNotes) {
      notes.push(
        `your p${s.priority} ${key} was skipped ${s.count} ${s.count === 1 ? "time" : "times"} for ` +
          `affordability; the pool no longer funds a ${s.tier}`,
      )
    }
    skipNotes.clear()
    // The scorecard: every number computed by code from run state, in front of
    // the lead on every think turn before any conclusion is drawn — facts,
    // never verdicts. The old inline yield-curve narration lives inside it now
    // as the scorecard's yield sentence: one voice, no duplicate.
    notes.push(...scorecardSentences(computeScorecard(scorecardInput())))
    notes.push(...pendingNotes.splice(0))
    return notes
  }

  // ── the family floor ─────────────────────────────────────────────────────

  /**
   * "Families survive as a code floor": fired once, on the seed's landing.
   * The profile is read mechanically off what the orient landing left on the
   * map (no model call — this IS the floor), the missions are templated from
   * core's family shapes, and the funding goes through spawnTool — the same
   * reserve-at-push economics, the same board band, the same family-ledger
   * rows, the same refusal sentences — so a floor mission is indistinguishable
   * from a lead spawn everywhere downstream, including the scorecard's
   * denominator. Partial funding is narrated per mission, in priority order,
   * on screen and in the lead's next notes.
   */
  let floorOpened = false
  const openFamilyFloor = () => {
    if (floorOpened || familyFloorCount === 0) return
    floorOpened = true
    const profile = familyProfileFrom(map, { writers: [seed.dedupeKey, "lead"], coinages })
    if (!profile) {
      say("family floor: the orient landing left no de-branded text on the map; there is nothing to template from")
      return
    }
    const missions = seedFamilyMissions(profile, { count: familyFloorCount })
    const out = spawnTool(
      { board, ledger, control, onFamilyEvent: (e) => families.apply(e) },
      { missions, why: "the family floor: questions that exist regardless of what the lead chooses to spawn" },
    )
    for (const f of out.queued) {
      const m = missions[f.i]!
      say(`family floor: p${m.priority} ${m.dedupeKey} funded (${m.tier}) — templated from "${profile.category}" (${profile.source})`)
    }
    for (const r of out.refused) {
      const m = missions[r.i]!
      say(`family floor: ${m.dedupeKey} not funded — ${r.reason}`)
    }
    const queuedKeys = out.queued.map((f) => missions[f.i]!.dedupeKey)
    if (queuedKeys.length > 0) {
      digestNotes.push(
        `the family floor opened ${queuedKeys.length} code-seeded ${queuedKeys.length === 1 ? "question" : "questions"} ` +
          `from "${profile.category}" (${queuedKeys.join(", ")}); they are ordinary board items — review, re-rank or kill them`,
      )
    }
    for (const r of out.refused) {
      digestNotes.push(`the family floor could not fund ${missions[r.i]!.dedupeKey}: ${r.reason}`)
    }
  }

  // ── the sweep handoff ────────────────────────────────────────────────────

  /**
   * The sweep→swarm handoff's board, opened once, in the seed's wake — after
   * orientation on purpose: the stillborn check must resolve before a run
   * file spends the pool on a dead domain, and the lead should hold the
   * orient digest when the handoff's questions appear. Minting is mechanical
   * (from-sweep.ts) and funding goes through spawnTool — the same
   * reserve-at-push economics, board band, family-ledger rows and refusal
   * sentences as a lead spawn — so a handoff mission is indistinguishable
   * downstream, scorecard denominator included. The lead can review, re-rank
   * or kill any of it.
   */
  let sweepOpened = false
  const openSweepSeeds = () => {
    if (sweepOpened || !opts.fromSweep) return
    sweepOpened = true
    const missions = sweepSeedMissions(opts.fromSweep, { anchor, coinages })
    if (missions.length === 0) {
      say("sweep handoff: the sweep run offered nothing to verify or chase; the board opens on the lead's judgement alone")
      return
    }
    const out = spawnTool(
      { board, ledger, control, onFamilyEvent: (e) => families.apply(e) },
      { missions, why: "the sweep handoff: verify the head, chase the gaps — the sweep run is the brief, never the proof" },
    )
    for (const f of out.queued) {
      const m = missions[f.i]!
      say(`sweep handoff: p${m.priority} ${m.dedupeKey} funded (${m.tier})`)
    }
    for (const r of out.refused) {
      const m = missions[r.i]!
      say(`sweep handoff: ${m.dedupeKey} not funded — ${r.reason}`)
    }
    const queuedKeys = out.queued.map((f) => missions[f.i]!.dedupeKey)
    if (queuedKeys.length > 0) {
      digestNotes.push(
        `the sweep handoff opened ${queuedKeys.length} ${queuedKeys.length === 1 ? "mission" : "missions"} from a ` +
          `prior sweep of this market (${queuedKeys.join(", ")}); the sweep run is context, never claims — its ` +
          `findings enter the map only when an investigator re-proves them — and these are ordinary board items: ` +
          `review, re-rank or kill them`,
      )
    }
    for (const r of out.refused) {
      digestNotes.push(`the sweep handoff could not fund ${missions[r.i]!.dedupeKey}: ${r.reason}`)
    }
  }

  // ── endings ──────────────────────────────────────────────────────────────

  const humanFor = (reason: SwarmEndReason): string => {
    switch (reason) {
      case "lead-finished":
        return control.finished ? `The lead stopped: ${control.finished.reason}` : "The lead stopped."
      case "budget-floor":
        return (
          `Out of budget at $${ceilingUsd.toFixed(2)}. The map below is what $${ceilingUsd.toFixed(2)} ` +
          `bought; the residue is what it did not reach.`
        )
      case "wall-clock":
        return (
          `The wall clock ended the run at ${Math.round(wallMs / 1000)}s; ${cutOffCount} in-flight ` +
          `${cutOffCount === 1 ? "call was" : "calls were"} cut off after the ${Math.round(graceMs / 1000)}s ` +
          `grace. Partial writes stand.`
        )
      case "turn-cap":
        return (
          `The lead thought ${LEAD_TURN_CAP} turns without finishing — the loop detector fired. ` +
          `This is a skill bug, not a budget; the map holds everything that landed.`
        )
      case "lead-fault":
        return (
          `The lead failed twice in a row (${lastFaultMsg || "no message"}); the blast radius is one ` +
          `turn of planning — every landed mission stands.`
        )
      case "stillborn":
        return "Nothing at this domain could be read; there is no map to build from here."
      case "aborted":
        return "The caller cancelled the run; partial writes stand."
    }
  }

  /** OBLIGATION (b) plus the defensive sweep: a mission killed while QUEUED —
   *  claimed-but-never-run — settles at $0, and a started mission whose own
   *  settle was cut off closes at what was actually drawn. */
  const closeClaims = () => {
    for (const [key, claimId] of control.claims) {
      if (!startedInfo.has(key)) ledger.settle(claimId, 0)
    }
    for (const [key, info] of startedInfo) {
      if (settledKeys.has(key)) continue
      const room = ledger.draw(info.claimId, 0)
      if (room.ok) {
        ledger.settle(info.claimId, ALLOWANCES[info.tier] - room.remainingUsd)
        settledKeys.add(key)
      }
    }
  }

  const makeEnding = (reason: SwarmEndReason): SwarmEnding => ({
    kind: "terminated",
    reason,
    humanReason: humanFor(reason),
    atSec: Math.round(sec() * 10) / 10,
    spentUsd: Math.round(ledger.spentUsd() * 1e4) / 1e4,
    nodes: map.entities().length,
    edges: map.entityEdges().length,
    residue: board.residue(),
  })

  /** Every ending but `aborted` goes through this drain-then-settle path:
   *  in-flight work lands, the lead's deferred settles get their landings,
   *  and only then are the claims closed and the numbers read. */
  const endRun = async (reason: SwarmEndReason): Promise<SwarmRun> => {
    stopping = true
    if (reason === "stillborn") aborter.abort()
    await settleWithin([...inflight.values()])
    await settleWithin(leadLandings)
    // Two microtask hops: runLead's own allSettled continuation settles its
    // turn claim on the same landings this just awaited.
    await Promise.resolve()
    await Promise.resolve()
    closeClaims()
    // The ending's scorecard: computed once, here, after the drain and the
    // claim close — the same fold the last think turn read, now over settled
    // money. Serialization ships THIS object; nothing recomputes downstream.
    const scorecard = computeScorecard(scorecardInput())
    const ending = makeEnding(reason)
    say(ending.humanReason)
    say(
      `terminated: ${reason} at ${ending.atSec}s — $${ending.spentUsd.toFixed(4)}, ` +
        `${ending.nodes} nodes, ${ending.edges} edges, ${ending.residue.length} residue`,
    )
    return {
      ending,
      finish: control.finished,
      map,
      evidence,
      board,
      ledger,
      control,
      searches,
      seen,
      landings,
      families: scorecard.families,
      scorecard,
      scorecardConfig,
      tally,
      seconds: sec(),
    }
  }

  /** The caller hung up. Cancel everything, close the books, write the
   *  terminal frame to the log — then reject the way the sweep does. */
  const abortedEnd = async (): Promise<never> => {
    stopping = true
    aborter.abort()
    await settleWithin([...inflight.values()])
    closeClaims()
    const ending = makeEnding("aborted")
    say(ending.humanReason)
    throw Object.assign(new Error("aborted"), { ending })
  }

  // ── the while loop ───────────────────────────────────────────────────────

  say(`swarm on ${anchor}: ceiling $${ceilingUsd.toFixed(2)}, ${laneCap} lanes, wall ${Math.round(wallMs / 1000)}s`)

  for (;;) {
    const now = Date.now()

    if (opts.signal?.aborted) return await abortedEnd()

    // Stillborn: inside the first window, no readable seed-host page AND the
    // identification SERP returned nothing. Decided as soon as the seed lands
    // empty-handed, or at the window's edge, whichever comes first.
    if (!stillbornResolved) {
      if (evidence.ownPage(anchor) !== null || searches.some((s) => s.urls.length > 0)) {
        stillbornResolved = true
      } else if (now >= t0 + stillbornMs || seedLanded) {
        return await endRun("stillborn")
      }
    }

    // Wall clock: warn in-band at T-45s, halt popping at T, drain with grace,
    // hard-cancel after it — partial writes stand.
    if (wallMs > WALL_WARN_BEFORE_MS && !wallWarned && now >= t0 + wallMs - WALL_WARN_BEFORE_MS) {
      wallWarned = true
      forceDue = true
      pendingNotes.push(`${Math.round(WALL_WARN_BEFORE_MS / 1000)} seconds left; call finish`)
      say("45 seconds left on the wall clock; the lead is told to close")
    }
    if (!wallStopped && now >= t0 + wallMs) {
      wallStopped = true
      if (!stopping) {
        stopping = true
        stopReason = "wall-clock"
      }
      say(
        `the wall clock struck at ${Math.round(wallMs / 1000)}s; ${missionsInFlight()} in flight drain ` +
          `with ${Math.round(graceMs / 1000)}s grace`,
      )
    }
    if (wallStopped && !hardCancelled && now >= t0 + wallMs + graceMs) {
      hardCancelled = true
      cutOffCount = missionsInFlight() + (inflight.has("lead") ? 1 : 0)
      say(`grace spent; ${cutOffCount} in-flight cancelled — partial writes stand`)
      aborter.abort()
    }

    // The lead said finish: nothing new is funded, lanes drain, then ending 1.
    if (control.finished && !stopping) {
      stopping = true
      stopReason = "lead-finished"
      say(`the lead finished: ${control.finished.reason}`)
    }

    // FILL — greedily, never waits. Skipped when the last attempt came up dry
    // and neither the board nor the pool has changed since: a skip event is a
    // pop that passed something over, not a wake that found nothing new.
    if (!stopping && !control.finished) {
      if (!(fillDry && fillStamp() === lastDryStamp)) fill()
      if (fillDry) lastDryStamp = fillStamp()
    }

    // Budget floor: the pool no longer funds even a peek. The lead is woken
    // once with the fact; the ending arrives via its closing turn.
    if (!stopping && !floorWoken && floorHit()) {
      floorWoken = true
      forceDue = true
      pendingNotes.push(
        `the pool is below the price of a peek ($${ALLOWANCES.peek.toFixed(2)}); nothing new can be ` +
          `funded — close the run or re-tier what is queued`,
      )
      say(`budget floor: $${ledger.spendable().toFixed(2)} spendable is below a peek`)
    }

    // THINK — only when the lead's own condition is met. Landings keep being
    // processed while it thinks: nothing barriers.
    if (!stopping && !leadDone && !control.finished && !inflight.has("lead") && due()) {
      forceDue = false
      const notes = composeNotes()
      const p: Promise<Wake> = lead
        .leadTurn(notes)
        .then((outcome): Wake => ({ type: "lead", outcome }))
        .catch((error): Wake => ({ type: "lead-fault", error }))
      inflight.set("lead", p)
    }

    // Fully drained and stopping: the run is over.
    if (inflight.size === 0) {
      if (stopping) return await endRun(stopReason ?? "budget-floor")
      if (leadDone) return await endRun(stopReason ?? "budget-floor")
    }

    // WAKE — on the first landing of anything, or the next deadline.
    const deadlines: number[] = []
    if (!stillbornResolved) deadlines.push(t0 + stillbornMs)
    if (wallMs > WALL_WARN_BEFORE_MS && !wallWarned) deadlines.push(t0 + wallMs - WALL_WARN_BEFORE_MS)
    if (!wallStopped) deadlines.push(t0 + wallMs)
    else if (!hardCancelled) deadlines.push(t0 + wallMs + graceMs)
    if (!stopping && !leadDone && !control.finished && !inflight.has("lead") && control.next?.seconds !== undefined) {
      deadlines.push(lastTurnEnd + control.next.seconds * 1000)
    }
    if (inflight.size === 0 && deadlines.length === 0) {
      // Nothing flies and nothing ticks: wake the lead rather than hang.
      forceDue = true
      continue
    }

    const waiters: Promise<Wake>[] = [...inflight.values(), callerAborted]
    let timer: ReturnType<typeof setTimeout> | undefined
    if (deadlines.length > 0) {
      const at = Math.min(...deadlines)
      waiters.push(
        new Promise<Wake>((resolve) => {
          timer = setTimeout(() => resolve({ type: "timer" }), Math.max(0, at - Date.now()))
        }),
      )
    }
    const winner = await Promise.race(waiters)
    clearTimeout(timer)

    if (winner.type === "timer" || winner.type === "caller-abort") continue

    if (winner.type === "mission") {
      inflight.delete(winner.key)
      landingsSince += 1
      if (winner.key === seed.dedupeKey) {
        seedLanded = true
        // The handoff and the floor open the moment orientation lands —
        // before this iteration's fill, so their missions ride the same pop
        // the landing freed a lane for. Handoff first: when both are on, the
        // targeted questions take their money before the generic ones, and at
        // equal priority the board's insertion tie-break runs them first too.
        // A stopping or finishing run funds nothing.
        if (!stopping && !control.finished) {
          openSweepSeeds()
          openFamilyFloor()
        }
      }
      const d = winner.digest
      const line =
        `${winner.key} landed: ${d.status}, +${d.added.nodes} nodes +${d.added.edges} edges, ` +
        `$${winner.actualUsd.toFixed(3)}`
      digestNotes.push(d.findings.length ? `${line}\n  ${d.findings.join("\n  ")}` : line)
      continue
    }

    if (winner.type === "lead") {
      inflight.delete("lead")
      leadFaults = 0
      const o = winner.outcome
      if (o.kind === "turn" || o.kind === "closing") {
        tally.leadTurns += 1
        lastTurnEnd = Date.now()
        landingsSince = 0
        say(
          o.kind === "closing"
            ? `lead closing turn: ${o.because}`
            : `lead turn ${o.turn}: $${o.usd.toFixed(3)} — spawned ${turnSpawns.queued}, ` +
                `refused ${turnSpawns.refused}${o.finished ? " — finish called" : ""}`,
        )
        turnSpawns.queued = 0
        turnSpawns.refused = 0
        if (o.kind === "closing" && !stopReason) {
          stopping = true
          stopReason = "budget-floor"
        }
      } else {
        leadDone = true
        if (o.loopDetected) {
          stopping = true
          stopReason = "turn-cap"
          say(o.because)
        } else if (!control.finished && !stopReason) {
          stopping = true
          stopReason = "budget-floor"
        }
      }
      continue
    }

    // winner.type === "lead-fault"
    inflight.delete("lead")
    if (isAbortError(winner.error) || aborter.signal.aborted) continue // the wall or the caller, not the model
    leadFaults += 1
    lastFaultMsg = String((winner.error as Error)?.message ?? winner.error).slice(0, 200)
    say(`lead turn failed (${leadFaults} in a row): ${lastFaultMsg}`)
    if (leadFaults >= 2) {
      stopping = true
      stopReason = "lead-fault"
    } else {
      forceDue = true // one retry; the blast radius is one turn of planning
    }
  }
}
