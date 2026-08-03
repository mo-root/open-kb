/**
 * Sweep: the shape the map actually wants.
 *
 *   1. read the company, free fetch, one model call -> what it sells
 *   2. write the catalog, one model call -> N queries, generated before any company
 *                                name is known, so a look-up query is impossible to write
 *   3. fire everything at once, parallel, cheap
 *   4. extract in bulk, every company visible in the results, in batches
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
import { sniff, condense, isHtml, type SearchResult, type SpanStream } from "@open-kb/core"
import {
  brightDataSearch,
  brightDataFetch,
  type BrightDataCredentials,
} from "@open-kb/providers"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { composePrompt, render } from "@open-kb/core"

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

/** An agent's full instruction: its own file, with the doctrine it declares. */
function prompt(agent: string, vars: Record<string, string | number>): string {
  const root = promptsRoot()
  return render(composePrompt(agent, join(root, "agents"), join(root, "doctrine")), vars)
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
] as const

/**
 * How an entity stands to the anchor.
 *
 * The first seven are commercial stances. The last three cover hosts that have
 * no commercial stance but still relate: publications, directories, forums.
 * With only commercial words, 144 of 438 hosts on one run came back `none` and
 * dropped off the map, since a node with no relation gets no edge.
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
  "none",
] as const

const Decomposition = z.object({
  sells: z.string().describe("what this company sells, in one plain sentence, no marketing words"),
  buyer: z.string().describe("who buys it and what has just gone wrong for them"),
  products: z.array(
    z.object({
      name: z.string(),
      does: z.string().describe("what this product does, stripped of the company's own naming"),
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
export type Entity = z.infer<typeof Entity>

export interface SweepStats {
  queries: number
  results: number
  hosts: number
  kept: number
  tokIn: number
  tokOut: number
  serpCalls: number
  unlockerCalls: number
  usd: number
  seconds: number
}

export interface SweepResult {
  anchor: string
  decomposition: Decomposition
  queries: PlannedQuery[]
  entities: Entity[]
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
  /** How many queries the catalog is asked for. The single biggest lever on
   *  both cost and breadth. */
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
  /** Hosts per classification batch. */
  batchSize?: number
  /** Classification batches in flight at once. */
  rankConcurrency?: number
  /** The CLI's console. Left unset in the browser, where the span stream is the
   *  only output. */
  onLog?: (line: string) => void
  signal?: AbortSignal
}

const DEFAULT_PRICING: ModelPricing = { inUsdPerM: 1.5, outUsdPerM: 9.0 }

/** The five stage names the UI's rail knows. Emitting anything else freezes it
 *  on the stage before, so the mapping is a name, not a free-text label. */
export type Phase = "understand" | "plan" | "sweep" | "rank" | "write"


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
  /** Classification batches in flight at once. They have no dependency on each
   *  other; the only reason not to run all of them is the provider's patience. */
  const RANK_CONC = Math.max(1, Math.floor(opts.rankConcurrency ?? 6))
  const search = brightDataSearch(creds, { pages: PAGES })
  const fetcher = brightDataFetch(creds)

  const t0 = Date.now()
  const sec = () => Math.round((Date.now() - t0) / 1000)
  const el = () => String(sec()).padStart(3)
  let tokIn = 0
  let tokOut = 0
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

  /** One model call, accounted and traced. `usage` is optional on the AI SDK's
   *  result, and a missing count must read as zero tokens rather than as a
   *  non-finite price the stream then flags as a failure. */
  async function call<T extends z.ZodType>(
    agent: Phase,
    label: string,
    schema: T,
    prompt: string,
  ): Promise<z.infer<T>> {
    const started = Date.now()
    try {
      const out = await generateObject({ model, schema, prompt, abortSignal: signal })
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
        argsDigest: label,
        ms: Date.now() - started,
        ok: true,
        tokensIn: inTok,
        tokensOut: outTok,
        usd: usdFor(inTok, outTok),
      })
      return out.object as z.infer<T>
    } catch (e) {
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
    prompt("understand", { pages: pages.join("\n\n") }),
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

  // ── 2. write the catalog, knowing no company names ────────────────────────
  say("plan", `writing a catalog of ${target} queries that never name the company`)
  const cat = await call(
    "plan",
    `catalog ${target} queries for ${anchor}'s market`,
    z.object({ queries: z.array(PlannedQuery) }),
    prompt("catalog", {
      anchor,
      target,
      sells: decomp.sells,
      buyer: decomp.buyer,
      capabilities: decomp.capabilities
        .map((c) => `${c.name} — ${c.does}${c.covers.length > 1 ? `  (covers ${c.covers.join(", ")})` : ""}`)
        .join("\n  "),
      coinages: decomp.coinages.join(", "),
    }),
  )

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
  const queries = planned.slice(0, target)
  if (planned.length > target) {
    say("plan", `catalog: model wrote ${planned.length} for a budget of ${target} — using the first ${target}`)
  } else if (planned.length < target) {
    say("plan", `catalog: model wrote ${planned.length} of the ${target} asked for`)
  }

  const forbidden = [anchor.split(".")[0], ...decomp.coinages].filter(Boolean) as string[]
  const named = forbidden.length
    ? queries.filter((x) =>
        new RegExp(`\\b(${forbidden.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i").test(x.q),
      )
    : []
  say("plan", `catalog: ${queries.length} queries, ${named.length} accidentally name the company`)
  think("plan", `${queries.length} queries planned; ${named.length} slipped a company name through`)

  emitResult("plan", {
    kind: "planned",
    slug: anchor,
    brand: anchor,
    queries: queries.map((q) => ({ q: q.q, source: q.intent, rationale: q.why, concept: q.platform })),
    // Priced from Bright Data's SERP rate, which is the only part of the bill
    // that is knowable before the run, the model half depends on how much text
    // comes back.
    requested: target,
    written: planned.length,
    estimatedUsd: queries.length * PAGES * 0.0015,
    budgetUsd: 0,
    uncapped: false,
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
  const hits: Array<{ url: string; title: string; description: string; q: string; intent: string }> = []

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
  const fire = async (batchQueries: PlannedQuery[]) => {
    let next = 0
    let done = 0

    const handleOne = (r: SearchResult, planned: PlannedQuery) => {
      const res = [r]
      const batch = [planned]
      res.forEach((r, j) => {
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
      for (const h of r.hits) hits.push({ ...h, q: r.query, intent: batch[j]!.intent })

      // The results themselves, not just the count. Everything downstream, the
      // hosts, the classifications, the map, is derived from these rows, and
      // without them a reader is asked to trust an aggregate: "580 results, 88
      // hosts" is not something anyone can check. This is the raw material.
      emitResult("sweep", {
        kind: "searched",
        query: r.query,
        intent: batch[j]!.intent,
        platform: batch[j]!.platform,
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
    })
    }

    const worker = async () => {
      while (true) {
        if (signal?.aborted) throw new Error("aborted")
        const i = next++
        if (i >= batchQueries.length) return
        const planned = batchQueries[i]!
        const [r] = await search.search([planned.q])
        if (r) handleOne(r, planned)
        done += 1
        // Every tenth, and the last, so a long wave still reports progress
        // without a line per query.
        if (done % 10 === 0 || done === batchQueries.length) {
          say("sweep", `  ${done}/${batchQueries.length} — ${hits.length} results so far`)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONC, batchQueries.length) }, worker))
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

  const asked: PlannedQuery[] = [...queries]
  let wave = 1
  say("sweep", `wave 1 — ${queries.length} queries × ${PAGES} pages`)
  await fire(queries)

  while (wave < MAX_WAVES) {
    if (signal?.aborted) throw new Error("aborted")
    const before = distinctHosts().size

    // Ask, rather than assume. The model sees how big the map is, what the last
    // wave added, and which angles have been worked, and decides whether this
    // is a map worth showing or one with an obvious hole in it. `enough` is its
    // call; the yield floor below is the harness's backstop for when it keeps
    // saying no while learning nothing.
    const verdict = await call(
      "plan",
      "assess",
      z.object({
        enough: z.boolean().describe("is this a map worth showing, or is something obviously missing?"),
        missing: z.string().describe("what is thin or absent — one line. Empty if nothing is."),
        queries: z.array(PlannedQuery).describe("queries aimed at what is missing. Empty if enough."),
      }),
      prompt("assess", {
        anchor,
        sells: decomp.sells,
        buyer: decomp.buyer,
        waves: `${wave} wave${wave === 1 ? "" : "s"}`,
        hosts: before,
        asked: asked.length,
        angles: asked.map((q) => `  ${q.intent} · ${q.platform} — ${q.q}`).join("\n"),
        sample: [...distinctHosts()].slice(0, 60).join(", "),
      }),
    )

    if (verdict.enough || verdict.queries.length === 0) {
      say("plan", `wave ${wave}: enough — ${before} hosts${verdict.missing ? ` (noted gap: ${verdict.missing})` : ""}`)
      break
    }

    wave += 1
    const next = verdict.queries.slice(0, Math.max(1, Math.floor(target / 2)))
    say("plan", `wave ${wave}: ${verdict.missing || "widening"} — ${next.length} more queries`)
    think("plan", `after ${before} hosts the model wants more: ${verdict.missing}`)
    asked.push(...next)
    await fire(next)

    const gained = distinctHosts().size - before
    say("sweep", `wave ${wave} added ${gained} new hosts (${distinctHosts().size} total)`)
    if (gained < MIN_NEW_HOSTS) {
      // The backstop. A wave that adds almost nothing means the queries are
      // reaching ground already covered, and another wave would spend money to
      // confirm what is already known.
      say("plan", `wave ${wave} added only ${gained} — stopping, further queries are buying corroboration`)
      break
    }
  }

  const byHost = new Map<string, typeof hits>()
  for (const h of hits) {
    let host: string
    try {
      host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, "")
    } catch {
      continue
    }
    if (!byHost.has(host)) byHost.set(host, [])
    byHost.get(host)!.push(h)
  }
  say("sweep", `${hits.length} results, ${byHost.size} distinct hosts`)

  // ── 4. extract in bulk ────────────────────────────────────────────────────
  const hostList = [...byHost.entries()].map(([host, hs]) => ({
    host,
    seenIn: new Set(hs.map((h) => h.q)).size,
    intents: [...new Set(hs.map((h) => h.intent))],
    titles: [...new Set(hs.map((h) => h.title))].slice(0, 3),
    desc: hs[0]!.description?.slice(0, 190) ?? "",
  }))

  const batches: typeof hostList[] = []
  for (let i = 0; i < hostList.length; i += BATCH) batches.push(hostList.slice(i, i + BATCH))

  // In parallel, because these batches never needed to wait for each other.
  //
  // Each one classifies its own hosts against the anchor and reads nothing from
  // any other, yet they ran one after another, eleven calls at ~44s each on one
  // measured run, which was 485 of that run's 771 seconds. Sixty-three percent of
  // the wall clock spent queueing behind work that had no dependency on it.
  //
  // Capped rather than unleashed: forty batches at once is a rate-limit waiting to
  // happen, and a 429 costs more than the queueing did.
  say("rank", `classifying ${hostList.length} hosts in ${batches.length} batches, ${RANK_CONC} at a time`)
  const entities: Entity[] = []
  let done = 0

  const classify = async (slice: typeof hostList, n: number) => {
    if (signal?.aborted) throw new Error("aborted")
    const out = await call(
      "rank",
      `classify batch ${n + 1} of ${batches.length}`,
      z.object({ entities: z.array(Entity) }),
      prompt("classify", {
        anchor,
        sells: decomp.sells,
        buyer: decomp.buyer,
        hosts: slice
          .map((h) => `${h.host}  seenIn=${h.seenIn}  intents=${h.intents.join(",")}\n   ${h.titles.join(" | ")}\n   ${h.desc}`)
          .join("\n\n"),
      }),
    )
    entities.push(...out.entities)
    done += slice.length
    say("rank", `  classified ${done}/${hostList.length}`)

    // Streamed per batch rather than held to the end: the findings table fills
    // while the run is still working, which is the difference between a live
    // surface and a progress bar.
    const kept = out.entities.filter((e) => e.kind !== "noise")
    if (kept.length) {
      emitResult("rank", {
        kind: "ranked",
        candidates: kept.map((e) => ({
          domain: e.domain || e.name,
          name: e.name,
          kind: e.kind,
          relation: e.relation,
          what: e.what,
          why: e.why,
          breadth: byHost.get(e.domain)?.length ?? 0,
        })),
      })
      think("rank", kept.map((e) => `${e.domain} — ${e.kind}/${e.relation}: ${e.why}`).join("\n"))
    }
  }

  for (let i = 0; i < batches.length; i += RANK_CONC) {
    await Promise.all(batches.slice(i, i + RANK_CONC).map((b, k) => classify(b, i + k)))
  }

  // ── report ────────────────────────────────────────────────────────────────
  const keep = entities.filter((e) => e.kind !== "noise")
  // Summed from what was actually billed, not re-derived from the counters: a
  // SERP call that never reached Bright Data carries usd 0 and re-deriving from
  // `serpCalls * price` would charge the run for it.
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
    serpCalls,
    unlockerCalls,
    usd,
    seconds,
  }

  say("write", `${keep.length} on the map from ${byHost.size} hosts`)

  const report: Record<string, unknown> = {
    domain: anchor,
    sells: decomp.sells,
    queries: queries.length,
    results: hits.length,
    hosts: byHost.size,
    entities: entities.length,
    kept: keep.length,
    noise: entities.length - keep.length,
    kinds: count(keep.map((e) => e.kind)),
    relations: count(keep.map((e) => e.relation)),
    usd,
    seconds,
    cost: {
      usd,
      elapsedMs: Date.now() - t0,
      calls: lines(byKind).reduce((n, l) => n + l.calls, 0),
      tokens: tokIn + tokOut,
      // Explicitly null, not absent: this engine has no per-run dollar ceiling,
      // and an absent field would read as "we never learned it".
      ceilingUsd: null,
      byKind: lines(byKind),
      byAgent: lines(byAgent),
      partial: false,
    },
  }

  emitResult("write", { kind: "complete", result: report })

  return { anchor, decomposition: decomp, queries, entities, stats, report }
}
