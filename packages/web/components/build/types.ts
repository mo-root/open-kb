/**
 * The wire contract between the run's five streams and this surface.
 *
 * These are readers, not type assertions. The streams are NDJSON off a live
 * run, so every reader returns `null` for a frame it does not recognise rather
 * than crashing the page.
 *
 *   (default)     results   understanding, planned, ranked, complete, error
 *   ?ns=progress  { round, agent, message, atSec? }
 *   ?ns=agent     the model's own output, AI-SDK-shaped chunks
 *   ?ns=cost      { round, usd, tokens, serpCalls, unlockerCalls }
 *   ?ns=trace     one TraceRow per tool call
 *
 * Changed from v1: nine stages became five, since v1's rail carried stages this
 * engine has no phase for and a stage that never lights reads as a stall. And
 * the plan groups by intent rather than by anchor, because every query here is
 * de-branded so that axis carries no information.
 */

// ------------------------------------------------------------------ stages --

/** The run's spine, in the order the sweep walks it.
 *
 *  These are UI stages, not steps: the run emits progress under an agent name,
 *  and `stageOf` is that mapping. It matters because when it silently misses a
 *  name the rail freezes on the stage before and the run looks hung while it is
 *  in fact working. */
export const STAGES = ["understand", "plan", "sweep", "rank", "link", "write"] as const;

export type Stage = (typeof STAGES)[number];
export type StageState = "pending" | "active" | "done";

export const STAGE_LABELS: Record<Stage, string> = {
  understand: "Understand",
  plan: "Plan",
  sweep: "Sweep",
  rank: "Classify",
  link: "Connect",
  write: "Map",
};

/** One line saying what the stage is doing with the user's money. Shown under
 *  the active stage, because "Sweep" alone does not tell anyone anything. */
export const STAGE_BLURB: Record<Stage, string> = {
  understand: "read the company's own pages — what it sells, who buys it, which words it invented",
  plan: "write the query catalog knowing no company names, so a look-up query is impossible",
  sweep: "fire every query at once and keep the hosts that come back",
  rank: "classify the whole host bag in batches — player, community, publisher, noise",
  link: "ask how the players relate to each other, not just to the anchor",
  write: "assemble the map and settle the bill",
};

/** agent name (as the run emits it) -> the stage a reader sees. */
const AGENT_STAGE: Record<string, Stage> = {
  understand: "understand",
  // Retired / alternate names, kept so a frame from an older shape still lights
  // the right stage instead of freezing the rail on the one before it.
  read: "understand",
  discover: "understand",
  plan: "plan",
  catalog: "plan",
  sweep: "sweep",
  search: "sweep",
  rank: "rank",
  link: "link",
  classify: "rank",
  extract: "rank",
  write: "write",
  complete: "write",
};

export function stageOf(agent: string | undefined | null): Stage | null {
  if (typeof agent !== "string") return null;
  return AGENT_STAGE[agent.trim().toLowerCase()] ?? null;
}

export function initialStates(): Record<Stage, StageState> {
  return Object.fromEntries(STAGES.map((s) => [s, "pending"])) as Record<Stage, StageState>;
}

/**
 * Move the rail to `stage`, closing everything behind it.
 *
 * Forward-only, deliberately. The sweep fans out, so a progress frame from an
 * earlier phase can land after a later one has begun; re-activating it would
 * make the rail jump backwards, which reads to a user as the run restarting.
 */
export function advance(
  states: Record<Stage, StageState>,
  stage: Stage,
): Record<Stage, StageState> {
  const idx = STAGES.indexOf(stage);
  if (idx < 0) return states;
  const furthest = STAGES.reduce((max, s, i) => (states[s] !== "pending" ? i : max), -1);
  if (idx < furthest) return states; // a straggler from a stage already passed
  const next = { ...states };
  STAGES.forEach((s, i) => {
    if (i < idx) next[s] = "done";
    else if (i === idx) next[s] = "active";
  });
  return next;
}

export function allDone(states: Record<Stage, StageState>): Record<Stage, StageState> {
  const next = { ...states };
  for (const s of STAGES) next[s] = "done";
  return next;
}

// ------------------------------------------------------------------- reads --

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// -------------------------------------------------------------------- plan --

/** The eight questions the catalog spreads itself across. This is the ONE axis
 *  along which the queries differ, every one of them is de-branded, by
 *  construction, so it is what the plan panel groups by. */
export const INTENTS = [
  "pain",
  "switching",
  "evaluation",
  "build",
  "discovery",
  "integration",
  "hiring",
  "community",
] as const;

export type Intent = (typeof INTENTS)[number] | "unknown";

export const INTENT_LABEL: Record<Intent, string> = {
  pain: "what breaks and hurts",
  switching: "people leaving something",
  evaluation: "people comparing options",
  build: "people building it themselves",
  discovery: "people looking for anything at all",
  integration: "what it has to plug into",
  hiring: "who is being hired to do this",
  community: "where this market gathers",
  unknown: "planned",
};

/** Why the group exists at all, the catalog's own thesis, in the panel. */
export const INTENT_BLURB: Record<Intent, string> = {
  pain: "someone describing the failure this market exists to fix, before they know any vendor's name",
  switching: "a migration post names the thing being left AND the thing being moved to — two players per page",
  evaluation: "comparison pages are where a market lists itself",
  build: "the do-it-yourself route is the substitute every vendor is actually priced against",
  discovery: "the plainest phrasing a buyer types, which reaches vendors nobody writes think-pieces about",
  integration: "the platforms this has to sit inside name the players that already sit there",
  hiring: "a job ad lists the tools in the stack, which is a vendor list written by someone who uses them",
  community: "forums and subreddits are where the market talks without a vendor in the room",
  unknown: "planned without a recorded intent",
};

/** One planned SERP call as the panel shows it. Over the wire the rationale can
 *  be missing, and an empty string is how this surface says "no reason
 *  travelled with it" rather than inventing one. */
export interface PlannedQueryView {
  q: string;
  source: Intent;
  rationale: string;
  /** The platform the query targets, `site:reddit.com`, hackernews, github. */
  concept?: string;
}

export interface PlanView {
  domain: string;
  /** What the run says it planned. Can exceed `queries.length` when the frame
   *  carried only a count. */
  count: number;
  queries: PlannedQueryView[];
  estimatedUsd: number;
}

const SOURCES: readonly string[] = INTENTS;

function readPlannedQuery(v: unknown): PlannedQueryView | null {
  if (typeof v === "string") {
    // A bare string is the pre-rationale shape. Say nothing rather than guess:
    // a reason reconstructed from the query text is a guess about our own plan.
    return v.trim() ? { q: v, source: "unknown", rationale: "" } : null;
  }
  const o = obj(v);
  if (!o) return null;
  const q = str(o.q) || str(o.query);
  if (!q) return null;
  const source = str(o.source) || str(o.intent);
  const concept = str(o.concept) || str(o.platform);
  return {
    q,
    source: (SOURCES.includes(source) ? source : "unknown") as Intent,
    rationale: str(o.rationale) || str(o.why),
    ...(concept ? { concept } : {}),
  };
}

export function readPlanned(v: unknown): PlanView | null {
  const o = obj(v);
  if (!o) return null;
  const kind = str(o.kind);
  if (kind !== "planned" && kind !== "plan") return null;

  const raw = Array.isArray(o.plan) ? o.plan : list(o.queries);
  const queries = raw.map(readPlannedQuery).filter((q): q is PlannedQueryView => q !== null);

  return {
    domain: str(o.slug) || str(o.brand) || str(o.domain),
    // `queries: 40` is the shape that carries only the count. It is still true
    // and still worth showing.
    count: typeof o.queries === "number" ? num(o.queries) : queries.length,
    queries,
    estimatedUsd: num(o.estimatedUsd),
  };
}

export interface PlanGroup {
  source: Intent;
  queries: PlannedQueryView[];
}

/**
 * Group the plan by the question each query asks, largest group first.
 *
 * Order inside a group is left alone, it is the order the catalog wrote them
 * in, which is the order they were fired in.
 */
export function groupPlan(queries: readonly PlannedQueryView[]): PlanGroup[] {
  const by = new Map<Intent, PlannedQueryView[]>();
  for (const q of queries) {
    const cur = by.get(q.source);
    if (cur) cur.push(q);
    else by.set(q.source, [q]);
  }
  return [...by.entries()]
    .map(([source, qs]) => ({ source, queries: qs }))
    .sort((a, b) => b.queries.length - a.queries.length);
}

// -------------------------------------------------------------------- cost --

export interface CostView {
  round: number;
  usd: number;
  tokens: number;
  serpCalls: number;
  unlockerCalls: number;
}

export function readCost(v: unknown): CostView | null {
  const o = obj(v);
  // A frame with no numeric `usd` is dropped rather than defaulted. A default of
  // 0 renders a permanently healthy-looking spend, which is the one thing a cost
  // readout must never do, the same failure `SpanStream.emit` guards on the
  // way in by flagging a non-finite price as a failed span.
  if (!o || typeof o.usd !== "number" || !Number.isFinite(o.usd)) return null;
  return {
    round: num(o.round),
    usd: o.usd,
    tokens: num(o.tokens),
    serpCalls: num(o.serpCalls),
    unlockerCalls: num(o.unlockerCalls),
  };
}

/** Four decimals, because a whole run costs a third of a dollar and a single
 *  SERP call costs $0.0015, two decimals would render most of this UI as
 *  "$0.00" for the first minute. */
export function formatUsd(usd: number | undefined | null): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(4)}`;
}

/** `754000` → `12m 34s`. For the run's own duration, where four decimals of a
 *  millisecond say nothing and "12.57 minutes" is not how anyone reads a clock. */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** What share of the bill a line is, as a whole percent. Zero total is 0 rather
 *  than NaN: a run stopped before it bought anything still renders. */
export function shareOf(usd: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round((usd / total) * 100);
}

// ---------------------------------------------------------------- run cost --

/** The itemised bill, as the run's own ledger crosses the wire. Read
 *  defensively like everything else here. */
export interface CostLineView {
  label: string;
  calls: number;
  failures: number;
  usd: number;
  ms: number;
}

export interface RunCostView {
  usd: number;
  elapsedMs: number;
  calls: number;
  tokens: number;
  /** null = the run had no dollar ceiling, which in this engine is always. */
  ceilingUsd: number | null;
  byKind: CostLineView[];
  byAgent: CostLineView[];
  partial: boolean;
}

function readCostLine(v: unknown): CostLineView | null {
  const o = obj(v);
  if (!o) return null;
  const label = str(o.label);
  if (!label) return null;
  return {
    label,
    calls: num(o.calls),
    failures: num(o.failures),
    usd: num(o.usd),
    ms: num(o.ms),
  };
}

export function readRunCost(v: unknown): RunCostView | null {
  const o = obj(v);
  if (!o) return null;
  // `usd` is the one field the whole panel is about. Without a number for it
  // there is no bill to show, and rendering a $0.00 breakdown of a run that cost
  // a dollar is worse than showing nothing.
  if (typeof o.usd !== "number" || !Number.isFinite(o.usd)) return null;
  return {
    usd: o.usd,
    elapsedMs: num(o.elapsedMs),
    calls: num(o.calls),
    tokens: num(o.tokens),
    // Only an explicit null is "uncapped". An absent field is an older frame
    // that never carried a ceiling, and guessing for it would announce a policy
    // the run never ran under.
    ceilingUsd: o.ceilingUsd === null ? null : typeof o.ceilingUsd === "number" ? o.ceilingUsd : 0,
    byKind: list(o.byKind).map(readCostLine).filter((l): l is CostLineView => l !== null),
    byAgent: list(o.byAgent).map(readCostLine).filter((l): l is CostLineView => l !== null),
    partial: o.partial === true,
  };
}

// ---------------------------------------------------------------- progress --

export interface ProgressView {
  round: number;
  agent: string;
  message: string;
  stage: Stage | null;
  /** Seconds into the run. */
  atSec?: number;
}

export function readProgress(v: unknown): ProgressView | null {
  const o = obj(v);
  if (!o) return null;
  const message = str(o.message).trim();
  if (!message) return null;
  const agent = str(o.agent);
  const atSec = typeof o.atSec === "number" && Number.isFinite(o.atSec) ? o.atSec : undefined;
  return { round: num(o.round), agent, message, stage: stageOf(agent), atSec };
}

// ------------------------------------------------------------------- trace --

export interface TraceView {
  seq: number;
  ts: string;
  round: number;
  agent: string;
  tool: string;
  kind: string;
  /** The digest, for a SERP row this is the query text itself, which is the
   *  only place a reader can see which question the run just paid for. */
  argsDigest: string;
  ms: number;
  ok: boolean;
  usd: number;
  runningUsd: number;
}

export function readTrace(v: unknown): TraceView | null {
  const o = obj(v);
  if (!o) return null;
  const tool = str(o.tool);
  if (!tool) return null;
  return {
    seq: num(o.seq),
    ts: str(o.ts),
    round: num(o.round),
    agent: str(o.agent),
    tool,
    kind: str(o.kind),
    argsDigest: str(o.argsDigest),
    ms: num(o.ms),
    ok: o.ok !== false,
    usd: num(o.usd),
    runningUsd: num(o.runningUsd),
  };
}

// ----------------------------------------------------------------- results --

export interface ResultFrame {
  kind: string;
  payload: Record<string, unknown>;
}

export function readResult(v: unknown): ResultFrame | null {
  const o = obj(v);
  if (!o) return null;
  const kind = str(o.kind);
  return kind ? { kind, payload: o } : null;
}

// ---------------------------------------------------------- understanding --

export interface ProductReadView {
  name: string;
  sells: string;
}

export interface UnderstandingView {
  domain: string;
  sells: string;
  buyer: string;
  products: ProductReadView[];
  /** Words this company invented. The catalog is forbidden from searching them,
   *  which is the single rule that makes the sweep find anyone new. */
  coinages: string[];
  usd: number;
}

export function readUnderstanding(v: unknown): UnderstandingView | null {
  const frame = obj(v);
  if (!frame) return null;
  const kind = str(frame.kind);
  if (kind !== "understanding" && kind !== "understood") return null;
  // The payload may be nested or ride flat on the frame; both shapes have
  // appeared and neither is worth losing the panel over.
  const o = obj(frame.understanding) ?? frame;
  const buyer = obj(o.buyer);

  return {
    domain: str(o.brand) || str(o.domain),
    sells: str(o.sells),
    buyer: buyer ? str(buyer.role) || str(buyer.context) : str(o.buyer),
    products: list(o.products)
      .map(obj)
      .filter((p): p is Record<string, unknown> => p !== null)
      .map((p) => ({ name: str(p.name), sells: str(p.sells) || str(p.does) }))
      .filter((p) => p.name || p.sells),
    coinages: list(o.coinages).map(str).filter(Boolean),
    usd: num(o.usd),
  };
}

// -------------------------------------------------------------------- feed --

export interface FeedItem {
  id: number;
  tone: "muted" | "accent" | "green" | "amber" | "red";
  text: string;
}
