import {
  HARVEST_HOST_CAP,
  canonicalUrl,
  isHtml,
  judgeHosts,
  registrableHost,
  sniff,
  type BreakerTable,
  type FetchPort,
  type HostCandidate,
  type Judged,
  type KernelStats,
  type Ledger,
  type SearchPort,
  type UnreadableReason,
} from "@open-kb/core"
import { RunEvidence, originKey } from "./run-evidence.js"
import { SLICE, linksOf, rememberTool, type EvidenceRef, type RememberCtx, type SearchTrace } from "./tools-free.js"
import type { MapState } from "./map.js"

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
  /**
   * A page this caller GAINED: the sniffer said `found`, at page tier, and the
   * run held neither that ADDRESS nor that READING until now. Fired at most
   * once per address per run and only on that path — a dead host, a 403, an
   * empty body dressed as success, a re-fetch, an alias of a page already
   * held, a redirect onto one, a second reading of an address the run has
   * already been to, and an error template echoing the path it was handed all
   * reach `settle()` and none of them calls this.
   *
   * It exists for the finish gate, which has to be able to tell "the lead
   * bought a page" from "the lead called the fetch tool". Wired per caller
   * rather than per run because the gate charges the LEAD (agent.ts hands the
   * lead its own claim and its own paid toolset); an investigator's ctx leaves
   * it unset, so an investigator's pages cannot pay the lead's debt.
   *
   * `evidence`, not `seen`: `seen` is the run's URL memory and searchTool puts
   * every SERP hit in it (the `if (!seen)` block inside `searchTool`'s per-hit
   * map), so a page the lead fetched off a search result would read as
   * "already had it" and the commonest honest answer to a refusal would count
   * for nothing. The store knows the difference between a URL the run has
   * heard of and a page the run holds.
   *
   * TWO QUESTIONS, because one URL is not one page and one page is not one
   * reading:
   *
   *   `hasAddress` — has the run been to this place? Registrable host plus
   *   decoded path; scheme, doubled slash, subdomain and query all fold. The
   *   old `hasPage` keyed on `canonicalUrl` instead, which is a spelling rule:
   *   measured on this tool, one fetch of `https://a.com/x` followed by `?a=1`,
   *   `http://a.com/x`, `//x`, `?a=2` and `?a=3` fired six gains for $0.0000.
   *
   *   `hasText` — has the run read this reading? Raw digest, so an alias and a
   *   redirect fold even across hosts; plus the same digest with the requested
   *   path masked out, so a soft 404 or a "did you mean" template that prints
   *   the address it was handed is one reading however many addresses it is
   *   asked at. The redirect case fires with nobody cheating: the direct branch
   *   of providers/src/brightdata.ts calls `f(url, {redirect: "follow"})` and
   *   returns the REQUESTED url (`res.url` is discarded; the unlocked branch
   *   echoes the request too), so a /pricing that redirects onto an
   *   already-read /plans arrives under a url the store has never seen.
   *
   * What neither closes is written on `hasText`.
   *
   * `chars` is the length of the EXTRACTED text — what the model actually
   * reads, the same string `hasText` digests, before the `SLICE` the return
   * value is cut to. It is not part of the judgement: a page is gained or it
   * is not, and 201 characters past core's THIN_TEXT floor is still a page.
   * It is carried so the gate's receipt can say WHICH page — the orchestrator
   * writes `page:<url>(<chars>c)`, and a reader can tell a market's pricing
   * table from the stub that squeaked past the floor without re-fetching
   * either.
   */
  onPageGained?: (url: string, chars: number) => void
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
  /** Present when the failure is about the PAGE — a landed body the sniffer
   *  refused, a transport that never answered, a fetch that threw — as the
   *  same stable code the sweep kernel counts by. Tool-level refusals
   *  (breaker-open, bad-url, refused, not-run) carry no code: no page was
   *  judged. For sniffed bodies `reason` already speaks the same name; this
   *  field is that name typed, so counting cannot drift from wording. */
  code?: UnreadableReason
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
    raw: { httpStatus: number; body: string; contentType?: string; usd: number; providerError?: string },
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
        code: "no-response",
        hint: "the request never got an answer — the network or the transport failed before any bytes arrived",
        handle: rec.handle,
      }
    }

    // Rebuilt field by field rather than passed through, so the provider's own
    // account of the response has to be listed here or it is silently dropped
    // one line before the sniffer could have used it.
    const s = sniff({
      url,
      httpStatus: raw.httpStatus,
      body: raw.body,
      contentType: raw.contentType,
      providerError: raw.providerError,
    })
    if (s.status !== "found") {
      const reason = s.reason
      if (STRIKES.has(reason)) ctx.breaker.strike(originKey(url), input.mode, reason)
      const rec = record(url, s.text, s.status, reason, landAs, raw.body)
      // A refusal the provider actually stated beats the guess this file writes
      // for the same code — `hintFor("empty-body")` has to describe every way a
      // host can answer with nothing, where the header names the one that
      // happened. Appended, not substituted: the hint carries the advice about
      // what to do next, which the header never does.
      const hint = s.detail ? `${s.detail} — ${hintFor(reason, input.mode)}` : hintFor(reason, input.mode)
      return { url, ok: false, status: raw.httpStatus, reason, code: reason, hint, handle: rec.handle }
    }

    // Asked BEFORE the record lands, because recording it is what makes both
    // answers false: this is the one moment the run can tell a page it just
    // gained from one it already held. Two questions, because one URL is not
    // one page — `hasAddress` asks about the place, `hasText` about the
    // reading. Neither alone is enough: an alias, a scheme flip or a redirect
    // reaches a place under a new spelling and only the reading folds it; a
    // host that changes its bytes on every read (a nonce, a timestamp, a 404
    // template with a clock in it) hands back a new reading every time and
    // only the place folds it.
    const gained = !ctx.evidence.hasAddress(url) && !ctx.evidence.hasText(s.text, url)
    const rec = record(url, s.text, "found", undefined, landAs, raw.body)
    ctx.seen.add(canonicalUrl(url))
    if (gained) ctx.onPageGained?.(url, s.text.length)
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
        return { url, ok: false, status: 0, reason: "fetch-failed", code: "fetch-failed", hint: `the fetch itself failed: ${msg}` }
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

// ── harvest ──────────────────────────────────────────────────────────────────

/** Hosts one harvest call carries — the kernel's own cap, one source of truth. */
export const MAX_HARVEST_HOSTS = HARVEST_HOST_CAP

/**
 * The classify contract a harvest needs: the same call shape judgeHosts
 * injects, plus the dollars the call cost so the tool can draw them against
 * the mission's claim as each host lands. The swarm builds this closure at
 * wiring time (agent.ts makeHarvestClassify) from the SAME doctrine file the
 * sweep renders — prompts/agents/classify.md via core's composePrompt — the
 * prompt is shared doctrine, not sweep code, and packages/swarm never imports
 * packages/sweep.
 */
export type HarvestClassify = (
  h: HostCandidate,
  pageText: string,
  opts?: { signal?: AbortSignal },
) => Promise<{
  out: { name: string; kind: string; what: string; relation: string; why: string; spans: string[] }
  usd: number
}>

export interface HarvestCtx {
  fetch: FetchPort
  evidence: RunEvidence
  ledger: Ledger
  /** The mission's claim: every fetch and every classify call draws on it AS
   *  IT LANDS — per host, never batched to the end — so a harvest that dies
   *  at host 12 of 40 has drawn 12 hosts' worth and the books stay honest. */
  claimId: string
  map: MapState
  seen: Set<string>
  /** Who these judgements are written as: the mission dedupeKey. */
  writer: string
  aggregatorThreshold?: number | null
  classify: HarvestClassify
  /** The run's search traces, when the caller has them: `seenIn` on each
   *  candidate is computed from how many distinct queries surfaced the host. */
  searches?: ReadonlyArray<SearchTrace>
  /** The kernel pool's width; the kernel's own default when unset. Tests pin
   *  it to 1 for deterministic mid-kill accounting. */
  concurrency?: number
  signal?: AbortSignal
  /** Observe the call's kernel stats, for the run-level harvest tally. */
  onStats?: (stats: KernelStats, hosts: number) => void
}

export interface HarvestInput {
  hosts: string[]
  why: string
}

export interface HarvestRow {
  host: string
  /** True when the host was judged AND landed on the map through remember. */
  ok: boolean
  kind?: string
  relation?: string
  settledBy?: "predicate" | "model"
  /** The judge's or the gate's refusal sentence, when the node wears one. */
  because?: string
  /** Why the host did NOT land: a refusal, the mint's sentence, or a verdict
   *  (noise, none) the map draws no node for. */
  reason?: string
}

export interface HarvestReturn {
  rows: HarvestRow[]
  /** The kernel's own accounting for this call; null when nothing was judged. */
  stats: KernelStats | null
  landed: { nodes: number; merged: number }
  spentUsd: number
  poolLeftUsd: number
}

/**
 * The judge kernel's vocabulary folded into the map's. The swarm map has no
 * publisher/directory/unknown KIND — a publisher is a firm whose relation
 * (`covers`) says the rest, a directory-shaped claim is re-derived by the
 * admit gate itself (which CAN install kind "directory" — the gate writes
 * what a writer may not claim), and an unreadable host lands company-shaped
 * with relation `unknown` plus the reason code carrying the refusal.
 */
export const SWARM_KIND_OF: Record<string, string> = {
  company: "company",
  product: "product",
  community: "community",
  publisher: "company",
  directory: "company",
  unknown: "company",
}

/** Mechanical quote length when no verified span exists: enough to prove the
 *  bytes were read, short enough to stay a receipt. */
const MECHANICAL_QUOTE = 160

/** A model may hand hostnames wearing schemes, paths or www — normalize to
 *  the bare host the kernel fetches. Null when nothing host-shaped remains. */
function cleanHost(raw: string): string | null {
  let s = raw.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^https?:\/\//, "").split("/")[0]!.split("?")[0]!.split("#")[0]!
  s = s.replace(/^www\./, "")
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s)) return null
  return s
}

/**
 * Buy one bulk judgement: up to MAX_HARVEST_HOSTS hosts, each fetched from
 * its own front page by the kernel's judgeHosts — predicates settle the
 * unreadable and aggregator-shaped ones by arithmetic for $0, one model call
 * judges each residue host — and EVERY judged host lands on the map through
 * rememberTool's mint+admit seam. No side door into MapState: the quotes are
 * proven against bytes this tool just recorded, the admit gate re-derives
 * downgrades, and the writer stamp is the mission's own.
 *
 * The load-bearing integration is the port wrapper: core's judgeHosts takes a
 * bare FetchPort and records nothing, so this tool wraps the mission's port
 * with one that (a) draws each fetch's real dollars on the claim the moment
 * they are known and (b) records every response into RunEvidence BEFORE the
 * verdict — remember cites by URL, and a cite can only succeed against bytes
 * already in the store.
 *
 * Settlement is per host by construction: fetch dollars draw at the wrapper,
 * classify dollars draw as each call returns, and the moment the claim runs
 * dry the pool is aborted — hosts already judged stand, the rest come back as
 * rows saying so. `spendable()` never lies mid-harvest: the mission's whole
 * allowance was held at spawn, and the settle-at-actuals path returns what
 * the dead or thrifty harvest did not spend.
 */
export async function harvestTool(ctx: HarvestCtx, input: HarvestInput): Promise<HarvestReturn> {
  const done = (rows: HarvestRow[], stats: KernelStats | null, landed: { nodes: number; merged: number }, spentUsd: number): HarvestReturn => ({
    rows,
    stats,
    landed,
    spentUsd,
    poolLeftUsd: ctx.ledger.spendable(),
  })
  const refuseAll = (reason: string) =>
    done(input.hosts.map((host) => ({ host, ok: false, reason })), null, { nodes: 0, merged: 0 }, 0)

  if (input.hosts.length === 0) return done([], null, { nodes: 0, merged: 0 }, 0)
  if (ctx.signal?.aborted) return refuseAll("the run was cancelled; nothing was judged")
  const room = claimRoom(ctx.ledger, ctx.claimId)
  if (!room.ok) return refuseAll(room.reason)

  // ── the roster: normalize, refuse the anchor and duplicates, cap at 40 ────
  const rows: HarvestRow[] = []
  const candidates: HostCandidate[] = []
  const inCall = new Set<string>()
  const seenInOf = (host: string): number => {
    let n = 0
    for (const s of ctx.searches ?? []) {
      if (s.urls.some((u) => originKey(u) === registrableHost(host))) n += 1
    }
    return n
  }
  for (const raw of input.hosts) {
    const host = cleanHost(raw)
    if (!host) {
      rows.push({ host: raw, ok: false, reason: `"${raw}" is not a hostname this tool can judge` })
      continue
    }
    if (registrableHost(host) === ctx.map.anchor) {
      rows.push({ host, ok: false, reason: "that is the anchor — the map exists to explain it; it is already here" })
      continue
    }
    if (inCall.has(host)) {
      rows.push({ host, ok: false, reason: "already in this call; one judgement per host" })
      continue
    }
    if (candidates.length >= MAX_HARVEST_HOSTS) {
      rows.push({ host, ok: false, reason: `only ${MAX_HARVEST_HOSTS} hosts fit in one harvest; call harvest again with this one` })
      continue
    }
    inCall.add(host)
    candidates.push({ host, seenIn: seenInOf(host), intents: [], titles: [], desc: "" })
  }
  if (candidates.length === 0) return done(rows, null, { nodes: 0, merged: 0 }, 0)

  // ── the port wrapper: draw at the wire, record before the verdict ─────────
  let spentUsd = 0
  const draw = (usd: number) => {
    if (usd <= 0) return
    ctx.ledger.draw(ctx.claimId, usd)
    spentUsd += usd
  }
  const pageTextOf = new Map<string, string>()
  const recordingFetch: FetchPort = {
    get: async (url, mode, o) => {
      const raw = await ctx.fetch.get(url, mode, o)
      draw(raw.usd)
      const s = sniff(raw)
      if (s.status === "found") {
        ctx.evidence.record({ url, text: s.text, raw: raw.body, status: "found", tier: "page" })
        ctx.seen.add(canonicalUrl(url))
        try {
          pageTextOf.set(new URL(url).hostname, s.text)
        } catch {
          /* the kernel only fetches urls it built; unreachable */
        }
      } else {
        ctx.evidence.record({ url, text: s.text, status: s.status, reason: s.reason, tier: "page" })
      }
      return raw
    },
  }

  // ── per-host landing, synchronous in the kernel's own stream ──────────────
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (ctx.signal) {
    if (ctx.signal.aborted) controller.abort()
    else ctx.signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  let ranDry = false

  const remCtx: RememberCtx = {
    map: ctx.map,
    evidence: ctx.evidence,
    ledger: ctx.ledger,
    aggregatorThreshold: ctx.aggregatorThreshold,
    writer: ctx.writer,
  }
  const landed = { nodes: 0, merged: 0 }
  /** Hosts a verdict actually reached — the roster's refusal rows share the
   *  rows array, so membership there cannot stand in for "was judged". */
  const judgedHosts = new Set<string>()

  const landOne = (e: Judged) => {
    judgedHosts.add(e.domain)
    const row: HarvestRow = {
      host: e.domain,
      ok: false,
      kind: e.kind,
      relation: e.relation,
      settledBy: e.settledBy,
      ...(e.because ? { because: e.because } : {}),
    }
    rows.push(row)
    if (e.kind === "noise") {
      row.reason = "judged noise — genuinely unrelated to this market; noise leaves the map"
      return
    }
    if (e.relation === "none") {
      row.reason = "judged none — no relation to the anchor; the map draws no node for it"
      return
    }

    // Evidence, strongest first: the verified spans ARE the receipts; a page
    // with no surviving span still proves it was read (a mechanical opening
    // quote of its stored text); an unreadable host can only cite the search
    // snippet that surfaced it. A host the run holds no bytes for cannot land
    // — that is the mint's rule, and the row says so.
    const url = `https://${e.domain}/`
    let refs: EvidenceRef[] = []
    if (e.spans?.length) {
      refs = e.spans.map((quote) => ({ url, quote }))
    } else {
      const page = pageTextOf.get(e.domain)
      if (page) refs = [{ url, quote: page.slice(0, MECHANICAL_QUOTE) }]
      else {
        const snip = ctx.evidence.snippetFor(registrableHost(e.domain))
        if (snip) refs = [{ url: snip.url, quote: snip.text.slice(0, MECHANICAL_QUOTE) }]
      }
    }

    const out = rememberTool(remCtx, {
      nodes: [
        {
          name: e.name || e.domain,
          domain: e.domain,
          kind: SWARM_KIND_OF[e.kind] ?? "company",
          what: e.what,
          relation: e.relation,
          why: e.why,
          evidence: refs,
          settledBy: e.settledBy,
          ...(e.because ? { because: e.because } : {}),
          ...(e.unreadableReason ? { unreadableReason: e.unreadableReason } : {}),
        },
      ],
      why: input.why,
    })
    if (out.rejected.length > 0) {
      row.reason = out.rejected[0]!.reason
      return
    }
    row.ok = true
    if (out.downgraded.length > 0) row.because = out.downgraded[0]!.because
    landed.nodes += out.added.nodes
    landed.merged += out.merged.nodes

    // Per-host settlement honesty: the instant the claim runs dry, stop the
    // pool. Everything already judged stands; the unjudged rest is reported.
    const r = ctx.ledger.draw(ctx.claimId, 0)
    if (r.ok && r.remainingUsd <= EPSILON && !ranDry) {
      ranDry = true
      controller.abort()
    }
  }

  // ── run the kernel; an abort mid-pool is a partial harvest, never a throw ─
  let stats: KernelStats | null = null
  let failure: string | null = null
  try {
    const out = await judgeHosts(candidates, {
      fetcher: recordingFetch,
      classify: async (h, pageText) => {
        const { out: judged, usd } = await ctx.classify(h, pageText, { signal: controller.signal })
        draw(usd)
        return judged
      },
      anchor: ctx.map.anchor,
      aggregatorThreshold: ctx.aggregatorThreshold ?? null,
      concurrency: ctx.concurrency,
      signal: controller.signal,
      onJudged: landOne,
    })
    stats = out.stats
  } catch (err) {
    // The kernel only throws on abort (its own contract); anything else is
    // still a sentence to the model, never a stack — the tool does not throw.
    if (!controller.signal.aborted) {
      failure = `the harvest itself failed (${err instanceof Error ? err.message : String(err)})`
    }
  } finally {
    ctx.signal?.removeEventListener("abort", onOuterAbort)
  }

  // Hosts the abort (or a failure) left unjudged get their own sentence — a
  // dead harvest's report still accounts for every host it was handed.
  for (const c of candidates) {
    if (judgedHosts.has(c.host)) continue
    rows.push({
      host: c.host,
      ok: false,
      reason:
        failure ??
        (ranDry
          ? "the allowance ran dry mid-harvest; this host was not judged — everything already judged stands"
          : "the run was cancelled mid-harvest; this host was not judged — everything already judged stands"),
    })
  }

  if (stats) ctx.onStats?.(stats, candidates.length)
  return done(rows, stats, landed, spentUsd)
}
