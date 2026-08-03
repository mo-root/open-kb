/**
 * Sweep: the shape the map actually wants.
 *
 *   1. read the company        — free fetch, one model call -> what it sells
 *   2. write the catalog       — one model call -> N queries, generated BEFORE any company
 *                                name is known, so a look-up query is impossible to write
 *   3. fire everything at once — parallel, cheap
 *   4. extract in bulk         — every company visible in the results, in batches
 *
 * This is the library form of what `scripts/sweep.ts` used to be inline. It is
 * the SAME code the CLI and the web route run — the script is now a thin
 * argv-and-console wrapper — so a fix made for the browser is a fix the script
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
import { sniff, type SpanStream } from "@open-kb/core"
import {
  brightDataSearch,
  brightDataFetch,
  type BrightDataCredentials,
} from "@open-kb/providers"
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

export const RELATIONS = [
  "competitor",
  "substitute",
  "dependency",
  "integration",
  "shaper",
  "buyer",
  "target",
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

/** Dollars per million tokens. Accounting only — nothing here bills anyone, and
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
  /** SERP calls in flight at once. */
  concurrency?: number
  /** Hosts per classification batch. */
  batchSize?: number
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

  const search = brightDataSearch(creds)
  const fetcher = brightDataFetch(creds)

  const t0 = Date.now()
  const sec = () => Math.round((Date.now() - t0) / 1000)
  const el = () => String(sec()).padStart(3)
  let tokIn = 0
  let tokOut = 0
  let serpCalls = 0
  let unlockerCalls = 0

  /** The itemised bill, accumulated as the run spends rather than reconstructed
   *  from the trace afterwards — the trace is capped for display and a
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
   *  paraphrase written here — the point is to show what came back. */
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
    const found = s.status === "found" && s.text.length > 300
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
      error: found ? undefined : s.status,
      usd: raw.usd,
    })
    if (found) {
      pages.push(`--- ${url} ---\n${s.text.slice(0, 14_000)}`)
      say("understand", `  ${url} -> ${s.text.length} chars`)
    }
    return found
  }

  const surfaces = [`https://${anchor}/llms.txt`, `https://docs.${anchor}/llms.txt`, `https://${anchor}/`]
  for (const u of surfaces) {
    await read(u, "direct")
  }

  // A domain that does not resolve is settled, not unlucky. Retrying it and then
  // spending an unlocker call on it wastes time and money, and — worse — the
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
  // failed inside the same second — a network blip, not a fact about the site;
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
    `Read this company's own material and work out what it sells.\n\n${pages.join("\n\n")}`,
  )

  say("understand", `sells: ${decomp.sells}`)
  say("understand", `${decomp.products.length} products, ${decomp.coinages.length} coinages to avoid`)
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
    `You are writing search queries that will find every company in a market.

The market is defined by what this company does — NOT by its name:
  sells:    ${decomp.sells}
  buyer:    ${decomp.buyer}
  products: ${decomp.products.map((p) => `${p.does}`).join(" | ")}

Write ${target} queries. Absolute rules:

- **Never name a company.** Not "${anchor}", not any of these invented words: ${decomp.coinages.join(", ")}. Not a competitor's name either — you do not know any yet, and naming one bounds the search to pages someone already wrote about it.
- Describe what the thing DOES, the way a buyer who has never heard of any vendor would type it.
- Each query must ask a DIFFERENT question. Two rephrasings of one idea buy the same page twice.
- Spread across intents: what breaks and hurts, people switching away from something, people comparing options, people building, people discovering, integrations, hiring, and where this market gathers.
- Spread across platforms. For a platform query, use a site: operator or name the platform in the text.
- For the community intent, look for where these buyers actually talk — subreddits, forums, conferences, newsletters.
- Give every query a one-line \`why\`: what it is expected to surface that the others will not.

Return exactly the queries, nothing else.`,
  )

  // The requested count is a sentence in a prompt, and a prompt is a request.
  // Gemini rejects array-length constraints in a structured-output schema, so
  // nothing in the schema holds the model to it either — meaning the number a
  // caller typed, the number they are billed for, and the number the model felt
  // like writing were three independent quantities.
  //
  // Clamped here instead. Over the ask is truncated, because the caller set a
  // budget and a run that quietly spends 2.5x it has broken a promise. Under the
  // ask is kept and SAID: a short catalog is a real outcome worth seeing, and
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
    // that is knowable before the run — the model half depends on how much text
    // comes back.
    requested: target,
    written: planned.length,
    estimatedUsd: queries.length * 0.0015,
    budgetUsd: 0,
    uncapped: false,
  })

  // ── 3. fire everything ────────────────────────────────────────────────────
  say("sweep", `firing ${queries.length} queries`)
  const hits: Array<{ url: string; title: string; description: string; q: string; intent: string }> = []
  for (let i = 0; i < queries.length; i += CONC) {
    if (signal?.aborted) throw new Error("aborted")
    const batch = queries.slice(i, i + CONC)
    const res = await search.search(batch.map((b) => b.q))
    res.forEach((r, j) => {
      serpCalls += 1
      bill("serp", "sweep", r.usd, r.ms, r.ok)
      // One span per SERP call, carrying the QUERY TEXT — the only place a
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

      // The results themselves, not just the count. Everything downstream — the
      // hosts, the classifications, the map — is derived from these rows, and
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
    say("sweep", `  ${Math.min(i + CONC, queries.length)}/${queries.length} — ${hits.length} results so far`)
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

  say("rank", `classifying ${hostList.length} hosts in batches of ${BATCH}`)
  const entities: Entity[] = []
  for (let i = 0; i < hostList.length; i += BATCH) {
    if (signal?.aborted) throw new Error("aborted")
    const slice = hostList.slice(i, i + BATCH)
    const out = await call(
      "rank",
      `classify hosts ${i + 1}-${Math.min(i + BATCH, hostList.length)} of ${hostList.length}`,
      z.object({ entities: z.array(Entity) }),
      `Classify every one of these hosts. They came back from searches about this market:
  the anchor: ${anchor} — ${decomp.sells}
  its buyer:  ${decomp.buyer}

Everything here is SOME kind of player — classify, do not filter. A host that merely writes about
the market is a publisher; a host that lists vendors is a directory; a forum or subreddit is a
community; a research lab or a company consuming this is a buyer. Mark something noise only when it
is genuinely unrelated to this market.

One entry per host. \`seenIn\` is how many different queries surfaced it, and \`intents\` is what kinds
of question found it — use both as evidence, not as a verdict.

${slice.map((h) => `${h.host}  seenIn=${h.seenIn}  intents=${h.intents.join(",")}\n   ${h.titles.join(" | ")}\n   ${h.desc}`).join("\n\n")}`,
    )
    entities.push(...out.entities)
    say("rank", `  classified ${Math.min(i + BATCH, hostList.length)}/${hostList.length}`)

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
