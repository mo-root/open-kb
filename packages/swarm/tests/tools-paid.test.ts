import { describe, it, expect } from "vitest"
import { BreakerTable, Ledger, ALLOWANCES, type FetchPort, type SearchPort } from "@open-kb/core"
import {
  RunEvidence,
  searchTool,
  fetchTool,
  readTool,
  MAX_QUERIES,
  SLICE,
  type PaidCtx,
  type SearchTrace,
  type FetchDocOk,
  type FetchDocFail,
  type FetchDocPending,
} from "../src/index.js"

// ── fakes, in the sweep tests' idiom ────────────────────────────────────────

// Padded past core's THIN_TEXT floor (200 extracted chars — see
// packages/core/src/sniff.ts) so sniff() calls these `found`.
const vendorHtml =
  `<html><body><h1>Acme Scraper</h1><p>We sell a scraping API to developers. Our platform helps ` +
  `engineering teams collect structured web data at scale, handling proxies, browser rendering, retries, ` +
  `and anti-bot challenges automatically so a small team can run large crawls without infrastructure.</p>` +
  `<a href="/pricing">Pricing</a><a href="https://docs.acme.com/">Docs</a></body></html>`

function fakeSearch(rows: Record<string, Array<{ url: string; title: string; description: string }>>): SearchPort {
  return {
    async search(queries) {
      return queries.map((query) => {
        const hits = rows[query]
        if (!hits) return { query, hits: [], ok: false, error: "the engine timed out on this query", usd: 0.001, ms: 5 }
        return { query, hits, ok: true, usd: 0.003, ms: 5 }
      })
    },
  }
}

// core's RawResponse carries `httpStatus`, not `status`.
function fakeFetcher(pages: Record<string, string>, opts: { delayMs?: number; usd?: number } = {}): FetchPort {
  return {
    async get(url) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const body = pages[url]
      if (body === undefined) return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: opts.usd ?? 0 }
      return { url, httpStatus: 200, body, contentType: "text/html", ms: 1, usd: opts.usd ?? 0 }
    },
  }
}

function paidCtx(over: Partial<PaidCtx> = {}): { ctx: PaidCtx; ledger: Ledger; claimId: string } {
  const ledger = new Ledger(1.5)
  const r = ledger.reserve(ALLOWANCES.read)
  if (!r.ok) throw new Error("reserve failed in fixture")
  const ctx: PaidCtx = {
    search: fakeSearch({}),
    fetch: fakeFetcher({}),
    evidence: new RunEvidence(),
    ledger,
    claimId: r.claimId,
    breaker: new BreakerTable(),
    seen: new Set(),
    ...over,
  }
  return { ctx, ledger, claimId: r.claimId }
}

// ── search ───────────────────────────────────────────────────────────────────

describe("searchTool", () => {
  const HITS = {
    "residential proxy pools": [
      { url: "https://rival.com/", title: "Rival — proxies", description: "Rotating residential pools for scraping" },
      { url: "https://blog.third.com/roundup", title: "Best proxy tools", description: "We compare five vendors" },
    ],
  }

  it("answers items with handles, a seen flag, and the run's new urls", async () => {
    const { ctx } = paidCtx({ search: fakeSearch(HITS) })
    const r = await searchTool(ctx, { queries: ["residential proxy pools"], why: "find the market's words" })
    const row = r.results[0]!
    if (!("items" in row)) throw new Error("expected items")
    expect(row.items).toHaveLength(2)
    expect(row.items[0]).toMatchObject({ url: "https://rival.com/", seen: false })
    expect(row.items[0]!.handle).toMatch(/^ev/)
    expect(r.newUrls).toEqual(["https://rival.com/", "https://blog.third.com/roundup"])
    expect(r.spentUsd).toBeCloseTo(0.003)
    expect(r.poolLeftUsd).toBeCloseTo(1.35 - ALLOWANCES.read)
    // The snippet is real evidence: the handle cites at the snippet tier.
    const cite = ctx.evidence.cite("https://rival.com/", "Rotating residential pools")
    expect(cite.ok).toBe(true)
    if (cite.ok) expect(cite.evidence.tier).toBe("snippet")
  })

  it("a failed query is a row beside the successes, never a throw", async () => {
    const { ctx } = paidCtx({ search: fakeSearch(HITS) })
    const r = await searchTool(ctx, { queries: ["residential proxy pools", "unknown words"], why: "t" })
    expect(r.results[1]).toMatchObject({ query: "unknown words", reason: "the engine timed out on this query" })
    expect("items" in r.results[0]!).toBe(true)
    // The failed query still cost what the engine charged.
    expect(r.spentUsd).toBeCloseTo(0.004)
  })

  it("passes the model's queries through exactly as written", async () => {
    let got: string[] = []
    const port: SearchPort = {
      async search(queries) {
        got = [...queries]
        return queries.map((query) => ({ query, hits: [], ok: true, usd: 0, ms: 1 }))
      },
    }
    const { ctx } = paidCtx({ search: port })
    await searchTool(ctx, { queries: ['  "appointment delivery" oversized freight  '], why: "t" })
    expect(got).toEqual(['  "appointment delivery" oversized freight  '])
  })

  it("a url seen before comes back flagged and stays out of newUrls", async () => {
    const { ctx } = paidCtx({ search: fakeSearch(HITS) })
    await searchTool(ctx, { queries: ["residential proxy pools"], why: "t" })
    const again = await searchTool(ctx, { queries: ["residential proxy pools"], why: "t" })
    const row = again.results[0]!
    if (!("items" in row)) throw new Error("expected items")
    expect(row.items.every((i) => i.seen)).toBe(true)
    expect(again.newUrls).toEqual([])
  })

  it("query nine is a not-run row; only eight reach the engine", async () => {
    let received = 0
    const port: SearchPort = {
      async search(queries) {
        received = queries.length
        return queries.map((query) => ({ query, hits: [], ok: true, usd: 0, ms: 1 }))
      },
    }
    const { ctx } = paidCtx({ search: port })
    const nine = Array.from({ length: 9 }, (_, i) => `query ${i}`)
    const r = await searchTool(ctx, { queries: nine, why: "t" })
    expect(received).toBe(MAX_QUERIES)
    expect(r.results[8]).toMatchObject({ query: "query 8" })
    const last = r.results[8]!
    if (!("reason" in last)) throw new Error("expected a reason row")
    expect(last.reason).toContain("only 8 queries fit in one call")
  })

  it("a port that throws costs a sentence per query, not the run", async () => {
    const port: SearchPort = {
      async search() {
        throw new Error("socket hang up")
      },
    }
    const { ctx } = paidCtx({ search: port })
    const r = await searchTool(ctx, { queries: ["a", "b"], why: "t" })
    expect(r.results).toHaveLength(2)
    for (const row of r.results) {
      if (!("reason" in row)) throw new Error("expected reason rows")
      expect(row.reason).toContain("socket hang up")
    }
    expect(r.spentUsd).toBe(0)
  })

  it("a spent allowance closes the paid tools with the skill's sentence", async () => {
    let called = false
    const port: SearchPort = {
      async search(queries) {
        called = true
        return queries.map((query) => ({ query, hits: [], ok: true, usd: 0, ms: 1 }))
      },
    }
    const { ctx, ledger, claimId } = paidCtx({ search: port })
    ledger.draw(claimId, ALLOWANCES.read) // the mission has spent its whole allowance
    const r = await searchTool(ctx, { queries: ["anything"], why: "t" })
    expect(called).toBe(false)
    const row = r.results[0]!
    if (!("reason" in row)) throw new Error("expected a reason row")
    expect(row.reason).toContain("allowance spent — write down what you have")
  })

  it("draws the spend against the mission's claim and appends the trace", async () => {
    const searches: SearchTrace[] = []
    const { ctx, ledger, claimId } = paidCtx({ search: fakeSearch(HITS), searches })
    await searchTool(ctx, { queries: ["residential proxy pools", "unknown words"], why: "t" })
    const room = ledger.draw(claimId, 0)
    if (!room.ok) throw new Error(room.reason)
    expect(room.remainingUsd).toBeCloseTo(ALLOWANCES.read - 0.004)
    expect(searches).toHaveLength(2)
    expect(searches[0]).toMatchObject({ query: "residential proxy pools", ok: true })
    expect(searches[0]!.urls).toContain("https://rival.com/")
    expect(searches[1]).toMatchObject({ query: "unknown words", ok: false, urls: [] })
  })
})

// ── fetch ────────────────────────────────────────────────────────────────────

describe("fetchTool", () => {
  it("a readable page answers text, links, a handle, and honest sizes", async () => {
    const { ctx } = paidCtx({ fetch: fakeFetcher({ "https://acme.com/": vendorHtml }, { usd: 0.002 }) })
    const r = await fetchTool(ctx, { urls: ["https://acme.com/"], mode: "direct", why: "read the rival" })
    const doc = r.docs[0] as FetchDocOk
    expect(doc.ok).toBe(true)
    expect(doc.kind).toBe("html")
    expect(doc.bytes).toBe(vendorHtml.length)
    expect(doc.truncated).toBe(false)
    expect(doc.text).toContain("scraping API to developers")
    expect(doc.links).toContainEqual({ href: "https://acme.com/pricing", text: "Pricing" })
    expect(doc.links).toContainEqual({ href: "https://docs.acme.com/", text: "Docs" })
    expect(r.spentUsd).toBeCloseTo(0.002)
    expect(r.poolLeftUsd).toBeCloseTo(1.35 - ALLOWANCES.read)
    // The full body is in the store: free re-reads project it.
    const read = readTool({ evidence: ctx.evidence, ledger: ctx.ledger }, { handle: doc.handle, project: "raw" })
    if (!read.ok) throw new Error(read.reason)
    expect(read.totalChars).toBe(vendorHtml.length)
  })

  it("an oversized page truncates at the slice and says so", async () => {
    const big = `<html><body><p>${"real words ".repeat(2_000)}</p></body></html>`
    const { ctx } = paidCtx({ fetch: fakeFetcher({ "https://big.com/": big }) })
    const r = await fetchTool(ctx, { urls: ["https://big.com/"], mode: "direct", why: "t" })
    const doc = r.docs[0] as FetchDocOk
    expect(doc.truncated).toBe(true)
    expect(doc.text.length).toBe(SLICE)
    expect(doc.returnedBytes).toBe(SLICE)
  })

  it("an empty 200 comes back as the sniffer's own empty-body, with the route-in hint", async () => {
    const { ctx } = paidCtx({ fetch: fakeFetcher({}) })
    const r = await fetchTool(ctx, { urls: ["https://stripe.com/"], mode: "unlock", why: "t" })
    const doc = r.docs[0] as FetchDocFail
    expect(doc).toMatchObject({ ok: false, status: 200, reason: "empty-body" })
    expect(doc.hint).toContain("answers the unlock tier with an empty page")
  })

  it("a text url answering html is a soft-404; thin text is a thin-render", async () => {
    const { ctx } = paidCtx({
      fetch: fakeFetcher({
        "https://a.com/llms.txt": vendorHtml,
        "https://b.com/": "<html><body><p>tiny</p></body></html>",
      }),
    })
    const r = await fetchTool(ctx, { urls: ["https://a.com/llms.txt", "https://b.com/"], mode: "direct", why: "t" })
    expect(r.docs[0]).toMatchObject({ ok: false, reason: "soft-404" })
    expect(r.docs[1]).toMatchObject({ ok: false, reason: "thin-render" })
  })

  it("two strikes open the breaker; the third call is refused before the port, in words", async () => {
    let portCalls = 0
    const counting: FetchPort = {
      async get(url) {
        portCalls++
        return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: counting })
    await fetchTool(ctx, { urls: ["https://stripe.com/"], mode: "unlock", why: "t" })
    await fetchTool(ctx, { urls: ["https://stripe.com/pricing"], mode: "unlock", why: "t" })
    expect(portCalls).toBe(2)
    const r = await fetchTool(ctx, { urls: ["https://stripe.com/docs"], mode: "unlock", why: "t" })
    expect(portCalls).toBe(2)
    const doc = r.docs[0] as FetchDocFail
    expect(doc.reason).toBe("breaker-open")
    expect(doc.hint).toBe("stripe.com refuses the unlock tier this run: two empty-body responses")
  })

  it("opening one mode never closes the other — the measured asymmetry", async () => {
    const pages: Record<string, string> = { "https://stripe.com/direct": vendorHtml }
    const port: FetchPort = {
      async get(url, mode) {
        if (mode === "unlocked") return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
        return { url, httpStatus: 200, body: pages["https://stripe.com/direct"]!, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: port })
    await fetchTool(ctx, { urls: ["https://stripe.com/a"], mode: "unlock", why: "t" })
    await fetchTool(ctx, { urls: ["https://stripe.com/b"], mode: "unlock", why: "t" })
    expect(ctx.breaker.open("stripe.com", "unlock").open).toBe(true)
    const direct = await fetchTool(ctx, { urls: ["https://stripe.com/direct"], mode: "direct", why: "t" })
    expect(direct.docs[0]).toMatchObject({ ok: true })
  })

  it("the tool's unlock maps to the port's unlocked", async () => {
    let seen = ""
    const port: FetchPort = {
      async get(url, mode) {
        seen = mode
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: port })
    await fetchTool(ctx, { urls: ["https://a.com/"], mode: "unlock", why: "t" })
    expect(seen).toBe("unlocked")
  })

  it("an http error keeps sniff's name and explains the code; no strike for it", async () => {
    const port: FetchPort = {
      async get(url) {
        return { url, httpStatus: 404, body: "gone", contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: port })
    const r = await fetchTool(ctx, { urls: ["https://a.com/x"], mode: "direct", why: "t" })
    const doc = r.docs[0] as FetchDocFail
    expect(doc.reason).toBe("http-404")
    expect(doc.hint).toContain("answered 404")
    expect(ctx.breaker.open("a.com", "direct").open).toBe(false)
  })

  it("a slow fetch answers pending with a handle, and the bytes land later for free reads", async () => {
    const landings: Promise<void>[] = []
    const { ctx, ledger, claimId } = paidCtx({
      fetch: fakeFetcher({ "https://slow.com/": vendorHtml }, { delayMs: 40, usd: 0.008 }),
      pendingAfterMs: 5,
      trackPending: (p) => landings.push(p),
    })
    const r = await fetchTool(ctx, { urls: ["https://slow.com/"], mode: "unlock", why: "t" })
    const doc = r.docs[0] as FetchDocPending
    expect(doc.status).toBe("pending")
    expect(doc.handle).toMatch(/^p/)
    // The return did not wait, so nothing is billed on it yet.
    expect(r.spentUsd).toBe(0)

    const freeCtx = { evidence: ctx.evidence, ledger: ctx.ledger }
    const early = readTool(freeCtx, { handle: doc.handle })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reason).toContain("still in flight")

    await Promise.all(landings)
    const late = readTool(freeCtx, { handle: doc.handle })
    if (!late.ok) throw new Error(late.reason)
    expect(late.text).toContain("scraping API to developers")
    // The late bytes still drew their real cost against the claim.
    const room = ledger.draw(claimId, 0)
    if (!room.ok) throw new Error(room.reason)
    expect(room.remainingUsd).toBeCloseTo(ALLOWANCES.read - 0.008)
    // And the quote proves against them.
    expect(ctx.evidence.cite("https://slow.com/", "scraping API to developers").ok).toBe(true)
  })

  it("a slow fetch that ultimately fails lands as a readable explanation, not a hang", async () => {
    const landings: Promise<void>[] = []
    const port: FetchPort = {
      async get() {
        await new Promise((r) => setTimeout(r, 30))
        throw new Error("tunnel collapsed")
      },
    }
    const { ctx } = paidCtx({ fetch: port, pendingAfterMs: 5, trackPending: (p) => landings.push(p) })
    const r = await fetchTool(ctx, { urls: ["https://doomed.com/"], mode: "direct", why: "t" })
    const doc = r.docs[0] as FetchDocPending
    expect(doc.status).toBe("pending")
    await Promise.all(landings)
    const read = readTool({ evidence: ctx.evidence, ledger: ctx.ledger }, { handle: doc.handle })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("fetch-failed: tunnel collapsed")
  })

  it("url seven is not run; a malformed url is a sentence; a throwing port is contained", async () => {
    const port: FetchPort = {
      async get(url) {
        if (url.includes("boom")) throw new Error("getaddrinfo ENOTFOUND boom.com")
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: port })
    const urls = [
      "https://boom.com/",
      "not a url at all",
      ...Array.from({ length: 4 }, (_, i) => `https://ok${i}.com/`),
      "https://seventh.com/",
    ]
    const r = await fetchTool(ctx, { urls, mode: "direct", why: "t" })
    expect(r.docs).toHaveLength(7)
    expect(r.docs[0]).toMatchObject({ ok: false, reason: "fetch-failed" })
    expect((r.docs[0] as FetchDocFail).hint).toContain("ENOTFOUND")
    expect(r.docs[1]).toMatchObject({ ok: false, reason: "bad-url" })
    expect(r.docs[2]).toMatchObject({ ok: true })
    expect(r.docs[6]).toMatchObject({ ok: false, reason: "not-run" })
    expect((r.docs[6] as FetchDocFail).hint).toContain("only 6 urls fit")
  })

  // The dead-end taxonomy, swarm side. `reason` has always spoken the
  // sniffer's names; `code` is the same name as a typed field, so the swarm's
  // fetch failures count by the same union the sweep kernel counts by. The
  // taught sentences (`hint`) are untouched — the skill's byte-pins hold.
  it("every page-level failure carries the taxonomy code beside its sentence", async () => {
    const port: FetchPort = {
      async get(url) {
        if (url.includes("silent")) return { url, httpStatus: 0, body: "", ms: 1, usd: 0 }
        if (url.includes("gone")) return { url, httpStatus: 404, body: "x", contentType: "text/html", ms: 1, usd: 0 }
        if (url.includes("boom")) throw new Error("getaddrinfo ENOTFOUND boom.com")
        return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: port })
    const r = await fetchTool(ctx, {
      urls: ["https://wall.com/", "https://silent.com/", "https://gone.com/x", "https://boom.com/"],
      mode: "direct",
      why: "t",
    })
    expect(r.docs[0]).toMatchObject({ ok: false, reason: "empty-body", code: "empty-body" })
    expect(r.docs[1]).toMatchObject({ ok: false, reason: "no-response", code: "no-response" })
    expect(r.docs[2]).toMatchObject({ ok: false, reason: "http-404", code: "http-404" })
    expect(r.docs[3]).toMatchObject({ ok: false, reason: "fetch-failed", code: "fetch-failed" })
  })

  it("tool-level refusals carry no code — no page was judged", async () => {
    const { ctx } = paidCtx({ fetch: fakeFetcher({}) })
    // Two strikes on wall.com open the breaker for the third call.
    await fetchTool(ctx, { urls: ["https://wall.com/a"], mode: "direct", why: "t" })
    await fetchTool(ctx, { urls: ["https://wall.com/b"], mode: "direct", why: "t" })
    const r = await fetchTool(ctx, {
      urls: ["https://wall.com/c", "not a url at all"],
      mode: "direct",
      why: "t",
    })
    expect((r.docs[0] as FetchDocFail).reason).toBe("breaker-open")
    expect("code" in (r.docs[0] as FetchDocFail)).toBe(false)
    expect((r.docs[1] as FetchDocFail).reason).toBe("bad-url")
    expect("code" in (r.docs[1] as FetchDocFail)).toBe(false)
  })

  it("a spent allowance refuses every url before any money moves", async () => {
    let called = 0
    const port: FetchPort = {
      async get(url) {
        called++
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0.01 }
      },
    }
    const { ctx, ledger, claimId } = paidCtx({ fetch: port })
    ledger.draw(claimId, ALLOWANCES.read)
    const r = await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "t" })
    expect(called).toBe(0)
    const doc = r.docs[0] as FetchDocFail
    expect(doc.reason).toBe("refused")
    expect(doc.hint).toContain("allowance spent")
    expect(r.spentUsd).toBe(0)
  })

  it("an aborted run refuses in words instead of fetching", async () => {
    let called = 0
    const port: FetchPort = {
      async get(url) {
        called++
        return { url, httpStatus: 200, body: vendorHtml, ms: 1, usd: 0 }
      },
    }
    const { ctx } = paidCtx({ fetch: port, signal: AbortSignal.abort() })
    const r = await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "t" })
    expect(called).toBe(0)
    expect((r.docs[0] as FetchDocFail).hint).toContain("cancelled")
  })
})

// ── harvest ──────────────────────────────────────────────────────────────────

import { MapState, harvestTool, MAX_HARVEST_HOSTS, type HarvestClassify, type HarvestCtx } from "../src/index.js"

const aggregatorHtml =
  "<html><body><p>anchor.com is our #1 pick for this job, chosen after comparing dozens of vendors across pricing, reliability, and support quality so buyers do not have to run their own bake-off before choosing a tool.</p>" +
  Array.from({ length: 25 }, (_, i) => `<a href="https://vendor${i}.com/">v${i}</a>`).join(" ") +
  "</body></html>"

/** A classify that judges every page a competitor and quotes the vendor page's
 *  real sentence — the shape the live closure returns, dollars included. */
const okClassify =
  (usd = 0): HarvestClassify =>
  async () => ({
    out: {
      name: "Acme",
      kind: "company",
      what: "a scraping api for developers",
      relation: "competitor",
      why: "sells the same job to the same buyer",
      spans: ["We sell a scraping API to developers"],
    },
    usd,
  })

function harvestCtx(over: Partial<HarvestCtx> = {}): { ctx: HarvestCtx; ledger: Ledger; claimId: string } {
  const ledger = new Ledger(5)
  const r = ledger.reserve(ALLOWANCES.harvest)
  if (!r.ok) throw new Error("reserve failed in fixture")
  const ctx: HarvestCtx = {
    fetch: fakeFetcher({}),
    evidence: new RunEvidence(),
    ledger,
    claimId: r.claimId,
    map: new MapState("anchor.com"),
    seen: new Set(),
    writer: "rivals-fraud-scoring",
    aggregatorThreshold: null,
    classify: okClassify(),
    ...over,
  }
  return { ctx, ledger, claimId: r.claimId }
}

describe("harvestTool: the port-recording wrapper", () => {
  it("records the page BEFORE the verdict, so remember's cite-by-URL succeeds and the node lands own-page", async () => {
    const { ctx } = harvestCtx({ fetch: fakeFetcher({ "https://acme.com/": vendorHtml }) })
    const r = await harvestTool(ctx, { hosts: ["acme.com"], why: "judge the wave" })

    expect(r.rows[0]).toMatchObject({ host: "acme.com", ok: true, kind: "company", relation: "competitor", settledBy: "model" })
    expect(r.stats).toMatchObject({ fetched: 1, modelJudged: 1, settledFree: 0 })
    expect(r.landed).toEqual({ nodes: 1, merged: 0 })

    // The map row is real, cited to the host's own apex, at the own-page tier,
    // written as the mission — no side door into MapState.
    const node = ctx.map.nodes.get("acme.com")!
    expect(node).toBeDefined()
    expect(node.relation).toBe("competitor")
    expect(node.tier).toBe("own-page")
    expect(node.settledBy).toBe("model")
    expect(node.evidence[0]).toMatchObject({ url: "https://acme.com/", quote: "We sell a scraping API to developers" })
    expect(node.contributions).toEqual([{ writer: "rivals-fraud-scoring", tier: "own-page" }])

    // The wrapper's whole point: the page is in the store, citable by URL.
    const cite = ctx.evidence.cite("https://acme.com/", "scraping API to developers")
    expect(cite.ok).toBe(true)
    if (cite.ok) expect(cite.evidence.tier).toBe("page")
  })

  it("normalizes model-handed urls to hosts, refuses the anchor and duplicates by name", async () => {
    const { ctx } = harvestCtx({ fetch: fakeFetcher({ "https://acme.com/": vendorHtml }) })
    const r = await harvestTool(ctx, {
      hosts: ["https://www.acme.com/pricing", "acme.com", "anchor.com", "not a host"],
      why: "t",
    })
    const by = (h: string) => r.rows.find((x) => x.host === h)!
    expect(r.rows.filter((x) => x.host === "acme.com" && x.ok)).toHaveLength(1)
    expect(r.rows.filter((x) => x.host === "acme.com" && !x.ok)[0]!.reason).toContain("already in this call")
    expect(by("anchor.com").reason).toContain("that is the anchor")
    expect(by("not a host").reason).toContain("not a hostname")
    expect(ctx.map.nodes.size).toBe(1)
  })

  it("host forty-one is refused with a sentence and never fetched", async () => {
    let portCalls = 0
    const port: FetchPort = {
      async get(url) {
        portCalls++
        return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx } = harvestCtx({ fetch: port })
    const hosts = Array.from({ length: MAX_HARVEST_HOSTS + 1 }, (_, i) => `host${i}.com`)
    const r = await harvestTool(ctx, { hosts, why: "t" })
    expect(portCalls).toBe(MAX_HARVEST_HOSTS)
    const overflow = r.rows.find((x) => x.host === `host${MAX_HARVEST_HOSTS}.com`)!
    expect(overflow.reason).toContain(`only ${MAX_HARVEST_HOSTS} hosts fit in one harvest`)
  })
})

describe("harvestTool: mint and admit still gate — no side door", () => {
  it("an unreadable harvested host lands unknown wearing the sniffer's code, cited to the snippet that surfaced it", async () => {
    const { ctx } = harvestCtx() // fakeFetcher({}) answers empty bodies: blocked/empty-body
    // The run saw this host in a search wave; the snippet is the citable bytes.
    ctx.evidence.record({
      url: "https://dead.com/",
      text: "Dead — fraud scoring for online merchants\nDead sells fraud scoring to online merchants",
      status: "found",
      tier: "snippet",
    })
    const r = await harvestTool(ctx, { hosts: ["dead.com"], why: "t" })

    expect(r.rows[0]).toMatchObject({ host: "dead.com", ok: true, settledBy: "predicate" })
    expect(r.stats!.unreadableByReason).toEqual({ "empty-body": 1 })

    const node = ctx.map.nodes.get("dead.com")!
    expect(node.kind).toBe("company")
    expect(node.relation).toBe("unknown")
    expect(node.because).toBe("its front page could not be read this run (blocked)")
    expect(node.unreadableReason).toBe("empty-body")
    expect(node.settledBy).toBe("predicate")
    expect(node.tier).toBe("snippet")
  })

  it("an unreadable host the run holds no bytes for cannot land — the mint's rule, reported in the row", async () => {
    const { ctx } = harvestCtx()
    const r = await harvestTool(ctx, { hosts: ["ghost.com"], why: "t" })
    expect(r.rows[0]!.ok).toBe(false)
    expect(r.rows[0]!.reason).toContain("at least one quote")
    expect(ctx.map.nodes.size).toBe(0)
    // The judge still counted it: the stats and the map answer different questions.
    expect(r.stats!.unreadable).toBe(1)
  })

  it("an aggregator-shaped harvest lands as the gate's own directory verdict, wearing the refusal", async () => {
    const { ctx } = harvestCtx({
      fetch: fakeFetcher({ "https://listicle.com/": aggregatorHtml }),
      aggregatorThreshold: 12,
    })
    let modelCalls = 0
    ctx.classify = async () => {
      modelCalls++
      throw new Error("unreachable — the predicate settles this host")
    }
    const r = await harvestTool(ctx, { hosts: ["listicle.com"], why: "t" })
    expect(modelCalls).toBe(0)
    expect(r.stats!.aggregators).toBe(1)
    expect(r.rows[0]!.ok).toBe(true)

    // The claim went through remember and the ADMIT GATE re-derived the
    // downgrade from the recorded page — the node's directory kind is the
    // gate's writing, not the harvest's claim.
    const node = ctx.map.nodes.get("listicle.com")!
    expect(node.kind).toBe("directory")
    expect(node.relation).toBe("lists")
    expect(node.because).toContain("distinct vendor domains")
  })

  it("with the threshold null the aggregator page reaches the model — the live default path", async () => {
    let modelCalls = 0
    const { ctx } = harvestCtx({
      fetch: fakeFetcher({ "https://listicle.com/": aggregatorHtml }),
      aggregatorThreshold: null,
    })
    ctx.classify = async () => {
      modelCalls++
      return {
        out: { name: "Listicle", kind: "directory", what: "ranks vendors", relation: "lists", why: "indexes the market", spans: ["chosen after comparing dozens of vendors"] },
        usd: 0,
      }
    }
    const r = await harvestTool(ctx, { hosts: ["listicle.com"], why: "t" })
    expect(modelCalls).toBe(1)
    expect(r.rows[0]).toMatchObject({ ok: true, settledBy: "model" })
    expect(r.stats!.aggregators).toBe(0)
  })

  it("noise and relation-none verdicts do not land — the map draws no node for them, and the row says so", async () => {
    const { ctx } = harvestCtx({
      fetch: fakeFetcher({ "https://noise.com/": vendorHtml, "https://nothing.com/": vendorHtml }),
    })
    ctx.classify = async (h) => ({
      out:
        h.host === "noise.com"
          ? { name: "N", kind: "noise", what: "", relation: "none", why: "", spans: ["We sell a scraping API"] }
          : { name: "X", kind: "company", what: "a scraping api", relation: "none", why: "", spans: ["We sell a scraping API"] },
      usd: 0,
    })
    const r = await harvestTool(ctx, { hosts: ["noise.com", "nothing.com"], why: "t" })
    expect(r.rows.find((x) => x.host === "noise.com")!.reason).toContain("noise")
    expect(r.rows.find((x) => x.host === "nothing.com")!.reason).toContain("none")
    expect(ctx.map.nodes.size).toBe(0)
  })
})

describe("harvestTool: span discipline through the harvest path", () => {
  it("the quanticdata shape: an invented what lands wearing the fallback sentence, cited only to bytes actually on the page", async () => {
    const { ctx } = harvestCtx({ fetch: fakeFetcher({ "https://quanticdata.io/": vendorHtml }) })
    ctx.classify = async () => ({
      out: {
        name: "Quantic",
        kind: "company",
        what: "custom dataset delivery for enterprises",
        relation: "competitor",
        why: "same buyer",
        spans: ["custom dataset delivery"], // nowhere on the page — fails containment
      },
      usd: 0,
    })
    const r = await harvestTool(ctx, { hosts: ["quanticdata.io"], why: "t" })
    expect(r.rows[0]!.ok).toBe(true)

    const node = ctx.map.nodes.get("quanticdata.io")!
    // The invention never reaches the reader; the entity survives wearing the refusal.
    expect(node.what).toBe("Quantic — company whose description could not be tied to its page this run")
    // No verified span exists, so the citation is a mechanical opening quote
    // of the page's own stored text — literal bytes, proven by the mint.
    expect(node.evidence).toHaveLength(1)
    expect(node.evidence[0]!.url).toBe("https://quanticdata.io/")
    const cite = ctx.evidence.cite("https://quanticdata.io/", node.evidence[0]!.quote)
    expect(cite.ok).toBe(true)
  })

  it("verified spans ARE the node's quotes — the receipts land on the map", async () => {
    const { ctx } = harvestCtx({ fetch: fakeFetcher({ "https://acme.com/": vendorHtml }) })
    ctx.classify = async () => ({
      out: {
        name: "Acme",
        kind: "company",
        what: "a scraping api handling proxies",
        relation: "competitor",
        why: "same job",
        spans: ["We sell a scraping API", "handling proxies", "with white-glove onboarding"],
      },
      usd: 0,
    })
    await harvestTool(ctx, { hosts: ["acme.com"], why: "t" })
    const node = ctx.map.nodes.get("acme.com")!
    expect(node.what).toBe("a scraping api handling proxies")
    // The failing span was dropped by the kernel; only verified quotes landed.
    expect(node.evidence.map((e) => e.quote)).toEqual(["We sell a scraping API", "handling proxies"])
  })
})

describe("harvestTool: per-host settlement honesty", () => {
  it("every fetch and classify dollar draws on the claim as its host lands", async () => {
    const pages: Record<string, string> = {}
    for (const h of ["a.com", "b.com", "c.com"]) pages[`https://${h}/`] = vendorHtml
    const { ctx, ledger, claimId } = harvestCtx({
      fetch: fakeFetcher(pages, { usd: 0.01 }),
      classify: okClassify(0.02),
    })
    const r = await harvestTool(ctx, { hosts: ["a.com", "b.com", "c.com"], why: "t" })
    expect(r.spentUsd).toBeCloseTo(3 * 0.03, 6)
    const room = ledger.draw(claimId, 0)
    if (!room.ok) throw new Error(room.reason)
    expect(room.remainingUsd).toBeCloseTo(ALLOWANCES.harvest - 3 * 0.03, 6)
  })

  it("a kill at host N keeps the N judged hosts on the map and the ledger holds exactly their cost", async () => {
    // Serial pool; the port hard-aborts on its FOURTH call the way a wall
    // kill lands: the fetch in flight dies aborted, judged hosts stand.
    const ctl = new AbortController()
    let calls = 0
    const port: FetchPort = {
      async get(url) {
        calls++
        if (calls === 4) {
          ctl.abort()
          const e = new Error("This operation was aborted")
          e.name = "AbortError"
          throw e
        }
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0.01 }
      },
    }
    const { ctx, ledger, claimId } = harvestCtx({
      fetch: port,
      classify: okClassify(0.02),
      concurrency: 1,
      signal: ctl.signal,
    })
    const hosts = ["h1.com", "h2.com", "h3.com", "h4.com", "h5.com"]
    const r = await harvestTool(ctx, { hosts, why: "t" })

    const judged = r.rows.filter((x) => x.ok)
    const cut = r.rows.filter((x) => x.reason?.includes("cancelled mid-harvest"))
    expect(judged).toHaveLength(3)
    expect(cut).toHaveLength(2)
    expect(ctx.map.nodes.size).toBe(3)
    // Honest books: exactly three hosts' fetch+classify dollars drawn, no more.
    expect(r.spentUsd).toBeCloseTo(3 * 0.03, 6)
    const room = ledger.draw(claimId, 0)
    if (!room.ok) throw new Error(room.reason)
    expect(room.remainingUsd).toBeCloseTo(ALLOWANCES.harvest - 3 * 0.03, 6)
  })

  it("the allowance running dry aborts the pool: judged hosts stand, the rest come back saying why", async () => {
    const pages: Record<string, string> = {}
    for (const h of ["h1.com", "h2.com", "h3.com", "h4.com"]) pages[`https://${h}/`] = vendorHtml
    const ledger = new Ledger(5)
    const held = ledger.reserve(0.05) // a claim two hosts exhaust
    if (!held.ok) throw new Error("reserve failed")
    const { ctx } = harvestCtx({
      fetch: fakeFetcher(pages, { usd: 0.01 }),
      classify: okClassify(0.02),
      concurrency: 1,
      ledger,
      claimId: held.claimId,
    })
    const r = await harvestTool(ctx, { hosts: ["h1.com", "h2.com", "h3.com", "h4.com"], why: "t" })

    const judged = r.rows.filter((x) => x.ok)
    const dry = r.rows.filter((x) => x.reason?.includes("allowance ran dry"))
    expect(judged).toHaveLength(2)
    expect(dry).toHaveLength(2)
    expect(ctx.map.nodes.size).toBe(2)
    expect(r.spentUsd).toBeCloseTo(2 * 0.03, 6)
    // The claim's sub-ledger carries the honest number: 0.05 - 0.06 = -0.01.
    const room = ledger.draw(held.claimId, 0)
    if (!room.ok) throw new Error(room.reason)
    expect(room.remainingUsd).toBeCloseTo(0.05 - 2 * 0.03, 6)
  })

  it("a spent allowance refuses the whole call before any money moves, in the skill's sentence", async () => {
    let called = 0
    const port: FetchPort = {
      async get(url) {
        called++
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx, ledger, claimId } = harvestCtx({ fetch: port })
    ledger.draw(claimId, ALLOWANCES.harvest)
    const r = await harvestTool(ctx, { hosts: ["a.com", "b.com"], why: "t" })
    expect(called).toBe(0)
    expect(r.stats).toBeNull()
    for (const row of r.rows) expect(row.reason).toContain("allowance spent")
  })
})

describe("harvestTool: the stamps survive into the run-JSON entity rows", () => {
  it("settledBy and the reason code ride entities(); rows without them keep their exact shape", async () => {
    const { ctx } = harvestCtx({ fetch: fakeFetcher({ "https://acme.com/": vendorHtml }) })
    ctx.evidence.record({
      url: "https://dead.com/",
      text: "Dead — fraud scoring for online merchants\nDead sells fraud scoring to online merchants",
      status: "found",
      tier: "snippet",
    })
    await harvestTool(ctx, { hosts: ["acme.com", "dead.com"], why: "t" })

    const rows = ctx.map.entities()
    const acme = rows.find((r) => r.domain === "acme.com")!
    const dead = rows.find((r) => r.domain === "dead.com")!
    expect(acme.settledBy).toBe("model")
    expect("unreadableReason" in acme).toBe(false)
    expect(dead).toMatchObject({ settledBy: "predicate", unreadableReason: "empty-body", relation: "unknown" })
    expect(dead.because).toBe("its front page could not be read this run (blocked)")
  })
})
