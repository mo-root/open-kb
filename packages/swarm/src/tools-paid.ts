import {
  canonicalUrl,
  isHtml,
  sniff,
  type BreakerTable,
  type FetchPort,
  type Ledger,
  type SearchPort,
} from "@open-kb/core"
import { RunEvidence, originKey } from "./run-evidence.js"
import { SLICE, linksOf, type SearchTrace } from "./tools-free.js"

/**
 * The two paid tools: search and fetch. Both spend real money through ports,
 * both draw against the mission's claim, and both put `{spentUsd, poolLeftUsd}`
 * on every return so the price of the run is on every turn.
 *
 * A tool never throws at a model. Every failure — a query the engine refused,
 * a host that answers success with an empty page, a breaker already open, an
 * allowance already spent — comes back as data with a reason and a hint
 * written as a sentence to a reader. The reason names for sniffed bodies are
 * the sniffer's own (`empty-body`, `thin-render`, `soft-404`), because those
 * are the names the skill teaches.
 */

/** Queries one search call carries. More than this is another call. */
export const MAX_QUERIES = 8

/** URLs one fetch call carries. */
export const MAX_URLS = 6

/** Past this, a fetch answers `{status:"pending", handle}` and keeps filling
 *  the store — the caller is never stuck behind one slow host. */
export const PENDING_AFTER_MS = 3_000

/** Links a fetch doc carries back. The full set is always in the store via
 *  `read(handle, project:"links")` for free. */
const MAX_LINKS = 80

const EPSILON = 1e-9

export interface PaidCtx {
  search: SearchPort
  fetch: FetchPort
  evidence: RunEvidence
  ledger: Ledger
  /** The mission's claim: every dollar spent here is drawn against it. */
  claimId: string
  breaker: BreakerTable
  /** Canonical URLs this run has already seen, shared across every lane. */
  seen: Set<string>
  /** When given, every query lands here as a trace — `recall({op:"barren"})` reads it. */
  searches?: SearchTrace[]
  signal?: AbortSignal
  pendingAfterMs?: number
  /** Observe the landing of a fetch that went pending, for drains and tests.
   *  The landing happens with or without an observer. */
  trackPending?: (landing: Promise<void>) => void
}

// ── search ───────────────────────────────────────────────────────────────────

export interface SearchInput {
  queries: string[]
  why: string
  /** The mission tier this spend belongs to, echoed for the trace. Depth is the port's decision. */
  tier?: string
}

export interface SearchItem {
  url: string
  title: string
  snippet: string
  /** Had this run already seen the URL before this call answered? */
  seen: boolean
  /** Snippet-tier evidence handle: quoting the title or snippet is a real citation. */
  handle: string
}

export type SearchRow =
  | { query: string; items: SearchItem[] }
  | { query: string; reason: string }

export interface SearchReturn {
  results: SearchRow[]
  /** URLs this run had never seen before this call. */
  newUrls: string[]
  spentUsd: number
  poolLeftUsd: number
}

/** What is left on the claim, or the sentence that says why nothing is. */
function claimRoom(ledger: Ledger, claimId: string): { ok: true; remainingUsd: number } | { ok: false; reason: string } {
  const r = ledger.draw(claimId, 0)
  if (!r.ok) return { ok: false, reason: r.reason }
  if (r.remainingUsd <= EPSILON) {
    return { ok: false, reason: "allowance spent — write down what you have; the free tools still answer" }
  }
  return { ok: true, remainingUsd: r.remainingUsd }
}

/**
 * Buy searches. The queries go to the engine exactly as written — this tool
 * never rewrites a query, because the model's phrasing IS the experiment.
 * Every hit is recorded as snippet-tier evidence and carries its handle.
 */
export async function searchTool(ctx: PaidCtx, input: SearchInput): Promise<SearchReturn> {
  const done = (results: SearchRow[], newUrls: string[], spentUsd: number): SearchReturn => ({
    results,
    newUrls,
    spentUsd,
    poolLeftUsd: ctx.ledger.spendable(),
  })

  if (input.queries.length === 0) return done([], [], 0)

  const refuseAll = (reason: string) => done(input.queries.map((query) => ({ query, reason })), [], 0)

  if (ctx.signal?.aborted) return refuseAll("the run was cancelled; nothing was searched")
  const room = claimRoom(ctx.ledger, ctx.claimId)
  if (!room.ok) return refuseAll(room.reason)

  const ran = input.queries.slice(0, MAX_QUERIES)
  const overflow: SearchRow[] = input.queries.slice(MAX_QUERIES).map((query) => ({
    query,
    reason: `only ${MAX_QUERIES} queries fit in one call; this one was not run — call search again with it`,
  }))

  let results
  try {
    results = await ctx.search.search(ran)
  } catch (e) {
    const reason = `the search engine itself failed: ${e instanceof Error ? e.message : String(e)}`
    return done([...ran.map((query) => ({ query, reason })), ...overflow], [], 0)
  }

  const rows: SearchRow[] = []
  const newUrls: string[] = []
  let spentUsd = 0
  for (const r of results) {
    spentUsd += r.usd
    ctx.searches?.push({ query: r.query, ok: r.ok, urls: r.hits.map((h) => h.url) })
    if (!r.ok) {
      rows.push({ query: r.query, reason: r.error ?? "the engine refused this query and gave no reason" })
      continue
    }
    const items: SearchItem[] = r.hits.map((h) => {
      const canonical = canonicalUrl(h.url)
      const seen = ctx.seen.has(canonical)
      if (!seen) {
        ctx.seen.add(canonical)
        newUrls.push(h.url)
      }
      const rec = ctx.evidence.record({
        url: h.url,
        text: `${h.title}\n${h.description}`,
        status: "found",
        tier: "snippet",
      })
      return { url: h.url, title: h.title, snippet: h.description, seen, handle: rec.handle }
    })
    rows.push({ query: r.query, items })
  }

  if (spentUsd > 0) ctx.ledger.draw(ctx.claimId, spentUsd)
  return done([...rows, ...overflow], newUrls, spentUsd)
}

// ── fetch ────────────────────────────────────────────────────────────────────

/** The tool's mode words. `unlock` is the paid tier; the port spells it `unlocked`. */
export type SwarmFetchMode = "direct" | "unlock"

export interface FetchInput {
  urls: string[]
  mode: SwarmFetchMode
  why: string
}

export interface FetchDocOk {
  url: string
  ok: true
  status: number
  kind: "html" | "text"
  /** Bytes stored — the full body, up to the cap. */
  bytes: number
  /** Characters of text in this return. The rest reads for free by handle. */
  returnedBytes: number
  truncated: boolean
  text: string
  handle: string
  links: Array<{ href: string; text: string }>
}

export interface FetchDocFail {
  url: string
  ok: false
  status: number
  reason: string
  hint: string
  /** Present when a body was recorded despite the verdict, so `read` can explain it. */
  handle?: string
}

export interface FetchDocPending {
  url: string
  status: "pending"
  handle: string
}

export type FetchDoc = FetchDocOk | FetchDocFail | FetchDocPending

export interface FetchReturn {
  docs: FetchDoc[]
  spentUsd: number
  poolLeftUsd: number
}

/** Verdicts that strike the breaker: the host answered, and what it said was a lie. */
const STRIKES = new Set(["empty-body", "thin-render", "soft-404"])

function hintFor(reason: string, mode: SwarmFetchMode): string {
  if (reason === "empty-body") {
    return `this host answers the ${mode} tier with an empty page dressed as success; its own published summary or the search snippets may be the only route in`
  }
  if (reason === "thin-render") {
    return (
      "under 200 characters of readable text came back — the page is assembled in the browser" +
      (mode === "direct" ? "; the unlock tier may see the finished page, at its price" : "")
    )
  }
  if (reason === "soft-404") {
    return "a text url answered with an HTML page — the file is not there, however healthy the response looks"
  }
  if (reason === "server-error") {
    return "the server itself failed; that is not a block — maybe a bad minute, maybe a dead host"
  }
  const m = /^http-(\d+)$/.exec(reason)
  if (m) return `the server answered ${m[1]}; the page is not at this address`
  return "nothing usable came back"
}

/**
 * Buy pages. The sniffer decides what actually happened, ignoring the status
 * line, and its verdict names are what come back. Two watched failures on one
 * {host, mode} open a breaker and further calls are refused in ~0ms, in words.
 * A fetch past the deadline answers `{status:"pending", handle}` and keeps
 * filling the store — read the handle later, for free.
 */
export async function fetchTool(ctx: PaidCtx, input: FetchInput): Promise<FetchReturn> {
  let spentUsd = 0
  const deadline = ctx.pendingAfterMs ?? PENDING_AFTER_MS

  const room = claimRoom(ctx.ledger, ctx.claimId)
  const refusal: string | null = ctx.signal?.aborted
    ? "the run was cancelled; nothing was fetched"
    : room.ok
      ? null
      : room.reason

  /** Judge a landed response and put it in the store; shared by the in-time
   *  and the late path — the only difference is which handle the bytes get. */
  const settle = (
    url: string,
    raw: { httpStatus: number; body: string; contentType?: string; usd: number },
    landAs?: string,
  ): FetchDoc => {
    spentUsd += raw.usd
    if (raw.usd > 0) ctx.ledger.draw(ctx.claimId, raw.usd)

    if (raw.httpStatus === 0) {
      const rec = record(url, "", "blocked", "no-response", landAs)
      return {
        url,
        ok: false,
        status: 0,
        reason: "no-response",
        hint: "the request never got an answer — the network or the transport failed before any bytes arrived",
        handle: rec.handle,
      }
    }

    const s = sniff({ url, httpStatus: raw.httpStatus, body: raw.body, contentType: raw.contentType })
    if (s.status !== "found") {
      const reason = s.reason ?? s.status
      if (STRIKES.has(reason)) ctx.breaker.strike(originKey(url), input.mode, reason)
      const rec = record(url, s.text, s.status, reason, landAs, raw.body)
      return { url, ok: false, status: raw.httpStatus, reason, hint: hintFor(reason, input.mode), handle: rec.handle }
    }

    const rec = record(url, s.text, "found", undefined, landAs, raw.body)
    ctx.seen.add(canonicalUrl(url))
    const html = isHtml(raw.body, raw.contentType)
    return {
      url,
      ok: true,
      status: raw.httpStatus,
      kind: html ? "html" : "text",
      bytes: raw.body.length,
      returnedBytes: Math.min(s.text.length, SLICE),
      truncated: s.text.length > SLICE,
      text: s.text.slice(0, SLICE),
      handle: rec.handle,
      links: html ? linksOf(raw.body, url).slice(0, MAX_LINKS) : [],
    }
  }

  const record = (
    url: string,
    text: string,
    status: "found" | "not_found" | "blocked",
    reason: string | undefined,
    landAs: string | undefined,
    rawBody?: string,
  ) => {
    const entry = { url, text, raw: rawBody, status, reason, tier: "page" as const }
    return landAs === undefined ? ctx.evidence.record(entry) : ctx.evidence.land(landAs, entry)
  }

  const one = async (url: string): Promise<FetchDoc> => {
    if (refusal) return { url, ok: false, status: 0, reason: "refused", hint: refusal }

    let host: string
    try {
      host = originKey(url)
      if (!host) throw new Error("no host")
    } catch {
      return { url, ok: false, status: 0, reason: "bad-url", hint: `"${url}" is not a url this tool can open` }
    }

    // The breaker answers before any money moves — a pair this run has watched
    // fail twice is refused for the rest of the run, in ~0ms, in words.
    const open = ctx.breaker.open(host, input.mode)
    if (open.open) {
      return { url, ok: false, status: 0, reason: "breaker-open", hint: open.because }
    }

    const attempt = ctx.fetch.get(url, input.mode === "unlock" ? "unlocked" : "direct", { signal: ctx.signal }).then(
      (raw) => ({ raw }) as const,
      (err: unknown) => ({ err }) as const,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = await Promise.race([
      attempt,
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), deadline)
      }),
    ])
    clearTimeout(timer)

    if (late !== "deadline") {
      if ("err" in late) {
        const msg = late.err instanceof Error ? late.err.message : String(late.err)
        return { url, ok: false, status: 0, reason: "fetch-failed", hint: `the fetch itself failed: ${msg}` }
      }
      return settle(url, late.raw)
    }

    // Past the deadline: the caller gets a handle now; the promise keeps
    // filling the store, and the late bytes still draw their real cost.
    const handle = ctx.evidence.pending(url)
    const landing = attempt.then((outcome) => {
      if ("err" in outcome) {
        const msg = outcome.err instanceof Error ? outcome.err.message : String(outcome.err)
        ctx.evidence.land(handle, { url, text: "", status: "blocked", reason: `fetch-failed: ${msg}`, tier: "page" })
        return
      }
      settle(url, outcome.raw, handle)
    })
    ctx.trackPending?.(landing)
    return { url, status: "pending", handle }
  }

  const ran = input.urls.slice(0, MAX_URLS)
  const overflow: FetchDoc[] = input.urls.slice(MAX_URLS).map((url) => ({
    url,
    ok: false,
    status: 0,
    reason: "not-run",
    hint: `only ${MAX_URLS} urls fit in one fetch call; call fetch again with this one`,
  }))

  const docs = await Promise.all(ran.map(one))
  return { docs: [...docs, ...overflow], spentUsd, poolLeftUsd: ctx.ledger.spendable() }
}
