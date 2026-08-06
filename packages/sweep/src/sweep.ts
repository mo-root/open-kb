/**
 * Sweep: the shape the map actually wants.
 *
 *   1. read the company, free fetch, one model call -> what it sells
 *   2. write the catalog, one model call -> N queries, generated before any company
 *                                name is known, so a look-up query is impossible to write
 *   3. fire everything at once, parallel, cheap
 *   4. judge every host from its own front page, predicates first, a model
 *                                call only on the residue, one host at a time
 *
 * This is the library form of what `scripts/sweep.ts` used to be inline. It is
 * the same code the CLI and the web route run, the script is now a thin
 * argv-and-console wrapper, so a fix made for the browser is a fix the script
 * gets, and there is no second copy of the pipeline to drift.
 *
 * Everything it does is emitted onto a `SpanStream` as it happens rather than
 * only printed at the end: a phase boundary, one span per SERP call carrying
 * the real query text, one per model call carrying its token counts. Nothing
 * reads the stream in the CLI (`onLog` prints instead), and the browser reads
 * nothing else.
 */
import { generateObject } from "ai"
import type { LanguageModel } from "ai"
import { z } from "zod"
import {
  sniff,
  condense,
  isHtml,
  candidatesFromSitemap,
  candidatesFromLinks,
  isSitemapIndex,
  readPageFacts,
  renderPageFacts,
  dedupeFacts,
  openingHand,
  companyHand,
  banned,
  answerKeyRecall,
  anchorAliasSet,
  registrableHost,
  type PageFacts,
  type SearchResult,
  type SpanStream,
  type FamilyQuery,
  type QueryFamily,
  type UnreadableReason,
} from "@open-kb/core"
import {
  brightDataSearch,
  brightDataFetch,
  type BrightDataCredentials,
} from "@open-kb/providers"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { composePrompt, render } from "@open-kb/core"
import { judgeHosts, type Judged } from "./rank.js"

/**
 * Where `prompts/` lives.
 *
 * Walked up from this file rather than taken from `cwd`, because the same
 * pipeline runs from the repo root (the CLI) and from `packages/web` (the Next
 * server), and a cwd-relative path is correct in exactly one of those.
 */
function promptsRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "prompts", "doctrine"))) return join(dir, "prompts")
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error("cannot find prompts/ — the agents have no instructions to load")
}

/**
 * A per-run prompt renderer: each agent's template is composed from disk once,
 * and only the placeholder fill happens per call.
 *
 * Composition is sync `readFileSync` work plus the `promptsRoot` walk, and the
 * classify call sits inside the rank pool — composing per call meant every
 * residue host re-read the same unchanging files from inside an async worker
 * (measured on the offline rehearsal: 18 compositions across three runs, one
 * per model call; a 740-host live run pays that per host). The files cannot
 * change mid-run, so the run composes each agent's template on first use and
 * renders from memory after that.
 *
 * Scoped to the run, not the module, on purpose: the prompts are editable
 * without a rebuild, and a process-wide memo would quietly end that for any
 * long-lived server — the next run must see the edited file.
 *
 * `compose` is injectable so a test can prove the arithmetic with a counting
 * fake; `sweep()` always uses the real files. It is synchronous, which is what
 * makes the memo race-free under the rank pool: the first classify call fills
 * the map before any other worker can look.
 */
export function makePrompt(
  compose: (agent: string) => string = (agent) => {
    const root = promptsRoot()
    return composePrompt(agent, join(root, "agents"), join(root, "doctrine"))
  },
): (agent: string, vars: Record<string, string | number>) => string {
  const templates = new Map<string, string>()
  return (agent, vars) => {
    let t = templates.get(agent)
    if (t === undefined) {
      t = compose(agent)
      templates.set(agent, t)
    }
    return render(t, vars)
  }
}

import { emitUi } from "./ui.js"

// ── the shapes ────────────────────────────────────────────────────────────────

export const INTENTS = [
  "pain",
  "switching",
  "evaluation",
  "build",
  "discovery",
  "integration",
  "hiring",
  "community",
] as const
export type Intent = (typeof INTENTS)[number]

export const PLATFORMS = [
  "web",
  "reddit",
  "hackernews",
  "github",
  "stackoverflow",
  "producthunt",
  "x",
] as const

export const ENTITY_KINDS = [
  "company",
  "product",
  "community",
  "publisher",
  "directory",
  "noise",
  "unknown",
] as const

/**
 * The classify answer's size, output tokens. 350 before span-bound
 * descriptions; the spans field adds up to three ~120-char verbatim quotes
 * (~100 tokens, billed at six times the input rate — the reason the receipts
 * are capped at three spans and 360 stored chars, not "as many as help").
 * Note `call()` floors the wire ceiling at 6,000 because mandatory reasoning
 * spends from the same budget — this constant documents the answer's size and
 * feeds that max(); it is not itself the wire cap.
 */
export const CLASSIFY_MAX_OUTPUT_TOKENS = 450

/**
 * How an entity stands to the anchor.
 *
 * Seven are commercial stances. Three cover hosts that have no commercial
 * stance but still relate: publications, directories, forums. `unknown` is
 * the downgrade for a claim the evidence refused — the host stays, wearing
 * the refusal. With only commercial words, 144 of 438 hosts on one run came
 * back `none` and dropped off the map, since a node with no relation gets no
 * edge.
 */
export const RELATIONS = [
  "competitor",
  "substitute",
  "dependency",
  "integration",
  "shaper",
  "buyer",
  "target",
  "covers",
  "lists",
  "discusses",
  "unknown",
  "none",
] as const

/**
 * The three lenses the catalog is written through, in parallel.
 *
 * One model call writing the whole catalog took 51 seconds and had to hold
 * every intent at once, which is how a prompt ends up covering all of them
 * thinly. Three calls run concurrently, so the stage costs the slowest rather
 * than the sum, and each prompt argues for one thing.
 *
 * Split by WHO is searching, not by market: a market's competitors, its
 * substitutes and its communities are found by different people typing
 * different things, and one lens cannot reach all three. Every lens still
 * covers every market.
 */
/**
 * The lenses are gone: the PRODUCT is the unit now.
 *
 * Splitting the catalog three ways by persona -- the buyer in trouble, the
 * practitioner, where the market gathers -- meant a market covering three
 * products got one share between them, and the shapes each lens knew are
 * better expressed as shapes ONE product's call should spend across. Those
 * moved into prompts/agents/catalog.md, where they are editable without a
 * rebuild, and the demand-wave gate went with them.
 */

/**
 * How two found entities stand to EACH OTHER.
 *
 * The map was a star: on one run all 367 edges touched the anchor and none
 * joined two other companies. That is a list with a centre, not a market. A
 * reader wants to know that two vendors compete with each other, that a forum
 * argues about a specific one, that a directory lists a set.
 *
 * Same words as the anchor vocabulary, read from `from` to `to`. Direction is
 * load-bearing and is not symmetric for the channel relations: a publisher
 * covers a vendor, never the reverse.
 */
const PEER_RELATIONS = [
  "competitor",
  "substitute",
  "dependency",
  "integration",
  "covers",
  "lists",
  "discusses",
  "unknown",
] as const

const EntityEdge = z.object({
  from: z.string().describe("the domain doing the relating, exactly as given"),
  to: z.string().describe("the domain being related to, exactly as given"),
  relation: z.enum(PEER_RELATIONS),
  why: z.string().describe("how they relate, in one line. Not that they resemble."),
  /**
   * Borrowed from the graphify extraction spec, which requires a confidence on
   * every edge and forbids a lazy default. `measured` means a page we retrieved
   * put these two together; `inferred` means the model reasoned it from what
   * each one does. A reader can discount the second and not the first.
   */
  confidence: z
    .enum(["measured", "inferred"])
    .describe("measured = a retrieved page named both; inferred = reasoned from what each does"),
})

export type EntityEdge = z.infer<typeof EntityEdge>

const Decomposition = z.object({
  sells: z.string().describe("what this company sells, in one plain sentence, no marketing words"),
  buyer: z.string().describe("who buys it and what has just gone wrong for them"),
  brand: z.string().describe("the company's name as it writes it, e.g. from its own header or footer"),
  products: z.array(
    z.object({
      name: z.string(),
      does: z.string().describe("what this product does, stripped of the company's own naming"),
      foundAt: z
        .string()
        .describe("the url of the company's own page that establishes this product, copied from the pages given; empty string if none does"),
    }),
  ),
  /**
   * The products, grouped into the markets they sit in.
   *
   * A SKU sheet is a pricing artifact. On one run, three proxy SKUs of a single
   * capability took 3 of 10 query slots while a separate product line with its
   * own rivals took 0. Grouping splits the budget by market instead.
   *
   * Group by "would these have different competitors", not by similar wording.
   */
  capabilities: z
    .array(
      z.object({
        name: z.string().describe("the capability in the market's words, no brand, no product name"),
        does: z.string().describe("the job it does for the buyer, one line"),
        covers: z.array(z.string()).describe("which of the products above this groups"),
        /**
         * Core or adjacent, because equal coverage misfires.
         *
         * Measured: a transactional email company lists an MCP server among its
         * products. Grouping made it a market, "give every market a query" gave
         * it a third of a three-query budget, and it returned eight hosts about
         * AI protocols and nothing about email. A side integration is a real
         * product and a real market; it is not worth the same share as the thing
         * the company is bought for.
         */
        centrality: z
          .enum(["core", "adjacent"])
          .describe(
            "core = what buyers come to this company for. adjacent = a side line, integration or add-on they would not switch vendor over.",
          ),
      }),
    )
    .describe("the products grouped into distinct markets — the unit the search budget is split across"),
  coinages: z
    .array(z.string())
    .describe("words this company invented — product names, brand terms. Queries must never contain these."),
})

const PlannedQuery = z.object({
  q: z.string(),
  intent: z.enum(INTENTS),
  platform: z.enum(PLATFORMS),
  // The reason this query is worth buying, written where the query is composed.
  // A plan is a spend: a list of query strings tells a reader what was bought
  // and never why, and a reason reconstructed later from the query text is a
  // guess about our own plan rather than a record of it.
  why: z.string().describe("one short line: what this query is expected to surface that the others will not"),
  /**
   * Which of the anchor's markets this query is for.
   *
   * Taken from v1, whose hand-written catalog tagged every one of its 602
   * queries with the products it served. Without it, "cover every market" is a
   * sentence in a prompt that nothing checks: a run can spend its whole budget
   * on one market and report only that it asked forty questions. With it the
   * gap is countable before a single search is paid for.
   */
  market: z.string().describe("the capability name this query is aimed at, copied exactly from the list above"),
})

const Entity = z.object({
  name: z.string(),
  domain: z.string(),
  kind: z.enum(ENTITY_KINDS),
  what: z.string().describe("what it is, one line, from what the results say"),
  relation: z.enum(RELATIONS),
  why: z.string().describe("why it belongs on this map, stated against the anchor"),
})

/** What one query cost and what it returned. Persisted with the run, because
 *  per-query yield only ever existed on the span stream, which dies with the
 *  process, so every question about which shapes of query pay ("are ours too
 *  long?") had to be answered from the query text alone, by eye. */
export interface QueryYield {
  q: string
  intent: string
  words: number
  hits: number
  ok: boolean
}

export type Decomposition = z.infer<typeof Decomposition>
export type PlannedQuery = z.infer<typeof PlannedQuery>

/** A query as the sweep fires it: the model's PlannedQuery plus the mechanical
 *  tags. Family and product are stamped in code, never asked of the model —
 *  a tag the model can forget is a tag the join cannot rely on. */
export type SweptQuery = PlannedQuery & { family: QueryFamily; product?: string; term?: string }

/**
 * `foundBy` is which of the anchor's markets' queries surfaced this host,
 * strongest first. Filled mechanically after classification — every hit knows
 * its query and every query knows its market — never by the model.
 *
 * This is the field that turns the graph from a star into a map. v1 attached
 * every finding to the product whose search surfaced it: search for the
 * unlocker's job, find Apify, and Apify hangs off the unlocker. That chain
 * existed here too, and was dropped between the sweep and the result, so the
 * reader got one hub with a hundred spokes and no way to see which market any
 * of them belonged to.
 */
export type Entity = z.infer<typeof Entity> & { foundBy?: string[]; families?: QueryFamily[] } & {
  because?: string
  settledBy?: "predicate" | "model"
  /** Unreadable hosts only: WHY the front page could not be read, as the
   *  sniffer's stable code (rank.ts stamps it beside the `because` sentence).
   *  Persisted with the run so a stored map can say "61 bot-walled, 40
   *  JS-only" instead of "127 unreadable". */
  unreadableReason?: UnreadableReason
  /** Model-judged entities only: what fraction of the content terms in the
   *  what the model WROTE the page it saw actually contains, 2 decimals.
   *  The regression canary — the span ledger below is the gate. */
  descGrounded?: number
  /** Model-judged entities only: how many of the verbatim page quotes the
   *  model claimed back its what were literal substrings of the page it saw,
   *  checked in code. A what with zero verified spans shipped as the span-free
   *  fallback sentence, never as the model's prose. */
  descSpans?: { verified: number; claimed: number }
  /** The verified quotes — the receipts, capped at 360 chars total. */
  spans?: string[]
}

export interface SweepStats {
  queries: number
  results: number
  hosts: number
  kept: number
  tokIn: number
  tokOut: number
  /** Output tokens the model spent thinking. Billed at the output rate and
   *  never shown to anyone, so it is worth being able to see. */
  tokReasoning: number
  serpCalls: number
  unlockerCalls: number
  usd: number
  seconds: number
}

export interface SweepResult {
  anchor: string
  decomposition: Decomposition
  queries: SweptQuery[]
  entities: Entity[]
  /** How the entities relate to each other, not to the anchor. */
  edges?: EntityEdge[]
  stats: SweepStats
  /**
   * The run's own summary, in exactly the shape the `complete` frame carries.
   *
   * Built once and both emitted and returned, so `GET /api/run/{id}` and the
   * `complete` frame cannot disagree. They used to be assembled independently,
   * which is the shape of bug where a browser that caught the frame and a
   * browser that asked afterwards render two different runs.
   */
  report: Record<string, unknown>
}

/** Dollars per million tokens. Accounting only, nothing here bills anyone, and
 *  a wrong number here makes the cost readout wrong rather than the run. */
export interface ModelPricing {
  inUsdPerM: number
  outUsdPerM: number
}

export interface SweepOptions {
  domain: string
  /** An override that clamps the catalog to a fixed count, for a bounded
   *  probe. Left unset — the normal case — every product is dealt its own
   *  opening hand instead, and the run's real ceiling is the spend limit, not
   *  a query quota. */
  queries?: number
  spans: SpanStream
  creds: BrightDataCredentials
  model: LanguageModel
  /** Names the model in the trace. `model` itself is an opaque object. */
  modelId?: string
  runId?: string
  pricing?: ModelPricing
  /** Result pages read per query. Measured: one query across five pages returned
   *  37 distinct hosts against 7 from the first page alone, and had not
   *  saturated. A page costs exactly what a query costs, so depth here buys more
   *  of a market than breadth does. */
  pages?: number
  /** Ceiling on how many times the run may look at its own map and ask for more
   *  queries. It usually stops before this because the model says it has enough. */
  maxWaves?: number
  /** A wave adding fewer new hosts than this ends the run, more queries would be
   *  buying corroboration rather than coverage. */
  minNewHosts?: number
  /** SERP calls in flight at once. */
  concurrency?: number
  /** Co-occurring pairs per link-phase model call. */
  batchSize?: number
  /** Outbound-link count above which a company-shaped front page is settled as
   *  a directory for free, without a model call. Left unset: calibration
   *  (`scripts/calibrate-kernel.ts`) found no separation between vendor and
   *  directory front pages on the measured sample, so the rule ships disabled
   *  (`null`) rather than shipping a guessed number. Set it once a real run
   *  produces a cutoff worth trusting. */
  aggregatorThreshold?: number
  /** How many co-occurring entity pairs to ask about. 0 disables linking. */
  maxPairs?: number
  /** Skip the paid pass that asks a model to label co-occurring pairs, keeping
   *  only the free edges from pages that name another player outright. */
  skipModelLinking?: boolean
  /** How many of the company's own product pages to read. 0 uses the index only. */
  productPages?: number
  /** Bounds the model's per-product debranded ask (clamped to 2-3 regardless of
   *  a larger value here; the floor of 2 is not configurable). Templates cover
   *  plain and branded and are not affected — this only trims how many
   *  model-written debranded queries a product's opening hand carries. */
  perProduct?: number
  /** What this deployment may spend, in total, cumulative since deploy — not a
   *  per-run figure. Read by the caller (the web route) from the provider's own
   *  usage and passed through so `report.cost.ceilingUsd` can say honestly
   *  whether a ceiling was in force, rather than always claiming there is none.
   *  Left unset on the CLI, which has no deployment-wide ceiling to report. */
  ceilingUsd?: number | null
  /** The CLI's console. Left unset in the browser, where the span stream is the
   *  only output. */
  onLog?: (line: string) => void
  signal?: AbortSignal
}

const DEFAULT_PRICING: ModelPricing = { inUsdPerM: 1.5, outUsdPerM: 9.0 }

/** $/M tokens by OpenRouter id, checked against their live models endpoint
 *  2026-08-06. An id this table does not know prices at the most expensive
 *  row — the meter must never flatter a model it has not met. */
export const MODEL_PRICES: Record<string, ModelPricing> = {
  "deepseek/deepseek-v4-flash": { inUsdPerM: 0.088, outUsdPerM: 0.176 },
  "google/gemini-3-flash-preview": { inUsdPerM: 0.5, outUsdPerM: 3.0 },
  "google/gemini-3.1-flash-lite": { inUsdPerM: 0.1, outUsdPerM: 0.4 },
  "google/gemini-3.5-flash": { inUsdPerM: 1.5, outUsdPerM: 9.0 },
}
export function priceForModel(id: string): ModelPricing {
  return MODEL_PRICES[id] ?? DEFAULT_PRICING
}

/** The five stage names the UI's rail knows. Emitting anything else freezes it
 *  on the stage before, so the mapping is a name, not a free-text label. */
export type Phase = "understand" | "plan" | "sweep" | "rank" | "link" | "write"


/** Does this name exist at all? A DNS lookup is free, instant, and definitive —
 *  the one check that can tell a typo apart from a bad minute. */
async function resolves(host: string): Promise<boolean> {
  try {
    const { lookup } = await import("node:dns/promises")
    await lookup(host)
    return true
  } catch {
    return false
  }
}

/** A typo is nearly always a doubled or transposed letter in the TLD, so the
 *  useful reply is a concrete alternative rather than "check your spelling". */
function suggest(host: string): string {
  const parts = host.split(".")
  const tld = parts.at(-1) ?? ""
  const fixes = new Set<string>()
  for (const good of ["com", "io", "ai", "dev", "app", "co", "net", "org"]) {
    // one character away: a doubled letter, a missing one, or two swapped
    if (tld === good) continue
    if (tld.replace(/(.)\1/, "$1") === good) fixes.add(good)
    if (tld.length === good.length + 1 && tld.includes(good)) fixes.add(good)
  }
  const alt = [...fixes][0]
  return alt ? `Did you mean ${[...parts.slice(0, -1), alt].join(".")}?` : ""
}

/**
 * The rank phase's line for the live reading panel, one per judged host.
 *
 * The batch classifier emitted exactly this per kept entity —
 * `${domain} — ${kind}/${relation}: ${why}` — and the per-host rewrite dropped
 * it, so the panel went silent through the longest phase of the run. Restored
 * per entity as each judgement lands: model-judged hosts arrive about one a
 * second, predicate-settled ones in a burst at the start, and one frame each
 * is the same volume the panel already absorbed per batch.
 *
 * Predicate-settled hosts are included, wearing their `because`. Chosen to
 * match both the history and the neighbouring frame: the batch era showed
 * every kept classification (the predicate concept did not exist to filter
 * on), and the `ranked` results frame built beside this line already streams
 * predicate-settled entities with `because ?? why` — the reading panel saying
 * less than the findings table would be two surfaces disagreeing about the
 * same event. Noise stays off the panel, as it always was.
 *
 * The model's name rides ahead of the domain when it gave one; a predicate
 * settlement has no name beyond its host, and prints as the host alone.
 */
export function rankThinkLine(e: Judged): string | null {
  if (e.kind === "noise") return null
  const head = e.name && e.name !== e.domain ? `${e.name} (${e.domain})` : e.domain
  const reason = e.because ?? e.why
  return `${head} — ${e.kind}/${e.relation}${reason ? `: ${reason}` : ""}`
}

export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const {
    domain: anchor,
    spans,
    creds,
    model,
    modelId = "model",
    runId = "run",
    pricing = DEFAULT_PRICING,
    onLog,
    signal,
  } = opts
  // One renderer per run: templates composed on first use, rendered per call.
  // The prompts on disk cannot change mid-run, and the per-host classify call
  // used to recompose them inside the rank pool for every residue host.
  const prompt = makePrompt()
  const target = Math.max(1, Math.floor(opts.queries ?? 40))
  const CONC = Math.max(1, Math.floor(opts.concurrency ?? 20))
  const BATCH = Math.max(1, Math.floor(opts.batchSize ?? 40))

  const PAGES = Math.max(1, Math.floor(opts.pages ?? 3))
  /** How many times the run may look at what it has and ask for more. A ceiling,
   *  not a target, most runs stop earlier because the model says enough. */
  const MAX_WAVES = Math.max(1, Math.floor(opts.maxWaves ?? 4))
  /** A wave adding fewer new hosts than this is reaching ground already covered.
   *  The harness's backstop for a model that keeps asking while learning nothing. */
  const MIN_NEW_HOSTS = Math.max(1, Math.floor(opts.minNewHosts ?? 8))
  /** How many co-occurring pairs to ask about. Bounds the linking stage's cost. */
  const MAX_PAIRS = Math.max(0, Math.floor(opts.maxPairs ?? 600))
  /** Most queries any single product may take. */
  const PER_PRODUCT = Math.max(1, Math.floor(opts.perProduct ?? 5))
  /** How many of the company's own product pages to read. */
  const PRODUCT_PAGES = Math.max(0, Math.floor(opts.productPages ?? 25))
  const search = brightDataSearch(creds, { pages: PAGES })
  const fetcher = brightDataFetch(creds)

  const t0 = Date.now()
  const sec = () => Math.round((Date.now() - t0) / 1000)
  const el = () => String(sec()).padStart(3)
  let tokIn = 0
  let tokOut = 0
  let tokReasoning = 0
  let serpCalls = 0
  let unlockerCalls = 0

  /** The itemised bill, accumulated as the run spends rather than reconstructed
   *  from the trace afterwards, the trace is capped for display and a
   *  reconstruction from it would quietly under-report a wide sweep. */
  interface Line {
    label: string
    calls: number
    failures: number
    usd: number
    ms: number
  }
  const byKind = new Map<string, Line>()
  const byAgent = new Map<string, Line>()
  const bill = (kind: string, agent: string, usd: number, ms: number, ok: boolean) => {
    for (const [m, label] of [
      [byKind, kind],
      [byAgent, agent],
    ] as const) {
      const cur = m.get(label) ?? { label, calls: 0, failures: 0, usd: 0, ms: 0 }
      cur.calls += 1
      if (!ok) cur.failures += 1
      cur.usd += usd
      cur.ms += ms
      m.set(label, cur)
    }
  }
  const lines = (m: Map<string, Line>) => [...m.values()].sort((a, b) => b.usd - a.usd)

  const say = (agent: Phase, message: string) => {
    onLog?.(`${el()}s  ${message}`)
    emitUi(spans, runId, "progress", agent, { round: 1, agent, message, atSec: sec() })
  }
  /** The model's own words, verbatim, to the panel that reads along. Not a
   *  paraphrase written here, the point is to show what came back. */
  const think = (agent: Phase, text: string) => {
    emitUi(spans, runId, "agent", agent, { type: "text-delta", delta: `${text}\n` })
  }
  const emitResult = (agent: Phase, frame: Record<string, unknown>) => {
    emitUi(spans, runId, "results", agent, frame)
  }

  const usdFor = (inTok: number, outTok: number) =>
    (inTok / 1e6) * pricing.inUsdPerM + (outTok / 1e6) * pricing.outUsdPerM

  /**
   * One model call, accounted and traced.
   *
   * `think` controls reasoning, and it is the single biggest lever on the bill.
   * Output is priced six times input and is 90% of the model cost, and on one
   * 642-entity run the classification stage emitted about 160,000 output tokens
   * while the entities it produced account for roughly 35,000. The rest is the
   * model thinking out loud, billed at the output rate, thrown away unread.
   *
   * Thinking earns that on the stages where the answer is a judgement: what a
   * company sells, which markets its products fall into, whether a map is done.
   * It earns nothing on the stages where the answer is a label drawn from a
   * fixed vocabulary, which is what classification and linking are.
   *
   * `maxOutputTokens` is set for a second reason. The default is 65,536 and
   * OpenRouter reserves credit for the full amount up front, so a key with a
   * dollar of headroom is refused a call that would have cost two cents.
   *
   * `usage` is optional on the AI SDK's result, and a missing count must read as
   * zero tokens rather than as a non-finite price the stream flags as a failure.
   */
  async function call<T extends z.ZodType>(
    agent: Phase,
    label: string,
    schema: T,
    prompt: string,
    opts: { think?: "none" | "low" | "medium"; maxOutputTokens?: number } = {},
  ): Promise<z.infer<T>> {
    const started = Date.now()

    /**
     * One retry, with room to think and less thinking to do.
     *
     * A model can spend its whole output budget reasoning and return nothing:
     * finishReason "other", no object, and the AI SDK throws
     * AI_NoObjectGeneratedError. That killed a run at its third assess call,
     * discarding 71 hosts and everything already paid for to reach them.
     *
     * A run that has spent money is not something to end over one bad response.
     * The retry doubles the ceiling and drops the effort, which attacks the
     * cause from both sides, and it happens once: a second failure is a real
     * one and should surface.
     */
    /* Reasoning is model-family business. Gemini refuses `enabled: false`
     * ("Reasoning is mandatory for this endpoint"), so `none` maps to the
     * minimal effort floor. DeepSeek honours the off switch — and treats
     * "minimal" as "reason a little", which measured at 471 hidden tokens
     * eating the whole answer budget: 11.1s and a truncated reply against
     * 4.9s clean with reasoning off. `none` must mean none where it can. */
    const reasoningFor = (think: string | undefined): { enabled: false } | { effort: string } =>
      modelId.startsWith("deepseek/") && (think === "none" || think === undefined)
        ? { enabled: false }
        : { effort: think === "none" ? "minimal" : (think ?? "low") }

    /* DeepSeek routes across 23 providers of very different speeds — measured
     * 6.3s on the default pick against 3.5s sorted by throughput, same call.
     * Single-provider families are unaffected by the sort, so it only rides
     * where it was measured to matter. */
    const openrouterOpts = (think: string | undefined) => ({
      reasoning: reasoningFor(think),
      ...(modelId.startsWith("deepseek/") ? { provider: { sort: "throughput" } } : {}),
    })

    const attempt = async (maxOut: number, think: string | undefined) =>
      generateObject({
        model,
        schema,
        prompt,
        abortSignal: signal,
        maxOutputTokens: maxOut,
        providerOptions: { openrouter: openrouterOpts(think) },
      })

    const ceiling = Math.max(6_000, opts.maxOutputTokens ?? 8_192)

    try {
      const out = await generateObject({
        model,
        schema,
        prompt,
        abortSignal: signal,
        // Floored well above the answer's own size. Reasoning is mandatory on
        // this model and is spent out of the SAME output budget, so a cap sized
        // only for the answer starves it: a 1,680-token catalog call thought
        // until the connection timed out without emitting anything. The point of
        // the cap was never to be tight, only to stop reserving 65,536 tokens of
        // credit on every call.
        maxOutputTokens: Math.max(6_000, opts.maxOutputTokens ?? 8_192),
        providerOptions: {
          openrouter: openrouterOpts(opts.think),
        },
      })
      const inTok = out.usage?.inputTokens ?? 0
      const outTok = out.usage?.outputTokens ?? 0
      // Recorded so the reasoning share stops being inferred from arithmetic.
      const reasoning =
        (out.usage as { reasoningTokens?: number } | undefined)?.reasoningTokens ?? 0
      if (reasoning) tokReasoning += reasoning
      tokIn += inTok
      tokOut += outTok
      bill("llm", agent, usdFor(inTok, outTok), Date.now() - started, true)
      spans.emit({
        runId,
        agentId: agent,
        parentId: null,
        kind: "model",
        name: modelId,
        argsDigest: label,
        ms: Date.now() - started,
        ok: true,
        tokensIn: inTok,
        tokensOut: outTok,
        usd: usdFor(inTok, outTok),
      })
      return out.object as z.infer<T>
    } catch (e) {
      const empty = (e as Error).name === "AI_NoObjectGeneratedError"
      if (empty) {
        say(agent, `  ${label}: the model returned nothing, retrying with more room`)
        try {
          const out = await attempt(ceiling * 2, opts.think)
          const inTok = out.usage?.inputTokens ?? 0
          const outTok = out.usage?.outputTokens ?? 0
          tokIn += inTok
          tokOut += outTok
          bill("llm", agent, usdFor(inTok, outTok), Date.now() - started, true)
          spans.emit({
            runId,
            agentId: agent,
            parentId: null,
            kind: "model",
            name: modelId,
            argsDigest: `${label} (retried)`,
            ms: Date.now() - started,
            ok: true,
            tokensIn: inTok,
            tokensOut: outTok,
            usd: usdFor(inTok, outTok),
          })
          return out.object as z.infer<T>
        } catch {
          // fall through and report the original
        }
      }
      bill("llm", agent, 0, Date.now() - started, false)
      spans.emit({
        runId,
        agentId: agent,
        parentId: null,
        kind: "model",
        name: modelId,
        argsDigest: label,
        ms: Date.now() - started,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        usd: 0,
      })
      throw e
    }
  }

  // ── 1. read the company ──────────────────────────────────────────────────
  say("understand", `reading ${anchor}`)
  const pages: string[] = []
  const readPages: string[] = []
  // The anchor's own pages, raw bytes kept: the anchor's half of the alias
  // reciprocity check (alias.ts) — its hreflang/canonical assertions live in
  // markup that `condense` strips from `pages`. The candidate half arrives
  // later for free, in `judged.probePages` (a reciprocating alias page names
  // the anchor by its backlink, so the rank probe gate keeps it).
  const anchorPages: Array<{ url: string; html: string }> = []

  const read = async (url: string, mode: "direct" | "unlocked") => {
    const raw = await fetcher.get(url, mode)
    if (mode === "unlocked") unlockerCalls += 1
    const s = sniff(raw)
    // A `.txt` URL that answers with HTML did not have the file.
    //
    // Measured: one company's /llms.txt returns 200, content-type text/html, and
    // 608KB whose title is "Page not found" for a DIFFERENT company that acquired
    // it. The sniffer sees valid HTML with plenty of text and calls it found, so
    // that whole error page would be absorbed as the company's catalog. Status
    // codes lie, content-type lies, and length says nothing; the file extension
    // is the one thing here that states what the body was supposed to be.
    const wantedText = /\.(txt|md|xml)$/i.test(new URL(url).pathname)
    const gotHtml = isHtml(raw.body, raw.contentType)
    const wrongShape = wantedText && gotHtml
    const found = s.status === "found" && s.text.length > 300 && !wrongShape
    bill(mode === "unlocked" ? "unlocker" : "fetch", "understand", raw.usd, raw.ms, found)
    spans.emit({
      runId,
      agentId: "understand",
      parentId: null,
      kind: "fetch",
      name: mode === "unlocked" ? "unlocker" : "fetch",
      argsDigest: url,
      ms: raw.ms,
      ok: found,
      error: found ? undefined : wrongShape ? "html-for-text-url" : s.status,
      usd: raw.usd,
    })
    if (found) {
      const kept = condense(s.text)
      pages.push(`--- ${url} ---\n${kept}`)
      readPages.push(url)
      anchorPages.push({ url, html: raw.body })
      say(
        "understand",
        `  ${url} -> ${s.text.length} chars${kept.length < s.text.length ? ` (condensed to ${kept.length})` : ""}`,
      )
    }
    return found
  }

  const surfaces = [`https://${anchor}/llms.txt`, `https://docs.${anchor}/llms.txt`, `https://${anchor}/`]
  for (const u of surfaces) {
    await read(u, "direct")
  }

  /**
   * Read the pages where the company says what it sells.
   *
   * The index alone recovers every product and eighty-nine things that are not
   * products: 96% recall at 20% precision, measured against ground truth. The
   * pages themselves score 72%, because a url says what exists and only a page
   * says what it is. Costs one to two seconds, concurrent, and nothing at all,
   * since a direct fetch is free.
   */
  const productPages: PageFacts[] = []
  {
    const raw = async (u: string) => {
      const r = await fetcher.get(u, "direct")
      return r.httpStatus >= 200 && r.httpStatus < 300 ? r.body : ""
    }

    let candidates = [] as ReturnType<typeof candidatesFromSitemap>
    let xml = await raw(`https://${anchor}/sitemap.xml`)
    // A sitemap of sitemaps: folding it here would return nothing but more xml.
    if (xml && isSitemapIndex(xml)) {
      const first = /<loc>([^<]+)<\/loc>/.exec(xml)?.[1]
      xml = first ? await raw(first) : ""
    }
    if (xml) candidates = candidatesFromSitemap(xml, PRODUCT_PAGES)

    // The nav ALWAYS, merged rather than used as a fallback. One company's
    // sitemap has 118 urls of which twelve are products and another's has none,
    // but the case that decided this is a product named fifteen times on the
    // homepage and zero times in a 2,976-url sitemap. A sitemap is what a site
    // wants indexed; the nav is what it wants bought.
    {
      const home = await raw(`https://${anchor}/`)
      const fromNav = candidatesFromLinks(home, `https://${anchor}/`, PRODUCT_PAGES)
      const seen = new Set(candidates.map((c) => c.url.replace(/\/+$/, "")))
      candidates = [
        ...candidates,
        ...fromNav.filter((c) => !seen.has(c.url.replace(/\/+$/, ""))),
      ].slice(0, PRODUCT_PAGES)
    }

    if (candidates.length) {
      const read = await Promise.all(
        candidates.map(async (c) => {
          const body = await raw(c.url)
          return body ? readPageFacts(c.url, body) : null
        }),
      )
      for (const f of dedupeFacts(read.filter((f): f is PageFacts => f !== null))) productPages.push(f)
      say(
        "understand",
        `read ${productPages.length} of the company's own product pages` +
          `${candidates.length > productPages.length ? ` (${candidates.length - productPages.length} said nothing)` : ""}`,
      )
      for (const f of productPages) think("understand", `${new URL(f.url).pathname} — ${f.heading}`)
    }
  }

  // A domain that does not resolve is settled, not unlucky. Retrying it and then
  // spending an unlocker call on it wastes time and money, and, worse, the
  // "probably a temporary blip, worth running again" message that follows turns a
  // typo into an apparent outage. `brightdata.ccom` cost six fetches, an unlocker
  // call, and a reader's confidence in the tool.
  if (!pages.length && !(await resolves(anchor))) {
    throw new Error(
      `${anchor} does not resolve — there is no such domain. ${suggest(anchor)}`.trim(),
    )
  }

  // Try the free surfaces again before spending anything. A run once died here
  // reporting a company unreadable when all three direct fetches AND the unlocker
  // failed inside the same second, a network blip, not a fact about the site;
  // the same domain read fine minutes later. Direct fetches cost nothing, so
  // there was never a reason for one bad instant to end a run. Two seconds of
  // patience is cheaper than a wasted map.
  if (!pages.length) {
    say("understand", `nothing readable on the first pass — waiting a moment and trying again`)
    await new Promise((r) => setTimeout(r, 2_000))
    for (const u of surfaces) {
      if (signal?.aborted) throw new Error("aborted")
      await read(u, "direct")
    }
  }

  if (!pages.length) {
    // A site that refuses an anonymous GET is the common case, not an
    // exceptional one, and giving up here would end the run over a bot wall.
    // One unlocked fetch is ~$0.008 and 13-16s, so it is a fallback rather than
    // the default path.
    say("understand", `direct fetch found nothing — retrying ${anchor} through the unlocker`)
    await read(`https://${anchor}/`, "unlocked")
  }
  if (!pages.length) {
    throw new Error(
      `could not read ${anchor}. Tried ${surfaces.join(", ")} directly (twice, two seconds apart) and ` +
        `once through the unlocker; none returned readable text. If the site loads in a browser this is ` +
        `most likely a temporary block or a network blip — the same domain has read fine minutes later. ` +
        `Worth simply running again.`,
    )
  }

  const decomp = await call(
    "understand",
    `read ${anchor} — ${pages.length} page${pages.length === 1 ? "" : "s"}`,
    Decomposition,
    prompt("understand", {
      pages: pages.join("\n\n"),
      productPages: productPages.length
        ? renderPageFacts(productPages)
        : "(none found: no sitemap or nav gave product urls, so work from the pages above)",
    }),
    // Worth thinking about: everything downstream descends from these sentences.
    { think: "medium", maxOutputTokens: 8_000 },
  )

  say("understand", `sells: ${decomp.sells}`)
  say("understand", `${decomp.products.length} products → ${decomp.capabilities.length} distinct markets, ${decomp.coinages.length} coinages to avoid`)
  for (const c of decomp.capabilities) think("understand", `capability — ${c.name}: ${c.does}`)
  think("understand", `sells — ${decomp.sells}`)
  think("understand", `buyer — ${decomp.buyer}`)
  for (const p of decomp.products) think("understand", `product — ${p.name}: ${p.does}`)
  if (decomp.coinages.length) think("understand", `never search — ${decomp.coinages.join(", ")}`)

  emitResult("understand", {
    kind: "understanding",
    brand: anchor,
    sells: decomp.sells,
    products: decomp.products.map((p) => ({ slug: p.name, name: p.name, sells: p.does, because: "" })),
    buyer: { role: decomp.buyer, context: "", vocabulary: [], because: "" },
    coinages: decomp.coinages,
    marketConcepts: [],
    usd: usdFor(tokIn, tokOut),
  })

  // ── 2. write the catalog: the model writes debranded blind to the anchor's
  //      own name; branded templates name it on purpose (the exemption below) ──
  say(
    "plan",
    opts.queries !== undefined
      ? `writing a catalog of up to ${target} queries — the model's own writing stays anchor-blind, branded templates name it on purpose`
      : `dealing every product an opening hand — no fixed count, the templates and the strip decide`,
  )
  /**
   * One call per PRODUCT, not one per lens.
   *
   * The unit of query generation is the thing a buyer chooses and pays for.
   * Splitting by market gave a market covering three products one share between
   * them, so a proxy network, a search API and a dataset marketplace competed
   * for the same handful of queries and the smallest lost. v1 stripped each
   * product and searched for THAT product's alternatives, which is why its
   * findings hung off the product rather than off the company.
   *
   * Every product gets its own call and its own budget, so a query about the
   * unlocker's job is written by a call that is thinking about nothing else.
   * The calls run concurrently, so the stage costs the slowest product rather
   * than the sum, exactly as the lens split did.
   *
   * Core products first: an adjacent line is a real market and is not what the
   * company is bought for, so it gets whatever the budget has left.
   */
  const ranked = [...decomp.capabilities].sort((a, b) =>
    a.centrality === b.centrality ? 0 : a.centrality === "core" ? -1 : 1,
  )

  // Every product gets a hand. The funding contest died with the spec of
  // 2026-08-04: a product left unfunded is an entire market the map never
  // sees, which is the exact failure phase 3 exists to prevent. Core markets
  // still go first so the pool starts on what the company is bought for.
  const queues = ranked.map((c) => ({
    market: c,
    products: (c.covers.length ? c.covers : [c.name]).slice(),
  }))
  const funded: { market: (typeof ranked)[number]; product: string }[] = []
  {
    let moved = true
    while (moved) {
      moved = false
      for (const q of queues.filter((x) => x.market.centrality === "core")) {
        const p = q.products.shift()
        if (p) { funded.push({ market: q.market, product: p }); moved = true }
      }
    }
    moved = true
    while (moved) {
      moved = false
      for (const q of queues.filter((x) => x.market.centrality !== "core")) {
        const p = q.products.shift()
        if (p) { funded.push({ market: q.market, product: p }); moved = true }
      }
    }
  }
  say("plan", `${funded.length} products, every one dealt an opening hand`)

  // Debranded ask per product. Small on purpose: the templates already hold
  // the center, so the model's few are spent where templates cannot go.
  const debrandedAsk = Math.max(2, Math.min(PER_PRODUCT, 3))

  // The strip artifact (spec section "Strip"): per product, the terms it was
  // stripped to, whether the catalog call judged the name generic, and the
  // page that established it. Persisted so the audit trail the spec promises
  // ("the strip is a visible artifact on the map") actually exists — this used
  // to carry only `product`/`terms` and was never rendered anywhere.
  const strips: { product: string; terms: string[]; generic: boolean; foundAt: string }[] = []
  const reserve = new Map<string, FamilyQuery[]>()

  // Bounded, not unleashed. The funding contest this change removes was the
  // thing that incidentally kept this fan-out small — `funded.length` used to
  // top out around the room a fixed query budget bought. Now every product is
  // funded, so `funded.length` is the company's whole product count, and a
  // bare `Promise.all` here would fire that many concurrent model calls at
  // once. A rate limiter does not know this is a planning stage: a 429 on any
  // one of them exhausts `call()`'s single retry, and `Promise.all` is
  // all-or-nothing, so one throttled product call kills a run that has
  // already paid for everything `understand` read. Same shape of fix used
  // elsewhere in this file: a small pool, not a wide one.
  const CATALOG_CONC = 6

  const catalogs: SweptQuery[][] = []
  for (let i = 0; i < funded.length; i += CATALOG_CONC) {
    const chunk = await Promise.all(
      funded.slice(i, i + CATALOG_CONC).map(({ market, product }) =>
        call(
          "plan",
          `catalog: ${product}`,
          z.object({
            terms: z.array(z.string()).describe("1-3 terms a buyer types for this job, ordered, closest first"),
            generic: z
              .boolean()
              .describe("true if this product's NAME alone reads as a common noun rather than this product — 'Datasets' is generic, 'Web Scraper API' is not"),
            queries: z.array(PlannedQuery),
          }),
          prompt("catalog", {
            anchor,
            target: debrandedAsk,
            product,
            productDoes: market.does,
            market: market.name,
            centrality: market.centrality,
            sells: decomp.sells,
            buyer: decomp.buyer,
            siblings:
              market.covers.filter((c) => c !== product).join(", ") || "(nothing else in this market)",
            coinages: decomp.coinages.join(", "),
          }),
          { think: "low", maxOutputTokens: 180 * debrandedAsk + 6_000 },
        ).then((out) => {
          const terms = out.terms.map((t) => t.trim()).filter(Boolean).slice(0, 3)
          strips.push({
            product,
            terms,
            generic: out.generic,
            foundAt: decomp.products.find((p) => p.name === product)?.foundAt ?? "",
          })
          const hand = openingHand(product, terms, { branded: !out.generic })
          reserve.set(product, hand.reserve)
          const asFired = (fq: FamilyQuery): SweptQuery => ({
            q: fq.q,
            intent: fq.family === "plain" ? "evaluation" : "switching",
            platform: "web",
            why: fq.why,
            market: market.name,
            family: fq.family,
            product: fq.product,
            term: fq.term,
          })
          const debranded: SweptQuery[] = out.queries.map((q) => ({
            ...q,
            market: market.name,
            family: "debranded" as const,
            product,
          }))
          return [...hand.open.map(asFired), ...debranded.slice(0, debrandedAsk)]
        }),
      ),
    )
    catalogs.push(...chunk)
  }

  // Deal the company-level hand once — the owner decision, and the densest
  // comparison pages a map has. Fired outside the per-product calls because it
  // is not about any one product, it is about the company itself.
  const company: SweptQuery[] = companyHand(decomp.brand || anchor.replace(/\..*$/, "")).map((fq) => ({
    q: fq.q,
    intent: "switching",
    platform: "web",
    why: fq.why,
    market: "",
    family: fq.family,
    product: undefined,
    term: undefined,
  }))

  // Deduplicated across lenses: they were told to stay in their own lane, but
  // "best X alternatives" is reachable from two of the three, and a repeat is a
  // query bought twice.
  const seenQ = new Set<string>()
  const cat = {
    queries: [...catalogs.flat(), ...company].filter((q) => {
      const k = q.q.trim().toLowerCase()
      if (seenQ.has(k)) return false
      seenQ.add(k)
      return true
    }),
  }

  // The requested count is a sentence in a prompt, and a prompt is a request.
  // Gemini rejects array-length constraints in a structured-output schema, so
  // nothing in the schema holds the model to it either, meaning the number a
  // caller typed, the number they are billed for, and the number the model felt
  // like writing were three independent quantities.
  //
  // Clamped here instead. Over the ask is truncated, because the caller set a
  // budget and a run that quietly spends 2.5x it has broken a promise. Under the
  // ask is kept and said: a short catalog is a real outcome worth seeing, and
  // silently topping it up would hide that the market gave the model less to
  // work with than it was asked for.
  const planned = cat.queries
  // opts.queries is now an override for scripts that want a bounded probe.
  // Left unset — the normal case — the opening is the product count times the
  // hand, and the ceiling on the RUN is the spend ceiling, not a query quota.
  //
  // Copied either way, never aliased to `planned`: the anchor-naming filter
  // below splices `queries` in place, and `written: planned.length` further
  // down has to keep reporting what the model actually wrote, not what
  // survived the drop.
  const queries = opts.queries !== undefined ? planned.slice(0, target) : [...planned]


  // Coverage, stated rather than assumed. A market with no query cannot put a
  // single competitor on the map, and until now that failed silently: on one
  // measured run three of nine products drew zero queries and nothing said so.
  {
    const asked = new Map<string, number>()
    for (const q of queries) asked.set(q.market.trim().toLowerCase(), (asked.get(q.market.trim().toLowerCase()) ?? 0) + 1)
    const core = decomp.capabilities.filter((c) => c.centrality === "core")
    const missed = core.filter((c) => !asked.get(c.name.trim().toLowerCase()))
    for (const c of decomp.capabilities) {
      think("plan", `${c.centrality} · ${c.name}: ${asked.get(c.name.trim().toLowerCase()) ?? 0} queries`)
    }
    if (missed.length) {
      say("plan", `no queries for ${missed.length} of ${core.length} core markets: ${missed.map((c) => c.name).join(", ")}`)
    } else {
      say("plan", `every one of the ${core.length} core markets got at least one query`)
    }
  }
  // The truncation warning only applies when opts.queries actually clamped the
  // catalog — the normal, unset case never slices, so "using the first N"
  // would be a lie about a cut that never happened.
  if (opts.queries !== undefined && planned.length > target) {
    say("plan", `catalog: model wrote ${planned.length} for a budget of ${target} — using the first ${target}`)
  } else if (opts.queries !== undefined && planned.length < target) {
    say("plan", `catalog: model wrote ${planned.length} of the ${target} asked for`)
  }

  // `banned` (packages/core/src/families.ts) is the one implementation of this
  // check — the widening loop below runs the identical predicate on
  // reserve-released and freshly-invented queries, so a strip term or coinage
  // dropped here cannot fire unfiltered later just because it arrived through
  // a different code path.
  const anchorName = anchor.split(".")[0] ?? ""
  const named = queries.filter((x) => banned(x.q, x.family, anchorName, decomp.coinages))
  // Dropped, not counted. This only ever tested the anchor's own name and its
  // coinages, which is the one case the model cannot argue with, and it reported
  // "0 accidentally name the company" on catalogs where a quarter of the queries
  // named a third party. A query that looks the anchor up is bought for nothing,
  // so it does not get bought.
  if (named.length) {
    const drop = new Set(named.map((q) => q.q))
    for (let i = queries.length - 1; i >= 0; i--) if (drop.has(queries[i]!.q)) queries.splice(i, 1)
    say("plan", `catalog: ${queries.length} queries (dropped ${named.length} debranded/plain queries that named the anchor)`)
    for (const q of named) think("plan", `dropped, names the anchor: ${q.q}`)
  } else {
    say("plan", `catalog: ${queries.length} queries, none name the anchor`)
  }

  emitResult("plan", {
    kind: "planned",
    slug: anchor,
    brand: anchor,
    queries: queries.map((q) => ({ q: q.q, source: q.intent, rationale: q.why, concept: q.platform })),
    // Priced from Bright Data's SERP rate, which is the only part of the bill
    // that is knowable before the run, the model half depends on how much text
    // comes back.
    //
    // `target` is the 40-fallback used only when `opts.queries` clamps the
    // catalog — reporting it as `requested` on the normal, uncapped path told
    // the reader a run was capped at 40 when nothing capped it at all.
    requested: opts.queries,
    written: planned.length,
    estimatedUsd: queries.length * PAGES * 0.0015,
    budgetUsd: 0,
    uncapped: opts.queries === undefined,
  })

  // ── 3. fire, look, and decide whether to fire again ───────────────────────
  //
  // A query count fixed before the run has seen anything is a guess. The size of
  // a market is not knowable in advance, one anchor's 40 queries returned 104
  // things while another's 80 returned 88, so the run fires a wave, looks at
  // what it actually got, and decides whether that is enough.
  //
  // It stops when a wave stops paying: when new queries keep returning hosts
  // already on the map, more queries buy corroboration rather than coverage, and
  // the honest move is to stop rather than to spend the rest of the budget
  // proving what is already known.
  const hits: Array<{
    url: string
    title: string
    description: string
    q: string
    intent: string
    family: QueryFamily
    product?: string
  }> = []

  /**
   * Fire a wave, keeping the pipe full.
   *
   * This used to chunk the queries into groups of CONC and await each group, so
   * a group cost as much as its slowest member and nothing new started until
   * every one of them landed. Measured on an 80-query wave: four groups taking
   * 62s, 112s, 61s and 71s for 306s total. During the 112s group, nineteen
   * queries were finished and twenty more were waiting on one straggler.
   *
   * A pool instead. Each worker takes the next query the moment it frees up, so
   * one slow query delays only itself. Same concurrency, no barrier.
   */
  /** Search one query and record everything it produced. The pool below calls
   *  this; nothing here knows about batches or waves. */
  const runOne = async (planned: SweptQuery) => {
    const [r] = await search.search([planned.q])
    if (!r) return
    {
      const batch = [planned]
      const j = 0
      {
      serpCalls += PAGES
      bill("serp", "sweep", r.usd, r.ms, r.ok)
      // One span per SERP call, carrying the query text, the only place a
      // reader can see which question the run just paid for.
      spans.emit({
        runId,
        agentId: "sweep",
        parentId: null,
        kind: "search",
        name: "serp",
        argsDigest: r.query,
        ms: r.ms,
        ok: r.ok,
        error: r.error,
        usd: r.usd,
      })
      for (const h of r.hits)
        hits.push({ ...h, q: r.query, intent: batch[j]!.intent, family: batch[j]!.family, product: batch[j]!.product })

      // The results themselves, not just the count. Everything downstream, the
      // hosts, the classifications, the map, is derived from these rows, and
      // without them a reader is asked to trust an aggregate: "580 results, 88
      // hosts" is not something anyone can check. This is the raw material.
      emitResult("sweep", {
        kind: "searched",
        query: r.query,
        intent: batch[j]!.intent,
        platform: batch[j]!.platform,
        family: batch[j]!.family,
        product: batch[j]!.product ?? "",
        why: batch[j]!.why,
        ok: r.ok,
        error: r.error,
        ms: r.ms,
        usd: r.usd,
        hits: r.hits.map((h) => ({
          url: h.url,
          title: h.title,
          // Trimmed, not dropped: a whole page of descriptions is what made a
          // previous design's context explode, and the first sentence is what a
          // reader actually reads anyway.
          description: (h.description ?? "").slice(0, 200),
        })),
      })
      }
    }
  }

  const distinctHosts = () => {
    const s = new Set<string>()
    for (const h of hits) {
      try {
        s.add(new URL(h.url).hostname.toLowerCase().replace(/^www\./, ""))
      } catch {
        // a row without a parseable URL is not a host, skip rather than count it
      }
    }
    return s
  }

  const asked: SweptQuery[] = [...queries]
  /**
   * One queue, drained continuously, refilled while it drains.
   *
   * This used to run in waves: fire a batch, wait for all of it, ask the model
   * what is missing, fire the next batch. Two costs, both measured on one run.
   * The assess call is a serial stall, about 15 seconds each with every worker
   * idle. And a follow-up wave is small, so waves 2 to 4 spent 239 seconds
   * putting eleven queries through a twenty-wide pool.
   *
   * Here the workers never stop. The planner runs beside them and tops the queue
   * up when it drops below half the pool width, so by the time a worker wants
   * another query there is usually one waiting. Assessment overlaps searching
   * instead of interrupting it.
   */
  const queue: SweptQuery[] = [...queries]
  let taken = 0
  let sealed = false
  let rounds = 0

  let ran = 0
  const take = (): SweptQuery | null => (taken < queue.length ? queue[taken++]! : null)
  const pending = () => queue.length - taken
  const idle = (ms: number) => new Promise((r) => setTimeout(r, ms))

  say("sweep", `${queries.length} queries × ${PAGES} pages, ${CONC} at a time, topping up as it goes`)

  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw new Error("aborted")
      const planned = take()
      if (!planned) {
        // Nothing queued. Either the planner is about to add more, or it has
        // decided the map is done and this worker is finished.
        if (sealed) return
        await idle(200)
        continue
      }
      await runOne(planned)
      ran += 1
      // Every tenth, and the last. Not "whenever the queue is empty": with more
      // workers than queued queries that is true on every completion, and the
      // log becomes one line per query.
      if (ran % 10 === 0 || (sealed && ran === queue.length)) {
        say("sweep", `  ${ran}/${queue.length} queries — ${hits.length} results so far`)
      }
    }
  }

  const planner = async () => {
    while (rounds < MAX_WAVES) {
      // Wait for the queue to run low rather than empty: a refill that lands
      // while workers are still busy is a refill nobody waited for.
      while (!sealed && pending() > Math.floor(CONC / 2)) {
        if (signal?.aborted) return
        await idle(250)
      }
      if (sealed || signal?.aborted) return

      const before = distinctHosts().size
      // Per-family and per-product yield, computed from what was actually
      // asked and what actually landed — the table the widening judgement
      // reads. O(asked + hits) per round via byQ below, not O(hits × asked):
      // every product now gets funded (no funding contest capping `asked`),
      // so a `.find` per hit over a several-thousand-row `asked` would make
      // this quadratic in the run's own size, rebuilt every round.
      const hostOfHit = (u: string) => {
        try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
      }
      const famTable = (() => {
        const rowsByFam = new Map<string, { asked: number; hosts: Set<string> }>()
        const rowsByProd = new Map<string, { asked: number; hosts: Set<string> }>()
        const byQ = new Map(asked.map((x) => [x.q, x]))
        for (const q of asked) {
          const f = rowsByFam.get(q.family) ?? { asked: 0, hosts: new Set<string>() }
          f.asked += 1
          rowsByFam.set(q.family, f)
          if (q.product) {
            const p = rowsByProd.get(q.product) ?? { asked: 0, hosts: new Set<string>() }
            p.asked += 1
            rowsByProd.set(q.product, p)
          }
        }
        for (const h of hits) {
          const q = byQ.get(h.q)
          if (!q) continue
          const host = hostOfHit(h.url)
          if (!host) continue
          rowsByFam.get(q.family)?.hosts.add(host)
          if (q.product) rowsByProd.get(q.product)?.hosts.add(host)
        }
        const famLines = [...rowsByFam.entries()].map(
          ([f, v]) => `  ${f} — ${v.asked} queries, ${v.hosts.size} distinct hosts`,
        )
        const prodLines = [...rowsByProd.entries()].map(
          ([p, v]) => `  ${p} — ${v.asked} queries, ${v.hosts.size} hosts`,
        )
        return { families: famLines.join("\n"), products: prodLines.join("\n") }
      })()
      const reserveLines = [...reserve.entries()]
        .filter(([, v]) => v.length)
        .map(([p, v]) => `  ${p} — ${v.length} held: ${v.map((x) => `"${x.q}"`).join(", ")}`)
        .join("\n") || "  (all reserves released)"

      const verdict = await call(
        "plan",
        "assess",
        z.object({
          enough: z.boolean().describe("is this a map worth showing, or is something obviously missing?"),
          missing: z.string().describe("what is thin or absent, one line. Empty if nothing is."),
          draw: z
            .array(z.object({ product: z.string(), n: z.number() }))
            .describe("reserve template queries to release, per product. Empty if none."),
          queries: z.array(PlannedQuery).describe("fresh debranded queries aimed at what no template can reach. Empty if enough."),
        }),
        prompt("assess", {
          anchor,
          sells: decomp.sells,
          buyer: decomp.buyer,
          capabilities: decomp.capabilities.map((c) => `  ${c.name}`).join("\n"),
          waves: `${rounds + 1} round${rounds === 0 ? "" : "s"}`,
          hosts: before,
          asked: asked.length,
          angles: asked.map((q) => `  ${q.intent} · ${q.platform} — ${q.q}`).join("\n"),
          sample: [...distinctHosts()].slice(0, 60).join(", "),
          families: `${famTable.families}\n${famTable.products}`,
          reserve: reserveLines,
        }),
        // A judgement about whether to spend more money. Cheap, and rare.
        // 20,000 because 8,000 was not enough: medium effort against a prompt
        // carrying sixty host names and every query already asked spent the
        // whole budget thinking and returned nothing.
        { think: "medium", maxOutputTokens: 20_000 },
      )

      // queries.length === 0 alone no longer means "enough": the prompt now
      // tells the model to release reserve instead of inventing when a
      // template covers the gap, so a widening round can legitimately carry
      // zero fresh queries and a non-empty draw. Only seal here when there is
      // neither.
      if (verdict.enough || (verdict.queries.length === 0 && !verdict.draw?.length)) {
        say("plan", `enough — ${before} hosts${verdict.missing ? ` (noted gap: ${verdict.missing})` : ""}`)
        sealed = true
        return
      }

      // Reserve first: a held template is a query already judged worth its
      // family, so it outranks a freshly invented one.
      const released: SweptQuery[] = []
      for (const d of verdict.draw ?? []) {
        const held = reserve.get(d.product)
        if (!held?.length) continue
        for (const fq of held.splice(0, Math.max(1, Math.floor(d.n)))) {
          released.push({
            q: fq.q,
            intent: fq.family === "plain" ? "evaluation" : "switching",
            platform: "web",
            why: fq.why,
            market: asked.find((x) => x.product === fq.product)?.market ?? "",
            family: fq.family,
            product: fq.product,
            term: fq.term,
          })
        }
      }

      // Never ask the same thing twice. The planner sees what has been asked,
      // but it is writing under time pressure against a moving map and a repeat
      // is a query bought for nothing.
      const seen = new Set(asked.map((q) => q.q.trim().toLowerCase()))
      // Untagged by product or template — the assess call widens on a gap it
      // named in prose, not a reserve slot, so "debranded" is the honest family
      // for a query written free-form rather than drawn from a hand. Reserve
      // draws above carry their own product and family through.
      const fresh: SweptQuery[] = verdict.queries
        .filter((q) => !seen.has(q.q.trim().toLowerCase()))
        // 20: a round's fresh-invention allowance, distinct from the reserve
        // releases above, which are pre-judged and uncapped here.
        .slice(0, 20)
        .map((q) => ({ ...q, family: "debranded" as const }))

      // Both the dedupe set and the anchor-naming filter, applied to
      // EVERYTHING this round wants to fire — reserve releases included. The
      // opening batch got both checks (`named`/`banned` above); before this
      // fix the widening loop gave reserve releases NEITHER (a strip term or
      // coinage whose opening query got dropped could still fire once its
      // reserve template was drawn later) and gave `fresh` only the dedupe,
      // checked once against a `seen` that never grew as items were accepted.
      // Two products drawing reserve text that collides ("best <term>" on a
      // shared term) could both land in `asked`, silently reassigning the
      // `byQ`/`marketOf`/`familyOf` last-write-wins maps built from it further
      // down. `seen` grows as each candidate is accepted, so a collision
      // between two released queries — not just between released and
      // already-asked — is caught too.
      const proposed = [...released, ...fresh]
      const widened: SweptQuery[] = []
      for (const q of proposed) {
        const k = q.q.trim().toLowerCase()
        if (seen.has(k)) continue
        if (banned(q.q, q.family, anchorName, decomp.coinages)) continue
        seen.add(k)
        widened.push(q)
      }
      if (widened.length < proposed.length) {
        think(
          "plan",
          `round ${rounds + 1}: dropped ${proposed.length - widened.length} widened queries — duplicate or named the anchor`,
        )
      }
      if (!widened.length) {
        say("plan", `round ${rounds + 1}: every suggested query had already been asked — stopping`)
        sealed = true
        return
      }

      rounds += 1
      say(
        "plan",
        `round ${rounds}: ${verdict.missing || "widening"} — ${released.length} drawn from reserve, ${fresh.length} freshly written — ${widened.length} queries queued`,
      )
      think("plan", `after ${before} hosts the model wants more: ${verdict.missing}`)
      asked.push(...widened)
      queue.push(...widened)

      // Yield floor, measured once the round's queries have actually landed.
      // A round that adds almost nothing means the queries are reaching ground
      // already covered, and the next one would buy corroboration.
      const mine = queue.length
      while (!sealed && taken < mine && !signal?.aborted) await idle(250)
      const gained = distinctHosts().size - before
      say("sweep", `round ${rounds} added ${gained} new hosts (${distinctHosts().size} total)`)
      if (gained < MIN_NEW_HOSTS) {
        say("plan", `round ${rounds} added only ${gained} — stopping, further queries are buying corroboration`)
        sealed = true
        return
      }
    }
    sealed = true
  }

  await Promise.all([
    ...Array.from({ length: CONC }, worker),
    planner(),
  ])

  /**
   * One entry per COMPANY, not per hostname.
   *
   * A docs or blog subdomain is the same company as its parent, and classifying
   * it separately produced a map where `docs.apify.com` was a competitor while
   * `apify.com` sat eleven rows above it. Measured on one map: three of the four
   * subdomain entities were exact duplicates of a parent in the same slice, and
   * the fourth was a blog whose actual vendor had never been captured at all.
   *
   * So a subdomain folds into its parent, and its rows come along: they are the
   * same company's evidence and the parent is the thing a reader can act on. A
   * parent nobody searched up still gets created, which is how the blog case
   * recovers the vendor rather than losing it.
   *
   * Only a documentation-shaped first label folds. Stripping every subdomain
   * would turn `news.ycombinator.com` into `ycombinator.com`, and Hacker News is
   * a community while Y Combinator is an accelerator: that is one company
   * swallowing a completely different entity. These labels name a section of a
   * site rather than a thing in its own right.
   */
  const SECTION = new Set([
    "docs", "doc", "documentation", "blog", "help", "support", "developer",
    "developers", "dev", "api", "learn", "kb", "guides", "changelog", "status",
  ])
  const parentOf = (host: string): string => {
    const parts = host.split(".")
    if (parts.length <= 2) return host
    if (!SECTION.has(parts[0]!)) return host
    return parts.slice(1).join(".")
  }

  const byHost = new Map<string, typeof hits>()
  let folded = 0
  for (const h of hits) {
    let host: string
    try {
      host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, "")
    } catch {
      continue
    }
    const parent = parentOf(host)
    if (parent !== host) folded += 1
    if (!byHost.has(parent)) byHost.set(parent, [])
    byHost.get(parent)!.push(h)
  }
  say("sweep", `${hits.length} results, ${byHost.size} distinct hosts${folded ? ` (${folded} rows folded into a parent domain)` : ""}`)

  // ── 4. judge every host from its own page ─────────────────────────────────
  const hostList = [...byHost.entries()].map(([host, hs]) => ({
    host,
    seenIn: new Set(hs.map((h) => h.q)).size,
    intents: [...new Set(hs.map((h) => h.intent))],
    titles: [...new Set(hs.map((h) => h.title))].slice(0, 3),
    desc: hs[0]!.description?.slice(0, 190) ?? "",
    topHit: hs[0]?.url,
  }))

  // Left null unless the caller supplies a real one. Calibration
  // (`scripts/calibrate-kernel.ts`) found no separation between vendor and
  // directory front pages on the measured sample, so shipping a guessed 12
  // would be arithmetic dressed as evidence. `report.kernel.threshold` below
  // carries this value through honestly, null included.
  const KERNEL_THRESHOLD = opts.aggregatorThreshold ?? null
  say(
    "rank",
    `judging ${hostList.length} hosts from their own front pages, predicates first` +
      (KERNEL_THRESHOLD === null ? ", aggregator rule off" : `, aggregator threshold ${KERNEL_THRESHOLD}`),
  )

  const entities: Entity[] = []
  let judgedCount = 0
  let rankedBuffer: Judged[] = []
  const flushRanked = () => {
    const kept = rankedBuffer.filter((e) => e.kind !== "noise")
    if (kept.length) {
      emitResult("rank", {
        kind: "ranked",
        candidates: kept.map((e) => ({
          domain: e.domain, name: e.name || e.domain, kind: e.kind, relation: e.relation,
          what: e.what, why: e.because ?? e.why, breadth: byHost.get(e.domain)?.length ?? 0,
        })),
      })
    }
    rankedBuffer = []
  }

  const judged = await judgeHosts(hostList, {
    fetcher,
    anchor,
    aggregatorThreshold: KERNEL_THRESHOLD,
    // The rank pool is the run's longest phase: free direct fetches plus one
    // short model call per residue host. 8 was the kernel's launch width;
    // OPENKB_RANK_CONCURRENCY raises it when the model provider's rate allows
    // — doubling the pool roughly halves the phase, and a provider that
    // objects answers with 429s the caller will see, not silent loss.
    concurrency: Math.max(1, Math.floor(Number(process.env.OPENKB_RANK_CONCURRENCY ?? 8) || 8)),
    signal,
    onFetch: (url, ok, ms) => {
      bill("fetch", "rank", 0, ms, ok)
      spans.emit({
        runId, agentId: "rank", parentId: null, kind: "fetch", name: "fetch",
        argsDigest: url, ms, ok, usd: 0,
      })
    },
    onJudged: (e) => {
      rankedBuffer.push(e)
      judgedCount += 1
      // The judgement itself, to the reading panel, as it lands — the batch
      // classifier's think line, restored to the per-host path.
      const line = rankThinkLine(e)
      if (line) think("rank", line)
      if (rankedBuffer.length >= 25) flushRanked()
      if (judgedCount % 50 === 0) say("rank", `  judged ${judgedCount}/${hostList.length}`)
    },
    classify: async (h, pageText) => {
      const out = await call(
        "rank",
        `classify ${h.host}`,
        z.object({
          name: z.string(),
          kind: z.enum(ENTITY_KINDS),
          what: z.string().describe("what it is, one line, from the page itself"),
          relation: z.enum(RELATIONS),
          why: z.string().describe("why it belongs on this map, stated against the anchor"),
          spans: z
            .array(z.string())
            .min(1)
            .max(3)
            .describe("1-3 short quotes copied character-for-character from the page, together backing the what"),
        }),
        prompt("classify", {
          anchor, sells: decomp.sells, buyer: decomp.buyer,
          host: h.host, seenIn: String(h.seenIn), intents: h.intents.join(","),
          page: pageText,
        }),
        { think: "none", maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS },
      )
      return out
    },
  })
  flushRanked()
  if (signal?.aborted) throw new Error("aborted")
  entities.push(...judged.entities.map((e) => ({ ...e } as Entity)))
  say("rank", `${judged.stats.settledFree} hosts settled by predicate for $0; ${judged.stats.modelJudged} judged by the model`)

  // ── report ────────────────────────────────────────────────────────────────
  // ── attribute every entity to the markets whose queries surfaced it ───────
  // Free: byHost already maps host -> hits, each hit carries its query, and
  // each query carries its market. The join was simply never done.
  {
    /**
     * Snap each query's market onto a declared one, or drop it.
     *
     * The prompt asks for a character-for-character copy and a measured run
     * still returned its LENS there ("Who solves it a different way", 25
     * entities), a market the planner invented mid-round, and the same market
     * in two casings. A rule the model can miss needs a check that cannot.
     *
     * Case-insensitive match against the declared list, and anything that does
     * not match resolves to nothing: an entity with no market falls back to the
     * anchor, which is honest, where a made-up market node is not.
     */
    const declared = new Map(decomp.capabilities.map((c) => [c.name.trim().toLowerCase(), c.name]))
    const canonical = (m: string | undefined) => (m ? declared.get(m.trim().toLowerCase()) : undefined)
    const marketOf = new Map(asked.map((q) => [q.q, canonical(q.market)]))
    const familyOf = new Map(asked.map((q) => [q.q, q.family]))

    const stray = new Set(asked.map((q) => q.market).filter((m) => m && !canonical(m)))
    if (stray.size) {
      say("rank", `${stray.size} queries named a market that was never declared; their hosts fall back to the anchor`)
      for (const m of stray) think("rank", `undeclared market on a query: ${m}`)
    }
    for (const e of entities) {
      const rows = byHost.get(e.domain.toLowerCase().replace(/^www\./, "")) ?? []
      const counts = new Map<string, number>()
      for (const h of rows) {
        const m = marketOf.get(h.q)
        if (m) counts.set(m, (counts.get(m) ?? 0) + 1)
      }
      if (counts.size) {
        e.foundBy = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
      }
      const fams = new Map<QueryFamily, number>()
      for (const h of rows) {
        const f = familyOf.get(h.q)
        if (f) fams.set(f, (fams.get(f) ?? 0) + 1)
      }
      if (fams.size) e.families = [...fams.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
    }
  }

  const keep = entities.filter((e) => e.kind !== "noise")
  // The hosts that reached the map, for the co-occurrence pass below.
  const keptHosts = new Set(keep.map((e) => e.domain.toLowerCase().replace(/^www\./, "")))

  /**
   * How the entities relate to each other.
   *
   * 387 entities is 74,691 possible pairs, so the pairs have to be SELECTED
   * before anything is asked. The selector is free and already measured: two
   * hosts returned by the same query co-occurred in a real retrieval. A search
   * engine putting two vendors on one results page is the search engine saying
   * they answer the same question, which is what competing looks like.
   *
   * A pair needs two different queries to qualify. One shared query is what any
   * two pages of a broad search have in common; corroboration across differently
   * worded questions is the signal that separated real findings from noise
   * everywhere else in this run.
   */
  const coPairs = (() => {
    const byQuery = new Map<string, Set<string>>()
    for (const h of hits) {
      let host: string
      try {
        host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, "")
      } catch {
        continue
      }
      if (!keptHosts.has(host)) continue
      if (!byQuery.has(h.q)) byQuery.set(h.q, new Set())
      byQuery.get(h.q)!.add(host)
    }
    const score = new Map<string, number>()
    for (const hosts of byQuery.values()) {
      // A query that returned almost everything says nothing about any pair in
      // it. Skip it rather than let it inflate every score it touches.
      const list = [...hosts]
      if (list.length > 40) continue
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = [list[i]!, list[j]!].sort().join("|")
          score.set(key, (score.get(key) ?? 0) + 1)
        }
      }
    }
    return [...score.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PAIRS)
      .map(([k, n]) => {
        const [a, b] = k.split("|") as [string, string]
        return { a, b, seen: n }
      })
  })()

  const edges: EntityEdge[] = []

  /**
   * Systematic linking, before any model sees a pair.
   *
   * Taken from v1, which joined a community to the vendors it discusses by
   * asking one question of the text: does it NAME them. A word boundary match,
   * no judgement, no call.
   *
   * It belongs first because it is the stronger evidence. A page that writes a
   * company's name is a fact about that page; a model deciding two hosts are
   * related because they co-occurred is an inference, and an audit of this
   * engine's inferences on thin evidence found more wrong than right. So
   * matching runs first, its edges are `measured`, and the model is left only
   * the pairs no page resolved.
   *
   * Free, and it costs no wall clock worth measuring.
   */
  const namesIt = (haystack: string, needle: string): boolean =>
    new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack)

  {
    const spellings: { entity: Entity; terms: string[] }[] = keep.map((e) => {
      const host = e.domain.toLowerCase().replace(/^www\./, "")
      return {
        entity: e,
        // The company's name and its full host, and nothing else. Matching a
        // host's first label instead looked clever and was not: it made "cloud"
        // a spelling of cloud.google.com, "guides" of a university library, and
        // "google" of four separate entities, so a page saying "cloud" linked to
        // Google. v1 matched name and slug only, and was right.
        terms: [...new Set([e.name, host])].filter((t) => t && t.length > 3),
      }
    })

    const seenEdge = new Set<string>()
    let matched = 0
    for (const [host, rows] of byHost) {
      const src = keep.find((e) => e.domain.toLowerCase().replace(/^www\./, "") === host)
      if (!src) continue
      // Only what this host's own results said, which is text the run retrieved.
      const blob = rows.map((r) => `${r.title} ${r.description ?? ""}`).join("\n")
      for (const { entity, terms } of spellings) {
        const target = entity.domain.toLowerCase().replace(/^www\./, "")
        if (target === host) continue
        const hit = terms.find((t) => namesIt(blob, t))
        if (!hit) continue
        const key = `${host}|${target}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({
          from: host,
          to: target,
          // What the naming means depends on what the namer is. A forum naming a
          // vendor discusses it; a directory lists it; a publication covers it;
          // a vendor naming a vendor is positioning against one.
          relation:
            src.kind === "community"
              ? "discusses"
              : src.kind === "directory"
                ? "lists"
                : src.kind === "publisher"
                  ? "covers"
                  : src.kind === "company" || src.kind === "product"
                    ? "competitor"
                    : "unknown",
          why: `a page on ${host} names "${hit}"`,
          confidence: "measured",
        })
        matched += 1
      }
    }
    if (matched) say("link", `${matched} edges from pages that name another player outright`)
  }

  // Whatever the free pass already answered is not worth asking a model about.
  const resolved = new Set(edges.map((e) => [e.from, e.to].sort().join("|")))
  const unresolved = coPairs.filter((p) => !resolved.has([p.a, p.b].sort().join("|")))
  if (resolved.size) {
    say("link", `${coPairs.length - unresolved.length} of ${coPairs.length} pairs already answered by a page`)
  }

  if (unresolved.length && !opts.skipModelLinking) {
    say("link", `${unresolved.length} pairs co-occurred but no page names either — asking how they relate`)
    const byDomain = new Map(keep.map((e) => [e.domain.toLowerCase().replace(/^www\./, ""), e]))
    const describe = (d: string) => {
      const e = byDomain.get(d)
      return e ? `${d} (${e.kind}) — ${e.what}` : d
    }

    const pairBatches: (typeof coPairs)[] = []
    for (let i = 0; i < unresolved.length; i += BATCH) pairBatches.push(unresolved.slice(i, i + BATCH))

    let linked = 0
    await Promise.all(
      pairBatches.map(async (batch, n) => {
        if (signal?.aborted) throw new Error("aborted")
        const out = await call(
          "link",
          `link batch ${n + 1} of ${pairBatches.length}`,
          z.object({ edges: z.array(EntityEdge) }),
          prompt("link", {
            anchor,
            sells: decomp.sells,
            pairs: batch
              .map((p) => `${describe(p.a)}\n   ${describe(p.b)}\n   co-occurred in ${p.seen} different searches`)
              .join("\n\n"),
          }),
          { think: "none", maxOutputTokens: 200 * batch.length + 6_000 },
        )
        // Only edges whose ends are both on the map. A model naming something it
        // remembers rather than something the run found is a dangling edge, and
        // v1 shipped sixteen of them before anyone noticed.
        for (const e of out.edges) {
          const from = e.from.toLowerCase().replace(/^www\./, "")
          const to = e.to.toLowerCase().replace(/^www\./, "")
          if (from === to) continue
          if (!byDomain.has(from) || !byDomain.has(to)) continue
          edges.push({ ...e, from, to })
        }
        linked += batch.length
        say("link", `  ${linked}/${unresolved.length} pairs`)
      }),
    )
    say("link", `${edges.length} edges between entities`)
  }

  // Summed from what was actually billed, not re-derived from the counters: a
  // SERP call that never reached Bright Data carries usd 0 and re-deriving from
  // `serpCalls * price` would charge the run for it.
  //
  // Taken HERE, after the paid model-linking phase above, not before it. A
  // snapshot taken before linking undercounted every run's cost by 14-24% and
  // its duration by up to 49% — linking is real spend and real wall clock, and
  // a reader comparing `report.usd`/`report.seconds` against `report.cost.usd`
  // (assembled from the same `byKind`/`byAgent` lines, always fresh) deserves
  // numbers that do not contradict each other.
  const usd = lines(byKind).reduce((n, l) => n + l.usd, 0)
  const seconds = (Date.now() - t0) / 1000
  const count = (arr: string[]) => arr.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})

  const stats: SweepStats = {
    queries: queries.length,
    results: hits.length,
    hosts: byHost.size,
    kept: keep.length,
    tokIn,
    tokOut,
    tokReasoning,
    serpCalls,
    unlockerCalls,
    usd,
    seconds,
  }

  say("write", `${keep.length} on the map from ${byHost.size} hosts`)

  // A family contributing nothing must be reported, not absorbed: the doctrine
  // or the templates have a hole and the only way anyone finds it is here.
  {
    const fam = count(asked.map((q) => q.family))
    for (const f of ["plain", "debranded", "branded"] as const) {
      if (!fam[f]) say("plan", `the ${f} family asked nothing this run — its doctrine or templates have a hole`)
    }
  }

  // The one defensible coverage number: recall against the pages the run
  // itself retrieved that name the anchor and enumerate vendors — no
  // estimator, no guess. `judged.probePages` is exactly the set `judgeHosts`
  // kept while judging; nothing extra is fetched to compute this.
  const mapHosts = new Set(
    entities
      .filter((e) => e.kind === "company" || e.kind === "product")
      .map((e) => registrableHost(e.domain || e.name)),
  )
  // The anchor's structural alias set, both halves from pages already paid
  // for: the anchor's assertions out of `anchorPages` (understand kept the
  // raw bytes), the reciprocation out of `judged.probePages` (an alias's
  // front page names the anchor, so rung 0 kept it as a probe candidate).
  // Reciprocity or nothing — one-sided is forgeable. The scorer then drops
  // alias-hosted probes and alias vendors in one place; the rise this causes
  // against un-aliased runs is a bug fix in the instrument, not a coverage
  // improvement, and `recall.aliasExclusion.note` ships that sentence.
  // Map identity is untouched: an alias stays its own entity row.
  const anchorAliases = anchorAliasSet([...anchorPages, ...judged.probePages], anchor)
  const recall = answerKeyRecall(judged.probePages, { anchor, mapHosts, anchorAliases })
  if (recall.aliasExclusion) say("write", `recall: ${recall.aliasExclusion.note}`)

  const report: Record<string, unknown> = {
    domain: anchor,
    sells: decomp.sells,
    // Everything actually fired, opening hand plus every widening round —
    // matches the sum of `families` below. `stats.queries` (unchanged,
    // read by the run registry and the older surfaces) stays the opening
    // count alone; `opening` here is that same number, named, so the two
    // can no longer be mistaken for the same quantity. Measured gap on one
    // run: 63 opening vs 123 fired.
    queries: asked.length,
    opening: queries.length,
    results: hits.length,
    hosts: byHost.size,
    entities: entities.length,
    kept: keep.length,
    noise: entities.length - keep.length,
    kinds: count(keep.map((e) => e.kind)),
    relations: count(keep.map((e) => e.relation)),
    families: count(asked.map((q) => q.family)),
    strips,
    readPages,
    usd,
    seconds,
    kernel: { ...judged.stats, threshold: KERNEL_THRESHOLD },
    recall,
    cost: {
      usd,
      elapsedMs: Date.now() - t0,
      calls: lines(byKind).reduce((n, l) => n + l.calls, 0),
      tokens: tokIn + tokOut,
      // Null when the caller supplied none (CLI runs). The web route passes
      // its real per-deployment ceiling; a hardcoded null here used to claim
      // this engine has no ceiling at all, when the deployment enforces one.
      ceilingUsd: opts.ceilingUsd ?? null,
      byKind: lines(byKind),
      byAgent: lines(byAgent),
      partial: false,
    },
  }

  emitResult("write", { kind: "complete", result: report })

  return { anchor, decomposition: decomp, queries, entities, edges, stats, report }
}
