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
