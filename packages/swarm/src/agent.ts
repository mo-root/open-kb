import { generateObject, generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { z } from "zod"
import {
  ALLOWANCES,
  JUDGED_KINDS,
  JUDGED_RELATIONS,
  render,
  type Board,
  type BreakerTable,
  type FetchPort,
  type KernelStats,
  type Ledger,
  type Mission,
  type MissionTier,
  type ModelPricing,
  type SearchPort,
} from "@open-kb/core"
import { RunEvidence } from "./run-evidence.js"
import { landedBy, MapState } from "./map.js"
import type { FamilyEvent } from "./family-ledger.js"
import {
  readTool,
  recallTool,
  rememberTool,
  type ReadCtx,
  type RecallCtx,
  type RecallInput,
  type RememberCtx,
  type RememberReturn,
  type SearchTrace,
} from "./tools-free.js"
import {
  fetchTool,
  harvestTool,
  searchTool,
  type HarvestClassify,
  type HarvestCtx,
  type PaidCtx,
} from "./tools-paid.js"
import {
  finishTool,
  nextTool,
  proposeTool,
  reviewTool,
  spawnTool,
  type ControlCtx,
  type GateReading,
  type RunControl,
} from "./tools-control.js"

/**
 * The model-conversation runner for both swarm roles. The lead is a metered
 * conversation S7 advances one turn at a time; an investigator is a bounded
 * loop with a wall clock and an allowance. Neither role ever sees a model id —
 * tiers are the only names cost has — and every model call is billed and
 * reported through hooks so the orchestrator can put it on the span stream.
 *
 * The loop is hand-rolled: one `generateText` call per turn, stopped at one
 * step, with the conversation held here. The SDK's own multi-step loop cannot
 * meter a turn before it happens, swap the toolset for the free closing turn,
 * or inject the in-band budget lines the skill promises — so the runner owns
 * the outer loop and the SDK owns exactly one step of it.
 */

// ── constants ────────────────────────────────────────────────────────────────

/**
 * chars/4 is the token estimator. It is the standard rough constant for
 * English-plus-JSON transcripts, it is free, and it is deliberately the same
 * arithmetic everywhere (transcript metering and the digest cap) so the two
 * budgets cannot drift apart. Overestimates slightly on JSON escaping, which
 * errs the meter toward refusing a turn — the safe direction.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Output-token headroom priced into each lead turn. Measured lead turns emit
 * ~200 tokens of tool call; 4x that is a cap, not an estimate, in the ledger's
 * own reserve-generously spirit.
 */
export const LEAD_EST_OUT_TOKENS = 800

/** The design's number: a loop detector, not a budget. Hitting it is loud. */
export const LEAD_TURN_CAP = 24

/** The same detector for an investigator, behind its wall clock and allowance. */
export const INVESTIGATOR_TURN_CAP = 24

/**
 * Hard wall per tier — config with measured defaults, no longer the design's
 * 45/90/150s. The design's numbers priced ~2s model turns; measured
 * investigator turns run 2-20s of model latency with 25-40s SERP waves inside
 * them, and a read mission needs a search, a fetch and 2-4 write turns. At
 * 90s the wall killed 2 of 3 reads in runs/swarm-brightdata-com-202608052348.json
 * (both `timeout` at launch+90s, ~1 node each) and 2 of 2 reads in
 * runs/swarm-resend-com-202608052353.json (both `timeout` at 131.75s, 0 nodes).
 * Override per run via SwarmOptions.deadlines; the orchestrator resolves each
 * mission's figure into InvestigatorDeps.deadlineMs, and this record is the
 * fallback when neither speaks.
 */
export const TIER_DEADLINE_MS: Record<MissionTier, number> = {
  peek: 60_000,
  read: 180_000,
  dig: 300_000,
  // A harvest borrows dig's wall: 40 front pages through a bounded pool plus
  // a model call per residue host is the run's longest single tool call, and
  // the tool settles per host, so a wall kill keeps everything already judged.
  harvest: 300_000,
}

/** A digest is a note to the lead, not a deliverable. Enforced by truncation. */
export const DIGEST_TOKEN_CAP = 120

/** The in-band line after two consecutive paid refusals. The skill teaches the
 *  situation — past the allowance, paid tools refuse and you finish rather than
 *  die — but this exact sentence is the harness's own, not quoted there. */
const SPENT_LINE = "your allowance is spent; finish with what you hold"

// ── deps ─────────────────────────────────────────────────────────────────────

/** Dollars per million tokens. Supplied by the caller: the runner must not know
 *  vendors. Core's shape, re-exported here so the swarm's surface is unchanged
 *  and so this file is not a second place the two field names could be spelled
 *  differently. */
export type { ModelPricing }

/**
 * How S7/S8 hear about spend: one call per model turn, one per tool call.
 * The runner never emits spans itself — it reports, the orchestrator wires
 * the SpanStream, same division as the sweep's bill().
 */
export interface AgentHooks {
  onModel?: (info: {
    role: "lead" | "investigator"
    label: string
    ms: number
    ok: boolean
    tokensIn: number
    tokensOut: number
    usd: number
  }) => void
  onTool?: (info: {
    tool: string
    why: string
    argsDigest: string
    ms: number
    ok: boolean
    /** WHY it was not ok, and what a partly-ok call refused along the way.
     *
     *  Without this, `ok: false` is the whole record. Measured across the seven
     *  stored span streams: 69 of 93 `remember` calls carry `ok: false` and an
     *  empty error, so nothing anywhere says whether the map rejected a quote
     *  it could not find on the page, refused a kind it does not hold, or hit a
     *  bug — and the tool result that DID say lives only in the model's context
     *  and dies with the run. `evidence.ts` warned about exactly this shape:
     *  "a refusal recorded only in the reply is invisible the moment the run
     *  ends". Populated even when `ok` is true, because a call that landed nine
     *  claims and refused one still refused one. */
    error?: string
    /** spawn calls only: how many missions the call queued and how many it
     *  refused — the orchestrator narrates these per lead turn, because a lead
     *  that spawns nothing all run must be visible from the console. */
    spawn?: { queued: number; refused: number }
  }) => void
}

/** The run state both roles share. S7 owns all of it; the runner only acts on it. */
export interface SwarmAgentDeps {
  /** The skill file's text. The runner prefixes one role line; it never reads disk. */
  skill: string
  ledger: Ledger
  evidence: RunEvidence
  map: MapState
  board: Board
  control: RunControl
  breaker: BreakerTable
  search: SearchPort
  fetch: FetchPort
  /** Canonical URLs this run has seen, shared across every lane. */
  seen: Set<string>
  searches: SearchTrace[]
  aggregatorThreshold?: number | null
  pendingAfterMs?: number
  trackPending?: (landing: Promise<void>) => void
  signal?: AbortSignal
  hooks?: AgentHooks
  /** The family ledger's ear (T3), wired into the LEAD's control ctx only —
   *  spawn and review are the family verbs, and propose must never open one. */
  onFamilyEvent?: (event: FamilyEvent) => void
  /** The finish gate's reading (T5), supplied by the orchestrator on the
   *  LEAD's deps only — investigators hold no finish tool to gate. */
  scorecard?: () => GateReading
  /**
   * The harvest tier's classify closure, built by the orchestrator's wiring
   * (makeHarvestClassify over the classify doctrine's composed text). When
   * absent, investigators hold no harvest tool — a run without the doctrine
   * cannot judge residue hosts, and offering a tool that refuses every call
   * would teach the model a dead verb. The lead NEVER holds harvest either
   * way: the lead delegates, and bulk judging from the lead's chair is the
   * one-context-buys-everything failure the skill forbids.
   */
  harvestClassify?: HarvestClassify
  /** Observe each harvest call's kernel stats, for the run-level tally. */
  onHarvest?: (stats: KernelStats, hosts: number) => void
}

export interface LeadDeps extends SwarmAgentDeps {
  domain: string
  model: LanguageModel
  pricing: ModelPricing
  /**
   * A page THE LEAD gained — the sniffer said `found` at page tier and the run
   * held neither that URL nor those bytes (tools-paid.ts `onPageGained`).
   * Fired once per page, never for a fetch CALL: a dead host, a 403, an empty
   * body dressed as success, a re-fetch, an alias and a redirect onto a page
   * already held all complete a call and fire nothing.
   *
   * Declared on the LEAD's deps rather than the shared ones because the finish
   * gate charges the lead: an investigator's ctx must not be able to reach
   * this sink, or a lane's page would pay the lead's debt. A page still in
   * flight past `PENDING_AFTER_MS` fires when it LANDS — the late landing runs
   * the same `settle()` — so a slow page the lead bought still pays, one turn
   * later than it was asked for.
   *
   * `chars` is the length of the extracted text, for the gate's receipt only —
   * see `PaidCtx.onPageGained`, which decides what a gain is.
   */
  onPageGained?: (url: string, chars: number) => void
}

export interface InvestigatorDeps extends SwarmAgentDeps {
  /** The mission's reserved claim — every dollar this runner spends draws on it. */
  claimId: string
  /** The anchor's own words, banned from queries. */
  coinages: string[]
  /** Tier -> model. The prompt only ever says the tier word. `harvest` is
   *  optional and falls back to the read tier's model — a harvest mission's
   *  own conversation is bulk-labeling work, and the cheap tier's economics
   *  are the whole point; the deadline is what borrows dig's. */
  models: Record<Exclude<MissionTier, "harvest">, LanguageModel> & { harvest?: LanguageModel }
  pricing: Record<Exclude<MissionTier, "harvest">, ModelPricing> & { harvest?: ModelPricing }
  /** This mission's resolved wall. The orchestrator supplies it from
   *  SwarmOptions.deadlines merged over TIER_DEADLINE_MS; absent, the tier's
   *  measured default applies. Also the single-mission override in tests. */
  deadlineMs?: number
}

// ── tool wrapping: zod in front of the S4 functions ─────────────────────────

const whyField = z.string().describe("why this call is worth its cost — one sentence a reader sees")

const evidenceRef = z.object({ url: z.string(), quote: z.string() })

// No min/max bounds and no kind/relation enums here: the S4 tools answer
// overflow and bad vocabulary with their own teaching sentences, and a zod
// refusal would preempt them with a stack-shaped error the model retries.
const missionField = z.object({
  lens: z.string(),
  brief: z.string(),
  why: z.string(),
  priority: z.number(),
  tier: z.string().describe("a cost word: peek, read, dig or harvest"),
  dedupeKey: z.string(),
  seeds: z.array(z.string()).optional(),
})

interface WireOpts {
  deps: SwarmAgentDeps
  /** Where paid spend lands. */
  claimId: string
  signal?: AbortSignal
  /** Every paid return, seen by the runner: refusal detection and spend tracking. */
  onPaid?: (spentUsd: number, refusedForAllowance: boolean) => void
  trackPending?: (landing: Promise<void>) => void
  /** A page THIS caller gained, with the length of its extracted text
   *  (tools-paid.ts `onPageGained`). Only the lead wires it: the finish gate
   *  charges the lead, and a shared counter would let an investigator's page
   *  pay the lead's debt. */
  onPageGained?: (url: string, chars: number) => void
}

function makeReport(deps: SwarmAgentDeps) {
  return (
    toolName: string,
    why: string,
    args: unknown,
    started: number,
    ok: boolean,
    spawn?: { queued: number; refused: number },
    error?: string,
  ) =>
    deps.hooks?.onTool?.({
      tool: toolName,
      why,
      argsDigest: JSON.stringify(args).slice(0, 200),
      ms: Date.now() - started,
      ok,
      ...(error ? { error } : {}),
      ...(spawn ? { spawn } : {}),
    })
}

/**
 * What a `remember` call actually did, as one line for the span log.
 *
 * Two things it has to get right, both learned from the stored runs:
 *
 * `ok` is NOT "nothing was rejected". It used to be, and that made a call which
 * landed nine claims and refused one read as a failed call — 69 of 93 remembers
 * across the seven span streams are marked failed, and most of them wrote to
 * the map. A call is ok when something landed, or when there was nothing to
 * reject. It is a failure only when everything it tried was refused.
 *
 * Downgrades are reported even though they LANDED, because a claim that
 * asserted `competitor` and landed as `unknown` is not what the writer thinks
 * it wrote, and the map is the only place that currently knows.
 */
export function rememberOutcome(out: RememberReturn): { ok: boolean; error?: string } {
  const landed =
    out.added.nodes + out.added.edges + out.added.retractions + out.merged.nodes + out.merged.edges
  const ok = landed > 0 || out.rejected.length === 0
  if (out.rejected.length === 0 && out.downgraded.length === 0) return { ok }

  const parts: string[] = []
  if (out.rejected.length > 0) {
    // The reasons themselves, not a count: "3 rejected" sends the next reader
    // back to the code, and the code cannot tell them which three.
    const shown = out.rejected.slice(0, 3).map((r) => `${r.item}: ${r.reason}`)
    const more = out.rejected.length - shown.length
    parts.push(`rejected ${out.rejected.length}/${landed + out.rejected.length} — ${shown.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`)
  }
  if (out.downgraded.length > 0) {
    const shown = out.downgraded.slice(0, 2).map((d) => `${d.key} (${d.relation}): ${d.because}`)
    const more = out.downgraded.length - shown.length
    parts.push(`downgraded ${out.downgraded.length} — ${shown.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`)
  }
  return { ok, error: parts.join(" | ").slice(0, 600) }
}

/** `writer` is who these tools write as — "lead" for the lead's own remembers,
 *  the mission dedupeKey for an investigator — stamped run-local onto every
 *  node the writer adds or merges (MapNode.contributions), so the scorecard
 *  can count each family's page-tier landings and the landing digest can
 *  report the mission's own yield instead of the whole board's. This string is
 *  the mission's identity in both instruments: pass a different one here and
 *  the mission's writes become nobody's. */
function freeTools(deps: SwarmAgentDeps, writer: string): ToolSet {
  const report = makeReport(deps)
  const readCtx: ReadCtx = { evidence: deps.evidence, ledger: deps.ledger }
  const recallCtx: RecallCtx = {
    map: deps.map,
    evidence: deps.evidence,
    ledger: deps.ledger,
    board: deps.board,
    searches: deps.searches,
  }
  const rememberCtx: RememberCtx = {
    map: deps.map,
    evidence: deps.evidence,
    ledger: deps.ledger,
    aggregatorThreshold: deps.aggregatorThreshold,
    writer,
  }

  return {
    read: tool({
      description:
        "FREE. Re-read bytes this run already fetched, by handle: project text, headings, links or raw; grep lines; take a range. Reach for this before fetching anything twice.",
      inputSchema: z.object({
        handle: z.string(),
        project: z.enum(["text", "headings", "links", "raw"]).optional(),
        grep: z.string().optional(),
        range: z.object({ start: z.number(), end: z.number().optional() }).optional(),
        why: whyField,
      }),
      execute: async ({ handle, project, grep, range, why }) => {
        const started = Date.now()
        const out = readTool(readCtx, { handle, project, grep, range })
        report("read", why, { handle, project }, started, out.ok)
        return out
      },
    }),
    recall: tool({
      description:
        "FREE. Ask the map, the board and the search history: find, neighbors, stats, gaps, barren, unread, board. Empty rows, never an error.",
      inputSchema: z.object({
        op: z.enum(["find", "neighbors", "stats", "gaps", "barren", "unread", "board"]),
        q: z.string().optional().describe("for find: the text to look for"),
        key: z.string().optional().describe("for neighbors: the node's key or domain"),
        why: whyField,
      }),
      execute: async ({ op, q, key, why }) => {
        const started = Date.now()
        const input: RecallInput =
          op === "find" ? { op, q: q ?? "" } : op === "neighbors" ? { op, key: key ?? "" } : { op }
        const out = recallTool(recallCtx, input)
        report("recall", why, { op }, started, true)
        return out
      },
    }),
    remember: tool({
      description:
        "FREE, and the only writer. Every claim needs a quote from a URL this run fetched — search hits count at the snippet tier. Rejections are sentences to act on; fix the one claim, keep the batch.",
      inputSchema: z.object({
        nodes: z
          .array(
            z.object({
              name: z.string(),
              domain: z.string(),
              kind: z.string().describe("one of the map's kinds — the skill names them"),
              what: z.string(),
              relation: z.string().describe("stated from the anchor outward — the skill names the set"),
              why: z.string().describe("how it relates, not that it resembles"),
              evidence: z.array(evidenceRef),
            }),
          )
          .optional(),
        edges: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              relation: z.string(),
              why: z.string(),
              confidence: z.enum(["measured", "inferred"]).optional(),
              evidence: z.array(evidenceRef).optional(),
            }),
          )
          .optional(),
        retract: z
          .array(
            z.object({
              node: z.string().optional(),
              edge: z.object({ from: z.string(), to: z.string(), relation: z.string().optional() }).optional(),
              why: z.string(),
            }),
          )
          .optional(),
        why: whyField,
      }),
      execute: async ({ nodes, edges, retract, why }) => {
        const started = Date.now()
        const out = rememberTool(rememberCtx, { nodes, edges, retract, why })
        const { ok, error } = rememberOutcome(out)
        report("remember", why, { nodes: nodes?.length ?? 0, edges: edges?.length ?? 0 }, started, ok, undefined, error)
        return out
      },
    }),
  }
}

function paidTools(wire: WireOpts): ToolSet {
  const { deps } = wire
  const report = makeReport(deps)
  const paidCtx: PaidCtx = {
    search: deps.search,
    fetch: deps.fetch,
    evidence: deps.evidence,
    ledger: deps.ledger,
    claimId: wire.claimId,
    breaker: deps.breaker,
    seen: deps.seen,
    searches: deps.searches,
    signal: wire.signal ?? deps.signal,
    pendingAfterMs: deps.pendingAfterMs,
    trackPending: wire.trackPending ?? deps.trackPending,
    ...(wire.onPageGained ? { onPageGained: wire.onPageGained } : {}),
  }

  return {
    search: tool({
      description:
        "Buy web searches. One call carries a whole wave of queries, sent to the engine exactly as written. Every hit comes back with a snippet-tier evidence handle — quoting it is a real citation.",
      inputSchema: z.object({
        queries: z.array(z.string()),
        why: whyField,
        tier: z.string().optional().describe("the cost word this spend belongs to"),
      }),
      execute: async ({ queries, why, tier }) => {
        const started = Date.now()
        const out = await searchTool(paidCtx, { queries, why, tier })
        const refused =
          out.results.length > 0 &&
          out.results.every((r) => "reason" in r && r.reason.includes("allowance spent"))
        wire.onPaid?.(out.spentUsd, refused)
        report("search", why, { queries: queries.length }, started, !refused)
        return out
      },
    }),
    fetch: tool({
      description:
        "Buy pages. mode 'direct' is cheap and fails on defended hosts; 'unlock' is the paid tier — spend it on a page that will name many things at once. A slow page answers pending; read its handle later for free.",
      inputSchema: z.object({
        urls: z.array(z.string()),
        mode: z.enum(["direct", "unlock"]),
        why: whyField,
      }),
      execute: async ({ urls, mode, why }) => {
        const started = Date.now()
        const out = await fetchTool(paidCtx, { urls, mode, why })
        const refused =
          out.docs.length > 0 &&
          out.docs.every(
            (d) => "reason" in d && d.reason === "refused" && "hint" in d && d.hint.includes("allowance spent"),
          )
        wire.onPaid?.(out.spentUsd, refused)
        report("fetch", why, { urls: urls.length, mode }, started, !refused)
        return out
      },
    }),
  }
}

/**
 * The harvest tool — INVESTIGATOR-ONLY by construction: only runInvestigator
 * composes this set, and the lead's toolsets (leadControlTools + free + paid)
 * never include it. The lead delegates; a lead bulk-judging from its own
 * chair is the one-context-buys-everything failure the skill forbids. Absent
 * a wired classify closure the set is empty — a tool that refuses every call
 * teaches a dead verb.
 */
function harvestTools(wire: WireOpts, writer: string): ToolSet {
  const { deps } = wire
  const classify = deps.harvestClassify
  if (!classify) return {}
  const report = makeReport(deps)
  const ctx: HarvestCtx = {
    fetch: deps.fetch,
    evidence: deps.evidence,
    ledger: deps.ledger,
    claimId: wire.claimId,
    map: deps.map,
    seen: deps.seen,
    writer,
    aggregatorThreshold: deps.aggregatorThreshold,
    classify,
    searches: deps.searches,
    signal: wire.signal ?? deps.signal,
    onStats: deps.onHarvest,
  }
  return {
    harvest: tool({
      description:
        "Buy one bulk judgement: up to 40 hosts, each read from its own front page — unreadable and aggregator-shaped hosts settle free, one model call judges each residue host, and a host judged noise or with no relation to the anchor leaves the map with a reason. Every other judged host lands on the map through remember with its page-backed quote. Costs draw per host; a harvest that dies keeps everything already judged.",
      inputSchema: z.object({ hosts: z.array(z.string()), why: whyField }),
      execute: async ({ hosts, why }) => {
        const started = Date.now()
        const out = await harvestTool(ctx, { hosts, why })
        const refused = out.rows.length > 0 && out.rows.every((r) => r.reason?.includes("allowance spent"))
        wire.onPaid?.(out.spentUsd, refused)
        report("harvest", why, { hosts: hosts.length }, started, !refused)
        return out
      },
    }),
  }
}

function leadControlTools(deps: SwarmAgentDeps): ToolSet {
  const report = makeReport(deps)
  const controlCtx: ControlCtx = {
    board: deps.board,
    ledger: deps.ledger,
    control: deps.control,
    // This ctx is the LEAD's: what spawn queues and what review promotes
    // through it is the lead's own commission, and the finish gate charges it
    // for exactly those landings.
    commissioner: "lead",
    onFamilyEvent: deps.onFamilyEvent,
  }

  return {
    spawn: tool({
      description:
        "Fund missions, in your stated order — an early expensive mission takes its money before a later cheap one asks. Non-blocking; refusals name the item and the reason.",
      inputSchema: z.object({ missions: z.array(missionField), why: whyField }),
      execute: async ({ missions, why }) => {
        const started = Date.now()
        // The tier string is validated by the tool in words ("not a tier money
        // knows"), so the wider zod type narrows at the boundary it teaches at.
        const out = spawnTool(controlCtx, { missions: missions as unknown as Mission[], why })
        report("spawn", why, { missions: missions.length }, started, out.refused.length === 0, {
          queued: out.queued.length,
          refused: out.refused.length,
        })
        return out
      },
    }),
    review: tool({
      description:
        "FREE. Review the board with whole-map context: promote proposals into your 61-100 band (clears unreviewed), kill duplicates and dead angles with the reason stated. A running mission is not killable — review does not abort lanes.",
      inputSchema: z.object({
        promote: z.array(z.object({ dedupeKey: z.string(), priority: z.number() })).optional(),
        kill: z.array(z.object({ dedupeKey: z.string(), because: z.string() })).optional(),
        why: whyField,
      }),
      execute: async ({ promote, kill, why }) => {
        const started = Date.now()
        const out = reviewTool(controlCtx, { promote, kill, why })
        const allOk = [...out.promoted, ...out.killed].every((r) => r.ok)
        report("review", why, { promote: promote?.length ?? 0, kill: kill?.length ?? 0 }, started, allOk)
        return out
      },
    }),
    next: tool({
      description: "Declare your own re-entry: wake after landings, seconds, or both, whichever comes first.",
      inputSchema: z.object({
        after: z.object({ landings: z.number().optional(), seconds: z.number().optional() }),
        why: whyField,
      }),
      execute: async ({ after, why }) => {
        const started = Date.now()
        const out = nextTool(controlCtx, { after, why })
        report("next", why, after, started, out.ok)
        return out
      },
    }),
    finish: makeFinishTool(deps),
  }
}

/**
 * finish stands alone so the free closing turn can offer it without
 * spawn/next. `disarm` is the closing turn's structural safety: that turn
 * exists BECAUSE the harness asked the lead to close, and it is the only
 * turn there is — a refusal there would spend the answer's own turn. The
 * reading still flows, so acceptance records objections and the carried
 * split; only the refusal is off the table.
 */
function makeFinishTool(deps: SwarmAgentDeps, opts: { disarm?: boolean } = {}) {
  const report = makeReport(deps)
  const thunk = deps.scorecard
  const scorecard = thunk && opts.disarm ? () => ({ ...thunk(), disarmed: true }) : thunk
  const controlCtx: ControlCtx = {
    board: deps.board,
    ledger: deps.ledger,
    control: deps.control,
    // finish commissions nothing; the lead is who holds it either way.
    commissioner: "lead",
    ...(scorecard ? { scorecard } : {}),
  }
  return tool({
    description:
      "End the run in your own words. The summary prints verbatim above the map; unresolved is the honest residue, in your order.",
    inputSchema: z.object({
      reason: z.string(),
      summary: z.string(),
      unresolved: z.array(z.string()),
      why: whyField,
    }),
    execute: async ({ reason, summary, unresolved, why }) => {
      const started = Date.now()
      const out = finishTool(controlCtx, { reason, summary, unresolved })
      report("finish", why, { reason }, started, out.ok)
      return out
    },
  })
}

function proposeToolFor(deps: SwarmAgentDeps): ToolSet {
  const report = makeReport(deps)
  // An investigator's find, queued unreviewed. It can be popped and land
  // without the lead ever seeing it, so it is the lane's commission until a
  // review promote makes it the lead's.
  const controlCtx: ControlCtx = {
    board: deps.board,
    ledger: deps.ledger,
    control: deps.control,
    commissioner: "investigator",
  }
  return {
    propose: tool({
      description:
        "Queue a find you cannot chase into the 1-60 band with a dedupeKey. wake:true only for something that changes the picture — it clears the lead's re-entry condition.",
      inputSchema: z.object({ missions: z.array(missionField), wake: z.boolean().optional(), why: whyField }),
      execute: async ({ missions, wake, why }) => {
        const started = Date.now()
        const out = proposeTool(controlCtx, { missions: missions as unknown as Mission[], wake })
        report("propose", why, { missions: missions.length, wake: !!wake }, started, out.deduped.length === 0)
        return out
      },
    }),
  }
}

// ── one model turn ───────────────────────────────────────────────────────────

interface TurnOutcome {
  usd: number
  tokensIn: number
  tokensOut: number
  ms: number
  toolCalls: number
}

/** Rejects the moment the signal fires — the wall must win even over a model
 *  call that ignores its abort signal. `release` detaches the listener once
 *  the race is over: a long-lived run signal must not accumulate one listener
 *  per model turn for its whole life. */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; release: () => void } {
  let release = () => {}
  const promise = new Promise<never>((_, reject) => {
    const fire = () => reject(Object.assign(new Error("the deadline cancelled this call"), { name: "AbortError" }))
    if (signal.aborted) fire()
    else {
      signal.addEventListener("abort", fire, { once: true })
      release = () => signal.removeEventListener("abort", fire)
    }
  })
  return { promise, release }
}

/**
 * One model call, one step: the SDK parses the tool calls and runs their
 * executes; the caller owns everything between turns. The turn's messages are
 * appended to the held conversation, so the next turn continues it.
 */
async function oneTurn(o: {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  pricing: ModelPricing
  signal?: AbortSignal
  role: "lead" | "investigator"
  label: string
  hooks?: AgentHooks
}): Promise<TurnOutcome> {
  const started = Date.now()
  const gen = generateText({
    model: o.model,
    system: o.system,
    messages: o.messages,
    tools: o.tools,
    stopWhen: stepCountIs(1),
    abortSignal: o.signal,
    // DeepSeek honours the reasoning off switch and, left to default, spends
    // hundreds of hidden tokens per turn (measured: 314 by default, 471 at
    // "minimal" — 9-11s a call vs 4.9s off). Gemini refuses `enabled: false`,
    // so it gets no override and keeps its own floor.
    ...((typeof o.model === "string" ? o.model : (o.model as { modelId?: string }).modelId ?? "").startsWith("deepseek/")
      ? { providerOptions: { openrouter: { reasoning: { enabled: false }, provider: { order: ["parasail", "novita", "siliconflow"], allow_fallbacks: true } } } }
      : {}),
  })
  const wall = o.signal ? abortRejection(o.signal) : null
  try {
    const result = wall ? await Promise.race([gen, wall.promise]) : await gen
    const tokensIn = result.usage.inputTokens ?? 0
    const tokensOut = result.usage.outputTokens ?? 0
    const usd = (tokensIn * o.pricing.inUsdPerM + tokensOut * o.pricing.outUsdPerM) / 1e6
    o.messages.push(...(result.response.messages as ModelMessage[]))
    const ms = Date.now() - started
    o.hooks?.onModel?.({ role: o.role, label: o.label, ms, ok: true, tokensIn, tokensOut, usd })
    return { usd, tokensIn, tokensOut, ms, toolCalls: result.toolCalls.length }
  } catch (e) {
    // The race's loser may reject long after this turn is abandoned.
    gen.catch(() => {})
    o.hooks?.onModel?.({
      role: o.role,
      label: o.label,
      ms: Date.now() - started,
      ok: false,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
    })
    throw e
  } finally {
    wall?.release()
  }
}

const isAbortError = (e: unknown): boolean => {
  const err = e as { name?: string; message?: string }
  return err?.name === "AbortError" || /abort/i.test(String(err?.message ?? ""))
}

// ── the lead ─────────────────────────────────────────────────────────────────

export type LeadTurnOutcome =
  | { kind: "turn"; turn: number; usd: number; finished: boolean }
  | { kind: "closing"; turn: number; usd: number; finished: boolean; because: string }
  | { kind: "done"; because: string; loopDetected: boolean; finished: boolean }

export interface LeadRunner {
  /**
   * One metered turn, invoked by the orchestrator when due()/wake says so.
   * `notes` are the harness's in-band lines — mission digests, skip narration,
   * the yield curve — delivered as the turn's user message.
   */
  leadTurn(notes?: string[]): Promise<LeadTurnOutcome>
  readonly turns: number
}

/**
 * The lead: one per run, every tool, metered like everything else. Before each
 * turn the transcript is priced (chars/4) against the ledger; an unaffordable
 * turn becomes ONE free closing turn with the free tools and finish, then the
 * conversation is over. The 24-turn cap is a loop detector, not a budget, and
 * hitting it is loud in the return.
 */
export function runLead(deps: LeadDeps): LeadRunner {
  const system =
    `You are the LEAD. Target: ${deps.domain}. Ceiling $${deps.ledger.ceilingUsd.toFixed(2)}. GO.` +
    `\n\n${deps.skill}`
  const messages: ModelMessage[] = []
  const free = freeTools(deps, "lead")
  const closingTools: ToolSet = { ...free, finish: makeFinishTool(deps, { disarm: true }) }
  const control = leadControlTools(deps)

  let turnsUsed = 0
  let closingSpent = false
  let loopDetected = false

  const done = (because: string): LeadTurnOutcome => ({
    kind: "done",
    because,
    loopDetected,
    finished: deps.control.finished !== null,
  })

  async function leadTurn(notes?: string[]): Promise<LeadTurnOutcome> {
    if (deps.control.finished) return done(`the lead finished: ${deps.control.finished.reason}`)
    if (closingSpent) return done("the closing turn is spent; the conversation is over")
    if (turnsUsed >= LEAD_TURN_CAP) {
      loopDetected = true
      return done(
        `${LEAD_TURN_CAP} turns without finish — the loop detector fired; this is a skill bug, not a budget`,
      )
    }

    const lines = (notes ?? []).filter((l) => l.trim().length > 0)
    const content = lines.length ? lines.join("\n") : "Proceed."

    // Metering: the transcript's exact size prices the turn before it happens.
    const tokens = estimateTokens(system + JSON.stringify(messages) + content)
    const affordable = deps.ledger.affordTurn(
      tokens,
      deps.pricing.inUsdPerM,
      LEAD_EST_OUT_TOKENS,
      deps.pricing.outUsdPerM,
    )
    const estUsd = (tokens * deps.pricing.inUsdPerM + LEAD_EST_OUT_TOKENS * deps.pricing.outUsdPerM) / 1e6

    // Reserve the turn before making it: the estimate plus one peek of tool
    // headroom (a lead turn's own searching is about a peek's worth of work);
    // over-reserving costs milliseconds, the surplus returns at settle. What
    // was GRANTED is captured beside the hold: the tight fallback reserves
    // estUsd alone, and pricing the drawn total against the wide figure there
    // would invent a phantom $0.03 at settle.
    let hold: { ok: true; claimId: string } | null = null
    let grantedUsd = 0
    if (affordable) {
      const wide = deps.ledger.reserve(estUsd + ALLOWANCES.peek)
      if (wide.ok) {
        hold = wide
        grantedUsd = estUsd + ALLOWANCES.peek
      } else {
        const tight = deps.ledger.reserve(estUsd)
        if (tight.ok) {
          hold = tight
          grantedUsd = estUsd
        }
      }
    }

    if (!affordable || hold === null) {
      // The one free closing turn: free tools and finish, nothing that spends.
      messages.push({
        role: "user",
        content:
          `${content}\n` +
          `The pool no longer affords a metered turn. This is your one free closing turn — ` +
          `free tools only. Close the run with finish and say what is unresolved.`,
      })
      turnsUsed += 1
      closingSpent = true
      const r = await oneTurn({
        model: deps.model,
        system,
        messages,
        tools: closingTools,
        pricing: deps.pricing,
        signal: deps.signal,
        role: "lead",
        label: "closing turn",
        hooks: deps.hooks,
      })
      // The closing turn's model cost is real. A zero-dollar reservation always
      // settles at the honest number when the pool can still be told.
      const zero = deps.ledger.reserve(0)
      if (zero.ok) deps.ledger.settle(zero.claimId, r.usd)
      return {
        kind: "closing",
        turn: turnsUsed,
        usd: r.usd,
        finished: deps.control.finished !== null,
        because: "the pool could not afford another metered turn",
      }
    }

    messages.push({ role: "user", content })
    turnsUsed += 1

    // Pending fetches that outlive the turn still draw their late cost against
    // the turn's claim, so settlement waits for them — the ledger stays honest
    // about money that lands after the model has moved on.
    const landings: Promise<void>[] = []
    const trackPending = (landing: Promise<void>) => {
      landings.push(landing)
      deps.trackPending?.(landing)
    }
    const reservedUsd = grantedUsd // what `hold` was really granted at, wide or tight
    const tools: ToolSet = {
      ...free,
      ...paidTools({
        deps,
        claimId: hold.claimId,
        signal: deps.signal,
        trackPending,
        // Straight through to the run's work log. One sink, so the gate's
        // number and the gate's receipt cannot come from two counters that
        // disagree; see LeadDeps.onPageGained for what does and does not fire.
        ...(deps.onPageGained ? { onPageGained: deps.onPageGained } : {}),
      }),
      ...control,
    }

    let r: TurnOutcome
    try {
      r = await oneTurn({
        model: deps.model,
        system,
        messages,
        tools,
        pricing: deps.pricing,
        signal: deps.signal,
        role: "lead",
        label: `turn ${turnsUsed}`,
        hooks: deps.hooks,
      })
    } catch (e) {
      deps.ledger.settle(hold.claimId, 0)
      throw e
    }

    const drawnOn = (claimId: string): number => {
      const room = deps.ledger.draw(claimId, 0)
      return room.ok ? Math.max(0, reservedUsd - room.remainingUsd) : 0
    }
    const drawnNow = drawnOn(hold.claimId)
    if (landings.length === 0) {
      deps.ledger.settle(hold.claimId, r.usd + drawnNow)
    } else {
      const claimId = hold.claimId
      void Promise.allSettled(landings).then(() => {
        deps.ledger.settle(claimId, r.usd + drawnOn(claimId))
      })
    }

    return { kind: "turn", turn: turnsUsed, usd: r.usd + drawnNow, finished: deps.control.finished !== null }
  }

  return {
    leadTurn,
    get turns() {
      return turnsUsed
    },
  }
}

// ── the investigator ─────────────────────────────────────────────────────────

/**
 * The note a landed mission leaves the lead. Every number is THIS mission's
 * own, read off the map's writer stamps (`landedBy`) — never a map-size delta,
 * which on a map six lanes write to is the neighbours' work as much as this
 * mission's, and which the lead was steering by (docs/swarm-yield-diagnosis.md).
 *
 * `added` and `merged` are reported apart so the lead can tell "I found
 * nothing" from "someone got here first": a mission whose every claim merged
 * into standing nodes did real work — two lanes proving one host is
 * corroboration, not waste — and folding it into either number lies in one
 * direction or the other.
 *
 * NO EDGE COUNT, deliberately. `contributions` lives on MapNode; the map's one
 * edge-writing site (tools-free.ts:725) stamps no writer, and an edge's
 * evidence is not about a single host, so the {writer, tier} shape does not
 * even fit one — a tier for an edge would have to be invented. Every edge
 * number this digest could compute FROM THE MAP is a guess: the old global
 * delta was the neighbours' (resend-060732's eight missions reported 51 edges
 * between them; that run's whole span stream carries 12 edge claims and the map
 * ended with 9 — a 5.7x over-report), and "edges between nodes I wrote" credits
 * this mission with edges another lane drew. So the field is gone rather than
 * wrong.
 *
 * NOT because the number is unobtainable, and the distinction matters to whoever
 * picks this up. `rememberTool` already returns a per-call `{added, merged}` for
 * edges (tools-free.ts:722-726) — the exact shape this digest wants, attributed
 * by construction because the call was this mission's. Accumulating it across a
 * mission's remember calls in `freeTools` would give an honest edge count
 * without touching the map schema. It is left undone because 20a is an
 * instrument fix for the number the LEAD steers by, and nothing steers by edges;
 * it is not left undone because it cannot be done. Nothing steered by it — the family
 * ledger, the scorecard's yield curve and the finish gate are node-only — and
 * `recall stats` still tells any agent the map's live edge total. Stamping
 * writers on edges is a map-schema change and a designed follow-on; this item
 * is an instrument fix.
 */
export interface InvestigatorDigest {
  status: "done" | "timeout" | "spent" | "crashed"
  /** Live nodes this mission's own claims landed that were not on the map when
   *  it started — the run's yield signal, and what the family ledger records. */
  added: { nodes: number }
  /** Live nodes this mission's claims landed on that WERE already there: work
   *  that corroborated somebody else's node rather than finding a new one. */
  merged: { nodes: number }
  findings: string[]
  spentUsd: number
}

/** The read-only slice of the map an investigator is handed: the nodes nearest
 *  its mission's own words first, compact rows, never the whole map. */
function mapSlice(map: MapState, mission: Mission, cap = 12): string {
  const words = new Set(
    `${mission.lens} ${mission.brief}`
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  )
  const live = [...map.nodes.values()].filter((n) => !n.retracted)
  const scored = live.map((n) => {
    const hay = `${n.key} ${n.name} ${n.what} ${n.why}`.toLowerCase()
    let score = 0
    for (const w of words) if (hay.includes(w)) score += 1
    return { n, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const lines = scored.slice(0, cap).map(({ n }) => `- ${n.key} (${n.kind}, ${n.relation})`)
  const edges = map.edges.filter((e) => !e.retracted).length
  return `The map so far: ${live.length} nodes, ${edges} edges.${lines.length ? `\n${lines.join("\n")}` : ""}`
}

/**
 * One investigator, one mission, one allowance, one wall clock. The map is its
 * output; the digest is a note. The runner computes the digest from the map
 * and the ledger — counts and dollars are never taken from the model's words.
 */
export async function runInvestigator(mission: Mission, deps: InvestigatorDeps): Promise<InvestigatorDigest> {
  const model = deps.models[mission.tier] ?? deps.models.read
  const pricing = deps.pricing[mission.tier] ?? deps.pricing.read
  const allowanceUsd = ALLOWANCES[mission.tier]
  const system =
    `You are an INVESTIGATOR. One mission, tier ${mission.tier}, allowance $${allowanceUsd.toFixed(2)}. ` +
    `Lens: ${mission.lens}. Brief: ${mission.brief}. Why it is funded: ${mission.why}.\n` +
    `Never search the anchor's name or these coinages: ${deps.coinages.join(", ") || "(none recorded)"}.\n` +
    `${mapSlice(deps.map, mission)}\nGO.\n\n${deps.skill}`

  // The wall: the tier's deadline on the runner's own controller, chained to
  // the caller's signal so a cancelled run kills its lanes too.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.deadlineMs ?? TIER_DEADLINE_MS[mission.tier])
  const onOuterAbort = () => controller.abort()
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort()
    else deps.signal.addEventListener("abort", onOuterAbort, { once: true })
  }

  // The digest's baseline, and the ONLY thing it takes from the map's state:
  // which nodes a reader could already see when this mission started. Taken
  // synchronously here, before the first turn, so no neighbour can move it.
  // Not a size — a size delta over a shared map counts every lane's writes
  // (see InvestigatorDigest); which nodes are this mission's is a question the
  // writer stamps answer, and this snapshot only separates finding from
  // confirming.
  const liveBefore = deps.map.liveKeys()
  const remainingOnClaim = (): number | null => {
    const r = deps.ledger.draw(deps.claimId, 0)
    return r.ok ? r.remainingUsd : null
  }
  const startRemaining = remainingOnClaim()
  let runnerSpent = 0
  const spentSoFar = (): number => {
    const now = remainingOnClaim()
    const delta = startRemaining !== null && now !== null ? startRemaining - now : 0
    return Math.max(delta, runnerSpent)
  }

  let consecutiveRefusals = 0
  const wire: WireOpts = {
    deps,
    claimId: deps.claimId,
    signal: controller.signal,
    onPaid: (spentUsd, refused) => {
      runnerSpent += spentUsd
      consecutiveRefusals = refused ? consecutiveRefusals + 1 : 0
    },
  }
  const tools: ToolSet = {
    ...freeTools(deps, mission.dedupeKey),
    ...paidTools(wire),
    // Investigator-only: the lead never composes this set. Harvest writes as
    // this mission, so its judged hosts carry the same writer stamp remember
    // gives every other claim from this lane.
    ...harvestTools(wire, mission.dedupeKey),
    ...proposeToolFor(deps),
  }

  const messages: ModelMessage[] = [{ role: "user", content: "GO." }]
  let inject: string[] = []
  let warned = false
  let spentInjected = false
  let status: InvestigatorDigest["status"] = "done"

  try {
    for (let turn = 1; turn <= INVESTIGATOR_TURN_CAP; turn++) {
      if (inject.length > 0) {
        messages.push({ role: "user", content: inject.join("\n") })
        inject = []
      }

      let r: TurnOutcome
      try {
        r = await oneTurn({
          model,
          system,
          messages,
          tools,
          pricing,
          signal: controller.signal,
          role: "investigator",
          label: `${mission.dedupeKey} turn ${turn}`,
          hooks: deps.hooks,
        })
      } catch (e) {
        status = isAbortError(e) || controller.signal.aborted ? "timeout" : "crashed"
        break
      }

      // Model turns bill the allowance like any other spend.
      deps.ledger.draw(deps.claimId, r.usd)
      runnerSpent += r.usd

      if (r.toolCalls === 0) {
        status = "done"
        break
      }

      // The tool boundary: overrun aborts, 80% warns once, two consecutive
      // paid refusals say the allowance is gone — all in-band, as the skill
      // teaches the model to expect.
      //
      // The 1.5x bound is advisory-at-boundary BY CONSTRUCTION: a turn's cost
      // — the model call's own usage, and any paid batch its tools drew — is
      // only knowable after the turn lands, so this check stops the NEXT
      // turn, never the increment that crossed. Measured, not hypothesized:
      // in runs/swarm-brightdata-com-202608052348.json the
      // enterprise_competitors read stood at $0.1449 of its $0.10 allowance
      // after turn 8 — under the $0.15 bound, so the check passed — and turn
      // 9's model call alone cost $0.0446 (the transcript grows every turn),
      // landing the mission at $0.1894, 1.9x, the moment this line first saw
      // it. Every dollar was model spend drawn at the line above; the same
      // post-hoc shape holds for a paid wave, whose claimRoom gate refuses
      // only once remaining hits $0. Worst case = bound + one full turn.
      if (deps.ledger.overrunAbort(deps.claimId, spentSoFar())) {
        status = "spent"
        break
      }
      if (!warned && deps.ledger.warnAt(deps.claimId)) {
        warned = true
        const left = Math.max(0, remainingOnClaim() ?? 0)
        inject.push(`$${left.toFixed(2)} left — write down what you have`)
      }
      if (!spentInjected && consecutiveRefusals >= 2) {
        spentInjected = true
        inject.push(SPENT_LINE)
      }
    }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener("abort", onOuterAbort)
  }

  // A mission that finished after the spent line finished BECAUSE the money
  // ran out; the lead should read it that way. Timeout was already decided at
  // the kill itself — the abort is the wall (or the caller), never the model.
  if (status === "done" && spentInjected) status = "spent"

  // The digest, from the map's writer stamps and the ledger — never from the
  // model's words, and never from a map-size delta.
  const landed = landedBy(deps.map, mission.dedupeKey, liveBefore)
  // Findings were key-based, which is better than a size delta and still
  // wrong: a key ANY lane created during this mission's lifetime qualified, so
  // a mission that wrote nothing narrated its neighbours' companies to the
  // lead by name — and the lead quotes those names back into the next brief.
  // Same fix, same predicate: this mission's own nodes, found ones first, so a
  // merge-only mission still names what it confirmed instead of going silent.
  const findings = [...landed.added, ...landed.merged]
    .slice(0, 3)
    .map((n) => `${n.name} — ${n.relation}: ${n.what}`)
  const digest: InvestigatorDigest = {
    status,
    added: { nodes: landed.added.length },
    merged: { nodes: landed.merged.length },
    findings,
    spentUsd: Math.round(spentSoFar() * 1e4) / 1e4,
  }

  // ≤120 tokens, enforced by truncating findings: halve the longest until the
  // digest fits, dropping any that shrink into noise.
  const over = () => estimateTokens(JSON.stringify(digest)) > DIGEST_TOKEN_CAP
  while (over() && digest.findings.length > 0) {
    let longest = 0
    for (let i = 1; i < digest.findings.length; i++) {
      if (digest.findings[i]!.length > digest.findings[longest]!.length) longest = i
    }
    const f = digest.findings[longest]!
    if (f.length > 40) digest.findings[longest] = `${f.slice(0, Math.floor(f.length / 2))}…`
    else digest.findings.splice(longest, 1)
  }

  return digest
}

// ── the harvest classify closure ─────────────────────────────────────────────

/**
 * The classify answer's output ceiling, floored the way the sweep floors its
 * calls: some models spend mandatory reasoning out of the same output budget,
 * and a cap sized only for the ~450-token answer starves them into returning
 * nothing. The point of the cap is to stop reserving 65,536 tokens of credit
 * per call, never to be tight.
 */
const HARVEST_CLASSIFY_MAX_OUT = 6_000

export interface HarvestClassifyDeps {
  /** The classify doctrine's COMPOSED text — prompts/agents/classify.md
   *  through core's composePrompt, handed in as text the way the skill is:
   *  the runner never reads disk. */
  template: string
  model: LanguageModel
  pricing: ModelPricing
  /** sells/buyer context is read mechanically off the map's own orientation
   *  nodes at call time — the swarm has no decomposition pre-pass. */
  map: MapState
  hooks?: AgentHooks
}

/**
 * Build the harvest tier's classify closure from the SAME doctrine file the
 * sweep renders. The prompt is shared doctrine, not sweep code — this is what
 * lets packages/swarm judge residue hosts without importing packages/sweep.
 * Each call is one generateObject over the mission tier's model, billed
 * through hooks and returned WITH its dollars so the harvest tool can draw
 * them on the mission's claim the moment the call lands.
 */
export function makeHarvestClassify(deps: HarvestClassifyDeps): HarvestClassify {
  const schema = z.object({
    name: z.string(),
    kind: z.enum(JUDGED_KINDS),
    what: z.string().describe("what it is, one line, from the page itself"),
    relation: z.enum(JUDGED_RELATIONS),
    why: z.string().describe("why it belongs on this map, stated against the anchor"),
    spans: z
      .array(z.string())
      .min(1)
      .max(3)
      .describe("1-3 short quotes copied character-for-character from the page, together backing the what"),
  })
  return async (h, pageText, opts) => {
    const started = Date.now()
    // The doctrine's {{sells}}/{{buyer}} slots: whatever orientation has put
    // on the map so far, mechanically — a capability node is the de-branded
    // "what the anchor sells", a buyer node is who pays. Absent either, the
    // slot says so rather than inventing context.
    const live = [...deps.map.nodes.values()].filter((n) => !n.retracted)
    const cap = live.find((n) => n.kind === "capability")
    const buyer = live.find((n) => n.kind === "buyer")
    const prompt = render(deps.template, {
      anchor: deps.map.anchor,
      sells: cap ? `${cap.name}${cap.what ? ` — ${cap.what}` : ""}` : "(not recorded on the map yet)",
      buyer: buyer ? `${buyer.name}${buyer.what ? ` — ${buyer.what}` : ""}` : "(not recorded on the map yet)",
      host: h.host,
      seenIn: String(h.seenIn),
      // The doctrine's {{foundBy}} slot — "how this run found it". The sweep
      // pre-renders the surfacing queries into it; a harvest candidate almost
      // never carries that road (harvestTool builds intents: [] and no foundBy
      // — the investigator NAMED the host, no query join exists at that seam).
      // This bag kept saying `intents` after 9c33d76 renamed the slot in
      // classify.md and packages/sweep together: render() throws on the
      // missing slot AND the unused var, judgeHosts absorbs a classify throw
      // as kind "unknown" — so a harvest spent its whole allowance to land an
      // all-unknown roster, silently. The fallbacks stay honest: intents say
      // how the searches were framed, and neither line quotes query text that
      // was never bought. Pinned by tests/harvest-classify-prompt.test.ts
      // against the composed file on disk.
      foundBy:
        h.foundBy ??
        (h.intents.length
          ? `  surfaced by ${h.intents.join(", ")} searches this run (query text not recorded)`
          : "  named in a harvest call by this run's investigator (query text not recorded)"),
      page: pageText,
    })
    try {
      const out = await generateObject({
        model: deps.model,
        schema,
        prompt,
        abortSignal: opts?.signal,
        maxOutputTokens: HARVEST_CLASSIFY_MAX_OUT,
        // Same off switch the turn loop sends: a harvest judgement is a
        // labelling call, and DeepSeek left to default thinks in secret
        // (measured 314 hidden tokens, 9.2s a call against 4.9s off).
        ...((typeof deps.model === "string" ? deps.model : (deps.model as { modelId?: string }).modelId ?? "").startsWith("deepseek/")
          ? { providerOptions: { openrouter: { reasoning: { enabled: false }, provider: { order: ["parasail", "novita", "siliconflow"], allow_fallbacks: true } } } }
          : {}),
      })
      const tokensIn = out.usage?.inputTokens ?? 0
      const tokensOut = out.usage?.outputTokens ?? 0
      const usd = (tokensIn * deps.pricing.inUsdPerM + tokensOut * deps.pricing.outUsdPerM) / 1e6
      deps.hooks?.onModel?.({
        role: "investigator",
        label: `classify ${h.host}`,
        ms: Date.now() - started,
        ok: true,
        tokensIn,
        tokensOut,
        usd,
      })
      return { out: out.object, usd }
    } catch (e) {
      deps.hooks?.onModel?.({
        role: "investigator",
        label: `classify ${h.host}`,
        ms: Date.now() - started,
        ok: false,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
      })
      throw e
    }
  }
}
