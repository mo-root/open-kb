import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { BreakerTable, Ledger, ALLOWANCES, canonicalUrl, type FetchPort, type SearchPort } from "@open-kb/core"
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
      return [...new Set(queries)].map((query) => {
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
        return [...new Set(queries)].map((query) => ({ query, hits: [], ok: true, usd: 0, ms: 1 }))
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
        return [...new Set(queries)].map((query) => ({ query, hits: [], ok: true, usd: 0, ms: 1 }))
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
        return [...new Set(queries)].map((query) => ({ query, hits: [], ok: true, usd: 0, ms: 1 }))
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

  it("puts the provider's stated refusal in front of the hint this file guesses", async () => {
    // The unlocker answers 200 with zero bytes and names the reason in a
    // header. `hintFor("empty-body")` has to cover every way a host can answer
    // with nothing; the header names the one that happened. The verdict is the
    // sniffer's either way — the response is rebuilt field by field on the way
    // in, which is exactly where the reason used to be dropped.
    const refusing: FetchPort = {
      async get(url) {
        return {
          url,
          httpStatus: 200,
          body: "",
          contentType: "text/html",
          providerError: "requested site was blocked (upstream 403)",
          ms: 1,
          usd: 0,
        }
      },
    }
    const { ctx } = paidCtx({ fetch: refusing })
    const r = await fetchTool(ctx, { urls: ["https://stripe.com/"], mode: "unlock", why: "t" })
    const doc = r.docs[0] as FetchDocFail
    expect(doc.reason).toBe("empty-body")
    expect(doc.hint).toContain("requested site was blocked (upstream 403)")
    // The advice survives: the header says what happened, not what to do next.
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

// ── onPageGained: what a fetch actually BOUGHT ───────────────────────────────

/**
 * The signal the finish gate prices a refusal in. Everything here is one
 * question: is this a page the run did not have a moment ago? A fetch CALL is
 * not — providers/src/brightdata.ts catches a network failure on the direct
 * branch and RESOLVES `{httpStatus: 0, body: "", usd: 0}`, so the cheapest
 * possible way to complete a fetch is to name a host that does not exist, for
 * $0.00. If the gate charged calls, that would be its price.
 */
describe("fetchTool: onPageGained fires for pages GAINED, and nothing else", () => {
  const gainer = (over: Partial<PaidCtx> = {}) => {
    const gained: string[] = []
    const { ctx, ledger, claimId } = paidCtx({ onPageGained: (url) => gained.push(url), ...over })
    return { ctx, ledger, claimId, gained }
  }

  it("a readable page the run did not hold is a gain, once", async () => {
    const { ctx, gained } = gainer({ fetch: fakeFetcher({ "https://a.com/": vendorHtml }) })
    const r = await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "t" })
    expect((r.docs[0] as FetchDocOk).ok).toBe(true)
    expect(gained).toEqual(["https://a.com/"])
  })

  it("and it says how much page: the second argument is the EXTRACTED text's length", async () => {
    // The gate's receipt is built from this number (`page:<url>(<chars>c)`),
    // so it has to be the string the model reads and the digest is taken
    // over — not the raw body, which carries the markup, and not the slice
    // the tool returns, which is capped. A receipt that cannot separate a
    // real page from a stub one character over core's THIN_TEXT floor cannot
    // audit the residue class it exists for.
    const sizes: Array<[string, number]> = []
    const { ctx } = paidCtx({
      fetch: fakeFetcher({ "https://a.com/": vendorHtml }),
      onPageGained: (url, chars) => sizes.push([url, chars]),
    })
    const r = await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "t" })
    const doc = r.docs[0] as FetchDocOk
    expect(doc.ok).toBe(true)
    expect(sizes).toHaveLength(1)
    const [url, chars] = sizes[0]!
    expect(url).toBe("https://a.com/")
    expect(chars).toBeLessThan(doc.bytes) // the markup is not the reading
    expect(chars).toBe(doc.text.length) // and this page is short of SLICE, so the whole reading came back
    expect(chars).toBeGreaterThan(200) // past THIN_TEXT, which is why it was a gain at all
  })

  it("a host that never answers does NOT pay: the port resolves, the run gained nothing", async () => {
    // The dead-URL loophole. httpStatus 0 is how the direct branch reports a
    // network failure it caught, and it costs $0 — so "the fetch tool returned"
    // is the cheapest signal in the system and cannot be the one that counts.
    const port: FetchPort = {
      async get(url) {
        return { url, httpStatus: 0, body: "", ms: 1, usd: 0 }
      },
    }
    const { ctx, gained } = gainer({ fetch: port })
    const r = await fetchTool(ctx, { urls: ["https://nowhere.invalid/x"], mode: "direct", why: "t" })
    expect((r.docs[0] as FetchDocFail).reason).toBe("no-response")
    expect(r.spentUsd).toBe(0)
    expect(gained).toEqual([])
  })

  it("a 403, an empty 200 and a thin render do not pay either — the sniffer's verdict is the gate", async () => {
    const port: FetchPort = {
      async get(url) {
        if (url.endsWith("/403")) return { url, httpStatus: 403, body: "denied", contentType: "text/html", ms: 1, usd: 0 }
        if (url.endsWith("/empty")) return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
        return { url, httpStatus: 200, body: "<html><body><p>hi</p></body></html>", contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const { ctx, gained } = gainer({ fetch: port })
    const r = await fetchTool(ctx, {
      urls: ["https://a.com/403", "https://a.com/empty", "https://a.com/thin"],
      mode: "direct",
      why: "t",
    })
    expect(r.docs.map((d) => (d as FetchDocFail).reason)).toEqual(["http-403", "empty-body", "thin-render"])
    expect(gained).toEqual([])
  })

  it("re-fetching a page the run already holds does not pay — the loophole a per-call price leaves open", async () => {
    // Nothing self-limits a repeat: settle() returns the doc before the
    // breaker's STRIKES check for a `found` page, so the same URL can be
    // bought again every turn. The store, not the call, decides.
    const { ctx, gained } = gainer({ fetch: fakeFetcher({ "https://a.com/": vendorHtml }) })
    await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "first" })
    await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "again" })
    await fetchTool(ctx, { urls: ["https://a.com/?utm_source=x"], mode: "direct", why: "canonically the same" })
    expect(gained).toEqual(["https://a.com/"])
  })

  it("a url the run has only SEEN in a SERP is still a gain — `seen` is not the store", async () => {
    // The brief proposed `seen` as the discriminator. searchTool puts every
    // hit's canonical url in `seen` before anyone opens it, so on that rule the
    // commonest honest answer to a refusal — search, then fetch the promising
    // result — would count for nothing and the gate could never be cleared.
    const { ctx, gained } = gainer({
      search: fakeSearch({ q: [{ url: "https://a.com/", title: "A", description: "d" }] }),
      fetch: fakeFetcher({ "https://a.com/": vendorHtml }),
    })
    await searchTool(ctx, { queries: ["q"], why: "find it" })
    expect(ctx.seen.has("https://a.com/")).toBe(true)
    await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "open it" })
    expect(gained).toEqual(["https://a.com/"])
  })

  it("a page that lands late still pays, once it lands", async () => {
    const { ctx, gained } = gainer({
      fetch: fakeFetcher({ "https://slow.com/": vendorHtml }, { delayMs: 40 }),
      pendingAfterMs: 5,
    })
    const landings: Promise<void>[] = []
    ctx.trackPending = (p) => landings.push(p)
    const r = await fetchTool(ctx, { urls: ["https://slow.com/"], mode: "direct", why: "t" })
    expect((r.docs[0] as FetchDocPending).status).toBe("pending")
    expect(gained).toEqual([]) // not yet: nothing has arrived
    await Promise.all(landings)
    expect(gained).toEqual(["https://slow.com/"])
  })

  it("a ctx without the hook fetches identically — investigators pay no lead debt", async () => {
    const { ctx } = paidCtx({ fetch: fakeFetcher({ "https://a.com/": vendorHtml }) })
    expect(ctx.onPageGained).toBeUndefined()
    const r = await fetchTool(ctx, { urls: ["https://a.com/"], mode: "direct", why: "t" })
    expect((r.docs[0] as FetchDocOk).ok).toBe(true)
  })
})

// ── the price is a PAGE, not a url string ────────────────────────────────────

/**
 * The alias hole, and it is one character outside the regression that was
 * meant to cover it: the existing repeat test uses `?utm_source=x`, which
 * `canonicalUrl` STRIPS, so it proved only that the tracking-key list works.
 * Every spelling the list does not name is a fresh store key for a page the
 * run is already holding — measured on this tool, one fetch of
 * `https://a.com/x` followed by `?a=1`, `http://a.com/x`, `//x`, `?a=2` and
 * `?a=3` fired SIX gains for $0.0000. Driven on the real loop, the lead
 * answered its refusal with `https://rival.com?q=1` and got
 * `stood: "work", workAnswered: 1`.
 *
 * And it fires with nobody cheating. In providers/src/brightdata.ts, the
 * direct branch of `brightDataFetch`'s `get` calls
 * `f(url, { redirect: "follow", signal })` and then returns `{ url, ... }` —
 * the url it was ASKED for; `res.url`, which is where the redirect actually
 * landed, is never read. The unlocked branch echoes the requested url the
 * same way, since it posts the url to the API and returns its own argument.
 * So an honest fetch of /pricing that lands on a /plans page the run already
 * read arrives under a url the store has never seen.
 *
 * The discriminator is the BYTES.
 */
describe("fetchTool: an alias of a page the run holds is not a page gained", () => {
  // PROCESS: the source these assertions measure is the one beside this file.
  // Vitest resolves `../src/index.js` against this test's own URL, so a
  // sibling checkout's copy cannot be what ran — asserted rather than assumed,
  // because a previous round measured a tree that was being swapped underneath it.
  const SRC = fileURLToPath(new URL("../src/tools-paid.ts", import.meta.url))

  /** Every url this port knows answers with the SAME bytes — the whole point:
   *  aliases of one page, plus a /pricing that redirects onto the /plans body
   *  the run already read. Anything else 404s, so a typo cannot pass as a hit. */
  const oneVendorPage = (): FetchPort => ({
    async get(url) {
      const known = new Set([
        "https://a.com/x",
        "https://a.com/x?q=1",
        "http://a.com/x",
        "https://a.com//x",
        "https://a.com/x?utm_source=n&q=2",
        "https://a.com/pricing", // the redirect: the port answers with /plans's body
      ])
      if (!known.has(url)) return { url, httpStatus: 404, body: "gone", contentType: "text/html", ms: 1, usd: 0 }
      // The provider's shape: the REQUESTED url comes back, whatever the wire did.
      return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0 }
    },
  })

  it("the store's key is a spelling, and every one of these spellings is a new key", () => {
    // The premise, pinned: if canonicalUrl ever folds these together this test
    // would pass for a reason that has nothing to do with the fix.
    expect(existsSync(SRC)).toBe(true)
    const base = canonicalUrl("https://a.com/x")
    for (const alias of ["https://a.com/x?q=1", "http://a.com/x", "https://a.com//x"]) {
      expect(canonicalUrl(alias)).not.toBe(base)
    }
    // ...and the one the existing regression used, which IS folded. That is
    // why it never caught this.
    expect(canonicalUrl("https://a.com/x?utm_source=n")).toBe(base)
  })

  it("six spellings of one page are one gain: plain ?q=, a scheme flip, a doubled slash, another param", async () => {
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: oneVendorPage(), onPageGained: (url) => gained.push(url) })

    for (const url of [
      "https://a.com/x",
      "https://a.com/x?q=1", // a plain query param — not a tracking key, not stripped
      "http://a.com/x", // the scheme is kept by canonicalUrl
      "https://a.com//x", // an internal double slash is kept too
      "https://a.com/x?utm_source=n&q=2", // the tracking key strips; q=2 does not
    ]) {
      const r = await fetchTool(ctx, { urls: [url], mode: "direct", why: "t" })
      expect((r.docs[0] as FetchDocOk).ok).toBe(true) // every one of them is a readable page
    }

    expect(gained).toEqual(["https://a.com/x"])
  })

  it("a redirect onto a page the run already read pays nothing — and nobody had to cheat", async () => {
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: oneVendorPage(), onPageGained: (url) => gained.push(url) })
    await fetchTool(ctx, { urls: ["https://a.com/x"], mode: "direct", why: "the page itself" })
    const r = await fetchTool(ctx, { urls: ["https://a.com/pricing"], mode: "direct", why: "an honest second fetch" })
    // The tool's answer to the model is unchanged: it IS a readable page, and
    // read/cite/remember all still work against it. Only the gate's price moves.
    expect((r.docs[0] as FetchDocOk).ok).toBe(true)
    expect((r.docs[0] as FetchDocOk).text.length).toBeGreaterThan(0)
    expect(gained).toEqual(["https://a.com/x"])
  })

  it("different bytes at a different url are still a gain — the predicate is not a rate limit", async () => {
    const gained: string[] = []
    const otherHtml = vendorHtml.replace("Acme Scraper", "Beta Crawler").replace("scraping API", "crawling service")
    const { ctx } = paidCtx({
      fetch: fakeFetcher({ "https://a.com/x": vendorHtml, "https://b.com/y": otherHtml }),
      onPageGained: (url) => gained.push(url),
    })
    await fetchTool(ctx, { urls: ["https://a.com/x"], mode: "direct", why: "one" })
    await fetchTool(ctx, { urls: ["https://b.com/y"], mode: "direct", why: "two" })
    expect(gained).toEqual(["https://a.com/x", "https://b.com/y"])
  })

  it("bytes an INVESTIGATOR already read are bytes the run holds: the store is run-wide", async () => {
    // The evidence store is shared across every lane, and so are the digest
    // set and the address set. A lead re-buying, under a new spelling, a page
    // one of its own lanes already read has gained the run nothing — the same
    // rule the un-aliased case has always had.
    const evidence = new RunEvidence()
    const lane = paidCtx({ fetch: oneVendorPage(), evidence }) // no hook: an investigator
    await fetchTool(lane.ctx, { urls: ["https://a.com/x"], mode: "direct", why: "the lane reads it" })

    const gained: string[] = []
    const boss = paidCtx({ fetch: oneVendorPage(), evidence, onPageGained: (url) => gained.push(url) })
    await fetchTool(boss.ctx, { urls: ["https://a.com/x?q=1"], mode: "direct", why: "the lead re-buys it" })
    expect(gained).toEqual([])
  })

  it("a nonce cannot re-sell ONE address: the digest misses it, the address catches it", async () => {
    // The digest is exact past a whitespace collapse, so a rendered timestamp
    // or a rotating token defeats it — deliberately, because a normaliser
    // aggressive enough to fold a timestamp folds two real pricing pages. What
    // bounds it is the other question: `?q=1` is not a new place, so the run
    // has been here and the second read buys nothing however its bytes moved.
    let n = 0
    const nonced: FetchPort = {
      async get(url) {
        n += 1
        return { url, httpStatus: 200, body: vendorHtml.replace("</body>", `<p>nonce ${n}</p></body>`), contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: nonced, onPageGained: (url) => gained.push(url) })
    for (const url of ["https://a.com/x", "https://a.com/x?q=1", "http://a.com/x", "https://a.com//x/"]) {
      const r = await fetchTool(ctx, { urls: [url], mode: "direct", why: "t" })
      expect((r.docs[0] as FetchDocOk).ok).toBe(true) // every read IS a readable page
    }
    expect(n).toBe(4) // ...and every read really did carry different bytes
    expect(gained).toEqual(["https://a.com/x"])
  })

  it("a nonce on a DIFFERENT path still reads as new — the residue, pinned rather than hidden", async () => {
    // The honest statement of what survives. Two distinct paths on one host,
    // each carrying a nonce, are two addresses and two readings, so they are
    // two gains for $0.0000. Closing it needs a normaliser that folds real
    // differences, which is the direction `hasText` refuses. It is bounded by
    // the gate's own arithmetic — one unit per refusal, two refusals a run —
    // not by this predicate, and that is recorded on GateReading.work.
    let n = 0
    const nonced: FetchPort = {
      async get(url) {
        n += 1
        return { url, httpStatus: 200, body: vendorHtml.replace("</body>", `<p>nonce ${n}</p></body>`), contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: nonced, onPageGained: (url) => gained.push(url) })
    await fetchTool(ctx, { urls: ["https://a.com/x"], mode: "direct", why: "one" })
    await fetchTool(ctx, { urls: ["https://a.com/y"], mode: "direct", why: "two" })
    expect(gained).toEqual(["https://a.com/x", "https://a.com/y"])
  })

  it("a site that addresses pages BY QUERY ALONE folds too — the honest answer this rule refuses", async () => {
    // The other side of the trade, pinned as a decision rather than left to be
    // rediscovered as a bug. `/item?id=7` and `/item?id=42` are two real,
    // different pages on plenty of real sites; here they carry entirely
    // different bytes and both land readable in the store. The run is credited
    // with ONE, because dropping the query is what makes `?q=1`, `?q=2`,
    // `?q=3` stop being an unbounded supply of fresh addresses on any host.
    // Deliberate, costed, and said out loud where the lead reads it: the
    // skill's finish paragraph carries "one path is one page whatever its
    // query", and the README states the trade in full. See `addressKey`.
    const catalogue: FetchPort = {
      async get(url) {
        const id = new URL(url).searchParams.get("id") ?? "0"
        return {
          url,
          httpStatus: 200,
          contentType: "text/html",
          body:
            `<html><body><h1>Item ${id}</h1><p>Vendor number ${id} sells a distinct product to a ` +
            `distinct buyer, described here in its own words at enough length that the extractor ` +
            `returns well past the thin-render floor and the sniffer calls this a page rather than ` +
            `a stub. Nothing on it is shared with any other item in this catalogue.</p></body></html>`,
          ms: 1,
          usd: 0,
        }
      },
    }
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: catalogue, onPageGained: (url) => gained.push(url) })
    const a = await fetchTool(ctx, { urls: ["https://a.com/item?id=7"], mode: "direct", why: "one" })
    const b = await fetchTool(ctx, { urls: ["https://a.com/item?id=42"], mode: "direct", why: "two" })
    // The premise: both really were readable pages, and their bytes differ.
    expect((a.docs[0] as FetchDocOk).ok).toBe(true)
    expect((b.docs[0] as FetchDocOk).ok).toBe(true)
    expect((a.docs[0] as FetchDocOk).text).not.toBe((b.docs[0] as FetchDocOk).text)
    expect(ctx.evidence.pages().map((p) => p.url)).toEqual([
      "https://a.com/item?id=7",
      "https://a.com/item?id=42",
    ])
    // And the gate is paid for one of them.
    expect(gained).toEqual(["https://a.com/item?id=7"])
  })

  it("whitespace-only differences DO fold — a re-render is the same page", async () => {
    const spaced: FetchPort = {
      async get(url) {
        const body = url.includes("?") ? vendorHtml.replace(/></g, ">\n  <") : vendorHtml
        return { url, httpStatus: 200, body, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: spaced, onPageGained: (url) => gained.push(url) })
    await fetchTool(ctx, { urls: ["https://a.com/x"], mode: "direct", why: "one" })
    await fetchTool(ctx, { urls: ["https://a.com/x?q=1"], mode: "direct", why: "two" })
    expect(gained).toEqual(["https://a.com/x"])
  })
})

// ── the HOST cannot supply the bytes either ──────────────────────────────────

/**
 * The last free supply, and the one nobody has to be hostile to run: printing
 * the missing path is the DEFAULT behaviour of most 404 templates. `sniff`
 * calls a 200 with more than THIN_TEXT (200) extracted characters `found`, so
 * a soft 404, a site-search result, a "did you mean" page or any error
 * template that echoes the address it was handed is page-tier — and a direct
 * fetch is $0.00, so `https://anchor.com/<anything>` was an unbounded supply
 * of gains from ONE host with an empty map to show for it.
 *
 * The reading is digested with the address it was asked for masked out of it,
 * so ten spellings of one template are one reading.
 */
describe("fetchTool: a page that prints the path it was handed is one reading, not many", () => {
  // PROCESS: the source these assertions measure is the one beside this file.
  const ECHO_SRC = fileURLToPath(new URL("../src/run-evidence.ts", import.meta.url))

  const filler =
    "The address you asked for is not on this server. Check the spelling, or start again from the home page. " +
    "Our documentation, pricing and contact pages are all reachable from the navigation above, and the search " +
    "box will find most things faster than guessing at a url."

  /** Every path answers 200 with the SAME template, printing the path back. */
  const echoing = (): FetchPort => ({
    async get(url) {
      const u = new URL(url)
      const echoed = u.pathname + u.search
      return {
        url,
        httpStatus: 200,
        contentType: "text/html",
        body: `<html><body><h1>Page not found</h1><p>We could not find <code>${echoed}</code> here. ${filler}</p></body></html>`,
        ms: 1,
        usd: 0,
      }
    },
  })

  it("the premise: every one of these IS a readable page, and every one carries different bytes", async () => {
    expect(existsSync(ECHO_SRC)).toBe(true)
    const { ctx } = paidCtx({ fetch: echoing() })
    const seenText = new Set<string>()
    for (const p of ["/a-page-that-is-not-here", "/another-missing-page", "/third-missing-page"]) {
      const r = await fetchTool(ctx, { urls: [`https://anchor.com${p}`], mode: "direct", why: "t" })
      const doc = r.docs[0] as FetchDocOk
      expect(doc.ok).toBe(true) // the sniffer says found: it is page tier
      expect(doc.text).toContain(p) // ...because the host printed our own request back
      seenText.add(doc.text)
    }
    expect(seenText.size).toBe(3) // three genuinely different digests, raw
  })

  it("four spellings of one soft 404 are ONE gain, at $0.0000", async () => {
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: echoing(), onPageGained: (url) => gained.push(url) })
    const r = await fetchTool(ctx, {
      urls: [
        "https://anchor.com/this-page-does-not-exist-7f3a",
        "https://anchor.com/nor-does-this-one",
        "https://anchor.com/deeply/nested/nothing",
        "https://anchor.com/one-more-guess",
      ],
      mode: "direct",
      why: "four guesses at one host",
    })
    expect(r.docs.every((d) => "ok" in d && d.ok)).toBe(true)
    expect(r.spentUsd).toBe(0)
    expect(gained).toEqual(["https://anchor.com/this-page-does-not-exist-7f3a"])
  })

  it("a site-search page echoing the QUERY folds too — the mask reads the query, not just the path", async () => {
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: echoing(), onPageGained: (url) => gained.push(url) })
    await fetchTool(ctx, { urls: ["https://anchor.com/search?q=fraud+scoring"], mode: "direct", why: "one" })
    await fetchTool(ctx, { urls: ["https://anchor.com/search?q=chargeback+risk"], mode: "direct", why: "two" })
    expect(gained).toEqual(["https://anchor.com/search?q=fraud+scoring"])
  })

  it("a REAL page on the echoing host is still a gain — the mask is not a host ban", async () => {
    // The fix must narrow the price, not delete it: a host with an echoing 404
    // template still has real pages, and reading one is real work.
    const real = "<html><body><h1>Pricing</h1><p>" + filler + " Plans start at $49 a month.</p></body></html>"
    const mixed: FetchPort = {
      async get(url) {
        if (url.endsWith("/pricing")) return { url, httpStatus: 200, body: real, contentType: "text/html", ms: 1, usd: 0 }
        return echoing().get(url, "direct")
      },
    }
    const gained: string[] = []
    const { ctx } = paidCtx({ fetch: mixed, onPageGained: (url) => gained.push(url) })
    await fetchTool(ctx, { urls: ["https://anchor.com/guessing-at-a-url"], mode: "direct", why: "a guess" })
    await fetchTool(ctx, { urls: ["https://anchor.com/pricing"], mode: "direct", why: "a real page" })
    expect(gained).toEqual(["https://anchor.com/guessing-at-a-url", "https://anchor.com/pricing"])
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
