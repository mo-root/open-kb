import { describe, it, expect, vi } from "vitest"
import { sniff } from "@open-kb/core"
import { brightDataSearch, brightDataFetch, DEFAULT_UNLOCKED_TIMEOUT_MS } from "../src/brightdata.js"

const creds = { token: "t", serpZone: "serp", unlockerZone: "unlock" }

/** A fetch that never answers but honors init.signal the way undici does:
 *  reject with an AbortError the moment the signal fires. A fake that
 *  ignores the signal would pass against code that never wires one. */
const hangingFetch = () =>
  vi.fn((_u: unknown, init: unknown) => {
    const signal = (init as RequestInit).signal
    return new Promise<Response>((_res, rej) => {
      if (signal?.aborted) {
        const e = new Error("This operation was aborted")
        e.name = "AbortError"
        rej(e)
        return
      }
      signal?.addEventListener("abort", () => {
        const e = new Error("This operation was aborted")
        e.name = "AbortError"
        rej(e)
      })
    })
  })

/** Every mock below carries fetch's parameter list, because several of them are
 *  read back through `mock.calls[0][1]` to assert what was actually sent. A
 *  zero-argument `vi.fn` types those calls as an empty tuple, so the assertions
 *  are index-out-of-range errors the moment this file is typechecked — which it
 *  was not, until `packages/providers/tsconfig.tests.json` existed. */
type FetchArgs = Parameters<typeof fetch>

/**
 * What every name in this file resolves to.
 *
 * The direct branch will not connect to a host until it has an address for it
 * and the address is public, so a fake socket is no longer a complete fake
 * network — a test that stubbed only `fetchImpl` would either reach the real
 * resolver or, on a name nobody registered, be refused by the guard and never
 * reach the stub at all. One public address, for every name, is what "this host
 * is an ordinary site on the internet" now looks like.
 */
const resolvesPublic = async () => ["93.184.216.34"]

describe("brightDataSearch", () => {
  it("asks google for parsed json and maps organic results", async () => {
    const fetchSpy = vi.fn(async (..._: FetchArgs) =>
      new Response(JSON.stringify({ organic: [{ link: "https://a.com", title: "A", description: "d" }] }), { status: 200 }),
    )
    const s = brightDataSearch(creds, { fetchImpl: fetchSpy as unknown as typeof fetch })
    const [r] = await s.search(["web scraping api"])
    expect(r!.ok).toBe(true)
    expect(r!.hits[0]!.url).toBe("https://a.com")
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.zone).toBe("serp")
    expect(body.url).toContain("brd_json=1")
    expect(decodeURIComponent(body.url)).toContain("web scraping api")
  })

  it("fails one query without failing the batch", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n++
      return n === 1 ? new Response("boom", { status: 500 }) : new Response(JSON.stringify({ organic: [] }), { status: 200 })
    })
    // pages: 1 so "the first call" and "the whole query" are the same thing. With
    // the default of 3 this would assert something else entirely, that a query
    // whose first page failed and whose other two succeeded counts as failed,
    // which is not what we want and not what the code does.
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 })
    const rs = await s.search(["bad", "good"])
    expect(rs[0]!.ok).toBe(false)
    expect(rs[1]!.ok).toBe(true)
  })

  it("reads several result pages per query and merges them", async () => {
    // Page 1 of a query returned 7 distinct hosts in a live measurement; pages
    // 2-5 added 9, 9, 5 and 7 more. Reading only the first page was leaving most
    // of a market unread, so a query is now several calls.
    const seen: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as RequestInit).body as string) as { url: string }
      seen.push(body.url)
      const start = new URL(body.url).searchParams.get("start") ?? "0"
      return new Response(
        JSON.stringify({ organic: [{ link: `https://p${start}.com/x`, title: `page ${start}`, description: "" }] }),
        { status: 200 },
      )
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 3 })
    const [r] = await s.search(["proxy network"])

    expect(seen).toHaveLength(3)
    expect(seen.some((u) => !u.includes("start="))).toBe(true) // page 1 carries no offset
    expect(seen.some((u) => u.includes("start=10"))).toBe(true)
    expect(seen.some((u) => u.includes("start=20"))).toBe(true)
    // One result per query, not three, the pages are folded back together.
    expect(r!.hits).toHaveLength(3)
    // Rank is built from the page offset, so page 3's lone hit is rank 21 —
    // the merged rows stay comparable across pages by construction.
    expect(r!.hits.map((h) => h.rank)).toEqual([1, 11, 21])
    expect(r!.usd).toBeCloseTo(0.0045) // billed per page, because each page is a call
  })

  it("ranks a page-2 hit 11+ even when the provider re-sends global_rank 1-10", async () => {
    // brd_json's `global_rank` restarts on every page: across 10,218 stored
    // entities from 4-page runs the max bestRank was 16 and not one exceeded
    // 20, which cannot happen if page-3/4 hits carried ranks 21-40. Trusting
    // the field flattened every page onto ranks 1-10, so a page-4 also-ran
    // stored the prominence of a page-1 leader.
    const fetchImpl = vi.fn(async (_u: unknown, init: unknown) => {
      const body = JSON.parse((init as RequestInit).body as string) as { url: string }
      const start = new URL(body.url).searchParams.get("start") ?? "0"
      return new Response(
        JSON.stringify({
          organic: [
            { link: `https://s${start}a.com/`, title: "t", description: "", global_rank: 1 },
            { link: `https://s${start}b.com/`, title: "t", description: "", global_rank: 2 },
          ],
        }),
        { status: 200 },
      )
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 2 })
    const [r] = await s.search(["x"])
    // Page 1 ranks 1-2; page 2 (start=10) ranks 11-12, not the 1-2 it claimed.
    expect(r!.hits.map((h) => [h.url, h.rank])).toEqual([
      ["https://s0a.com/", 1],
      ["https://s0b.com/", 2],
      ["https://s10a.com/", 11],
      ["https://s10b.com/", 12],
    ])
  })

  it("keeps a query that only partly failed, rather than discarding what it got", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n++
      return n === 3
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ organic: [{ link: `https://a${n}.com`, title: "t", description: "" }] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 3 })
    const [r] = await s.search(["x"])
    expect(r!.ok).toBe(true) // two pages worked
    expect(r!.hits).toHaveLength(2) // and their rows are kept
    expect(r!.error).toContain("1/3 pages failed")
  })
})

describe("brightDataSearch and a query asked twice", () => {
  /**
   * Measured against the unfixed port: search(["x","x"]) with pages 6 issued
   * TWELVE requests and returned two rows of twelve pages' cost each. Actual
   * spend k*p*price, reported k^2*p*price — the money doubled and the report
   * doubled the money. Both halves are pinned below: the request COUNT, and the
   * usd summed across the returned rows.
   */
  const page = (link: string) =>
    new Response(JSON.stringify({ organic: [{ link, title: "t", description: "" }] }), { status: 200 })

  it("buys one wave of pages for a query however many times it was asked", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => page("https://a.com"))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 3 })
    const rs = await s.search(["x", "x"])
    // Three pages, not six. The duplicate is not a second search.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(rs).toHaveLength(1)
    expect(rs[0]!.query).toBe("x")
  })

  it("reports across its rows exactly what it spent, and no more", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => page("https://a.com"))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 3, serpUsd: 0.001 })
    const rs = await s.search(["x", "x"])
    const reported = rs.reduce((n, r) => n + r.usd, 0)
    // The property, as arithmetic: every request issued is billed to exactly one
    // returned row. core/tools.ts spans once per row and the run meter adds the
    // spans up, so a row carrying a sibling's cost is a meter that lies.
    expect(reported).toBeCloseTo(fetchImpl.mock.calls.length * 0.001)
    expect(reported).toBeCloseTo(0.003)
  })

  it("stays linear at k=3, where a half-fix would still be quadratic", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => page("https://a.com"))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 2, serpUsd: 0.001 })
    const rs = await s.search(["x", "x", "x"])
    // k=2 is where a half-fix hides: dropping ONE copy, or comparing only
    // adjacent pairs, is indistinguishable from a real dedupe when there are
    // only two. At k=3 either leaves a copy behind and the count goes back up.
    // Unfixed this issued 6 requests and reported 3 rows x 6 pages = 18 pages.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(rs).toHaveLength(1)
    expect(rs.reduce((n, r) => n + r.usd, 0)).toBeCloseTo(0.002)
  })

  it("keeps distinct queries apart and holds first-asked order", async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (_u: unknown, init: unknown) => {
      const body = JSON.parse((init as RequestInit).body as string) as { url: string }
      asked.push(new URL(body.url).searchParams.get("q")!)
      return page("https://a.com")
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, serpUsd: 0.001 })
    const rs = await s.search(["a", "b", "a"])
    // A dedupe that only looked at neighbours would let this third "a" through.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(asked).toEqual(["a", "b"])
    expect(rs.map((r) => r.query)).toEqual(["a", "b"])
    expect(rs.reduce((n, r) => n + r.usd, 0)).toBeCloseTo(0.002)
  })

  it("lets a duplicated query fail on its own without failing the batch", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n += 1
      return n === 1 ? new Response("nope", { status: 401 }) : page("https://good.com")
    })
    // 401 is not retryable and pages is 1, so "the first call" and "the whole
    // query" are the same thing. Dedupe must not turn one failed duplicate into
    // a rejected batch — the failure stays inside its own row.
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 })
    const rs = await s.search(["bad", "bad", "good"])
    expect(fetchImpl).toHaveBeenCalledTimes(2) // the copy is still never dispatched
    expect(rs).toHaveLength(2)
    expect(rs[0]!.ok).toBe(false)
    expect(rs[1]!.ok).toBe(true)
  })

  it("still merges the pages of a query and dedupes its hits by url", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init: unknown) => {
      const body = JSON.parse((init as RequestInit).body as string) as { url: string }
      const start = new URL(body.url).searchParams.get("start") ?? "0"
      return new Response(
        JSON.stringify({
          organic: [
            { link: "https://both.com/x", title: "ranks on every page", description: "" },
            { link: `https://p${start}.com/x`, title: `page ${start}`, description: "" },
          ],
        }),
        { status: 200 },
      )
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 2 })
    const rs = await s.search(["x", "x"])
    expect(rs).toHaveLength(1)
    // The url on both pages is counted once, and each page's own url survives.
    expect(rs[0]!.hits.map((h) => h.url)).toEqual([
      "https://both.com/x",
      "https://p0.com/x",
      "https://p10.com/x",
    ])
  })

  it("treats case and trailing space as different queries, because they are different requests", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => page("https://a.com"))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 })
    const rs = await s.search(["x", "X", "x "])
    // Three distinct URLs (q=x, q=X, q=x%20), so three requests Bright Data
    // bills separately — merging them would report a spend that did not happen.
    // Google's own case-folding is Google's; a port that guessed it would
    // silently drop a query the caller deliberately wrote.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(rs.map((r) => r.query)).toEqual(["x", "X", "x "])
  })

  it("refuses a blank query rather than buying pages of `q=`", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => page("https://a.com"))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 3, serpUsd: 0.001 })
    const rs = await s.search(["", "   ", "real"])
    // Only "real" reached the wire, three pages of it. A blank would have cost
    // three more requests each and no arrangement of whitespace returns a market.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(rs).toHaveLength(3)
    expect(rs[0]!.ok).toBe(false)
    expect(rs[0]!.usd).toBe(0)
    expect(rs[1]!.ok).toBe(false)
    expect(rs[2]!.ok).toBe(true)
    expect(rs.reduce((n, r) => n + r.usd, 0)).toBeCloseTo(0.003)
  })
})

describe("brightDataFetch", () => {
  it("uses no proxy at all for direct mode", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("hello", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: resolvesPublic })
    const r = await f.get("https://a.com", "direct")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://a.com")
    expect(r.usd).toBe(0)
    expect(r.body).toBe("hello")
  })

  it("routes unlocked mode through the unlocker zone and prices it", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("<html>ok</html>", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.brightdata.com/request")
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.zone).toBe("unlock")
    expect(r.usd).toBeGreaterThan(0)
  })

  it("returns a zero-byte 200 unchanged so the sniffer can judge it", async () => {
    // measured: this is exactly what stripe.com does. The provider must not paper over it.
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
  })

  it("does not throw and charges nothing when direct mode never gets a response", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      throw new Error("getaddrinfo ENOTFOUND a.com")
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: resolvesPublic })
    const r = await f.get("https://a.com", "direct")
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
  })

  it("does not throw and charges nothing when the unlocked request never reaches Bright Data", async () => {
    // A connection that never opens (DNS failure, reset, timeout before any response) is a
    // call Bright Data never billed, unlike a completed request that comes back as a 500,
    // which stays priced. Charging for this would corrupt the run's cost accounting.
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      throw new Error("fetch failed: connection reset")
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
  })
})

describe("brightDataFetch direct timeouts", () => {
  it("abandons a direct fetch that will not answer, after directTimeoutMs", async () => {
    // Measured on the rank pool: a handful of tar-pit hosts each hold a worker
    // slot for undici's default ~300s without this bound. The calibration
    // script already used 8s; the production path must too.
    const fetchImpl = hangingFetch()
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, directTimeoutMs: 50, lookup: resolvesPublic })
    const r = await f.get("https://tarpit.com/", "direct")
    expect(r.httpStatus).toBe(0)
    expect(r.body).toBe("")
    expect(r.usd).toBe(0)
  }, 2_000)

  it("an external abort lands a direct fetch as unreadable promptly, not at the timeout", async () => {
    const fetchImpl = hangingFetch()
    const ctl = new AbortController()
    // A timeout long past the test's own deadline: only the caller's signal
    // can end this fetch inside the test window.
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, directTimeoutMs: 60_000, lookup: resolvesPublic })
    const pending = f.get("https://slow.com/", "direct", { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    const r = await pending
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
  }, 2_000)
})

/**
 * The address guard, seen from the port — `safe-fetch.test.ts` proves the
 * guard's own decisions, this proves the port actually has one in front of its
 * socket and reports the refusal in a shape the sweep can read.
 */
describe("brightDataFetch will not be steered onto a private address", () => {
  it("refuses a private literal without connecting, and says so instead of shrugging", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("root:x:0:0:", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: resolvesPublic })
    const r = await f.get("http://169.254.169.254/latest/meta-data/iam/security-credentials/", "direct")

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(r.httpStatus).toBe(0)
    expect(r.body).toBe("")
    expect(r.usd).toBe(0)
    // The distinction that matters in a span log: refused, not unreachable.
    expect(r.providerError).toContain("refused")
    expect(r.providerError).toContain("169.254.169.254")
  })

  it("refuses a public name that resolves to loopback — the decoy a spelling check cannot see", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("the inside of the deployment", { status: 200 }))
    const f = brightDataFetch(creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: async () => ["127.0.0.1"],
    })
    const r = await f.get("https://127.0.0.1.nip.io/llms.txt", "direct")
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(r.httpStatus).toBe(0)
    expect(r.body).toBe("")
    expect(r.providerError).toContain("127.0.0.1")
  })

  it("stops a redirect from a public page onto the metadata endpoint, and returns none of its bytes", async () => {
    // The measured hole: the direct branch asked for `redirect: "follow"` and
    // undici followed the 302 inward, whereupon the body was condensed, handed
    // to the model, and readable afterwards at GET /api/kb.
    const secret = "AccessKeyId=AKIAEXAMPLE"
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === "https://evil.com/llms.txt") {
        return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
      }
      return new Response(secret, { status: 200 })
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: resolvesPublic })
    const r = await f.get("https://evil.com/llms.txt", "direct")

    expect(fetchImpl).toHaveBeenCalledTimes(1) // hop one only
    expect(r.httpStatus).toBe(0)
    expect(r.body).toBe("")
    expect(r.body).not.toContain("AKIA")
    expect(r.providerError).toContain("169.254.169.254")
  })

  it("cannot be switched off by replacing the socket", async () => {
    // `fetchImpl` is the transport, not the policy. If injecting one moved the
    // guard out of the way, the guard would be one refactor away from being
    // absent in production too.
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("hello", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: async () => ["10.0.0.5"] })
    const r = await f.get("https://looks-fine.com/", "direct")
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(r.httpStatus).toBe(0)
  })

  it("still follows the redirect a real site has", async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === "https://example.com/") return new Response("", { status: 301, headers: { location: "https://www.example.com/" } })
      return new Response("<html>the real page</html>", { status: 200, headers: { "content-type": "text/html" } })
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: resolvesPublic })
    const r = await f.get("https://example.com/", "direct")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toContain("the real page")
    expect(r.contentType).toBe("text/html")
    expect(r.usd).toBe(0)
  })

  it("keeps a refusal inside the direct deadline even when it is the RESOLVER that hangs", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("hello", { status: 200 }))
    const f = brightDataFetch(creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: () => new Promise<string[]>(() => {}), // a nameserver that never answers
      directTimeoutMs: 50,
    })
    const r = await f.get("https://tarpit-dns.com/", "direct")
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
    expect(r.providerError).toContain("gave up after 50ms")
  }, 2_000)

  it("bounds its own refusal sentence, which carries a hostname somebody else chose", async () => {
    // `providerError` rides span.error into the DOM and into storage. A 308-character
    // host is a 308-character sentence unless something says otherwise.
    const host = `${"a".repeat(60)}.`.repeat(5) + "com"
    const f = brightDataFetch(creds, {
      fetchImpl: (async () => new Response("x")) as unknown as typeof fetch,
      lookup: async () => ["10.0.0.5"],
    })
    const r = await f.get(`https://${host}/`, "direct")
    expect(host.length).toBe(308)
    expect(r.providerError!.length).toBeLessThanOrEqual(120)
    expect(r.providerError).toContain("refused")
  })

  it("leaves the unlocked branch alone, because its socket goes to Bright Data and not inward", async () => {
    // Stated so the asymmetry is a decision on the record rather than an
    // oversight: the unlocked path POSTs the target url to api.brightdata.com
    // as a string in a JSON body. Bright Data's network resolves it, not ours,
    // so there is no path from that url to anything on this host — and adding a
    // refusal here would only decline to spend money on a request that was
    // never dangerous.
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("<html>x</html>", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: resolvesPublic })
    const r = await f.get("http://169.254.169.254/", "unlocked")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.brightdata.com/request")
    expect(r.httpStatus).toBe(200)
  })
})

describe("brightDataFetch unlocked backstop", () => {
  /**
   * The unlocked path had no bound of its own on purpose — 33-60s is a normal
   * unlocked fetch and a direct-style timeout would have killed the pages we
   * pay for. But it delegated the WHOLE bound to the caller, and half the
   * callers passed nothing, so those fetches were bounded by nothing at all.
   * What follows pins both halves: slow still finishes, silent gets cut.
   */

  it("leaves room for a fetch slower than any ever measured", () => {
    // Not a round number chosen for looking safe. The slowest COMPLETED
    // unlocked fetch on record is stripe.com's hard block, 200 with zero bytes
    // after 33-60s, seen twice on two zones (core/tests/sniff.test.ts); the
    // eight unlocker spans in runs/swarm-brightdata-com-202608060833.spans.jsonl
    // run 0.5-21.4s with a 16.9s median. The default is twice the worst case.
    // This test exists so that tuning it back down has to argue with the
    // measurement rather than quietly succeed.
    expect(DEFAULT_UNLOCKED_TIMEOUT_MS).toBeGreaterThan(60_000)
  })

  it("lets a sixty-second unlocked fetch finish under the default backstop", async () => {
    // Sixty seconds of the test's clock and none of the wall's. The backstop is
    // an AbortSignal.timeout, which fake timers cannot reach — so it is running
    // on real time here, all two milliseconds of it, and cannot be what ends
    // this fetch. What is being pinned is that nothing in the port cuts a slow
    // fetch short.
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_u: unknown, init: unknown) => {
        const signal = (init as RequestInit).signal
        return new Promise<Response>((res, rej) => {
          setTimeout(() => res(new Response("<html>slow but real</html>", { status: 200 })), 60_000)
          signal?.addEventListener("abort", () => {
            const e = new Error("This operation was aborted")
            e.name = "AbortError"
            rej(e)
          })
        })
      })
      const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
      const pending = f.get("https://slow-but-real.com/", "unlocked")
      await vi.advanceTimersByTimeAsync(60_000)
      const r = await pending
      expect(r.httpStatus).toBe(200)
      expect(r.body).toContain("slow but real")
      expect(r.ms).toBeGreaterThanOrEqual(60_000)
      // It completed, so it is billed. The $0 side is for requests that never did.
      expect(r.usd).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cuts an unlocked fetch that will not answer, and charges nothing for it", async () => {
    // Without this the socket sat until undici's ~300s default, holding a pool
    // worker and a run that could not end. Abandoned before any response, so
    // Bright Data has nothing to bill: the timeout lands on the $0 side, the
    // same side as a connection reset, and not on the completed-response side.
    const fetchImpl = hangingFetch()
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, unlockedTimeoutMs: 50 })
    const r = await f.get("https://tarpit.com/", "unlocked")
    expect(r.httpStatus).toBe(0)
    expect(r.body).toBe("")
    expect(r.usd).toBe(0)
    expect(r.providerError).toBe("unlocked fetch gave up after 50ms")
  }, 2_000)

  it("still applies the backstop when the caller passes a signal that never fires", async () => {
    // The composition, not just the timeout. Handing the caller's signal
    // straight to fetch would REPLACE the backstop, and a caller that holds a
    // signal it never trips is the ordinary case — a run nobody cancelled.
    const fetchImpl = hangingFetch()
    const patient = new AbortController()
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, unlockedTimeoutMs: 50 })
    const r = await f.get("https://tarpit.com/", "unlocked", { signal: patient.signal })
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
    expect(r.providerError).toBe("unlocked fetch gave up after 50ms")
  }, 2_000)

  it("lets the caller's signal end an unlocked fetch long before the backstop", async () => {
    // A cancelled run must get its sockets back now, not in two minutes. A
    // backstop long past the test's own deadline, so only the caller can end it.
    const fetchImpl = hangingFetch()
    const ctl = new AbortController()
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, unlockedTimeoutMs: 60_000 })
    const pending = f.get("https://slow.com/", "unlocked", { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    const r = await pending
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
    // Which of the two ended it, said rather than inferred: httpStatus 0 spells
    // "cancelled", "gave up" and "the connection died" identically.
    expect(r.providerError).toBe("the caller cancelled this fetch")
  }, 2_000)

  it("does not report a give-up when the request simply failed", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      throw new Error("fetch failed: connection reset")
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
    // Nothing stated it, so nothing is claimed. The message itself is not
    // repeated: a transport error can carry a request id or a key fragment.
    expect(r.providerError).toBeUndefined()
  })
})

describe("brightDataFetch surfaces the refusal the provider stated", () => {
  /**
   * The SERP path has read `x-brd-error` since the run that reported "42
   * failed" while every response carried the reason in a header. The unlocked
   * path read neither header, so the sniffer was left inferring `empty-body`
   * from a zero-byte body that had an explanation attached to it.
   */
  const refused = (headers: Record<string, string>) =>
    vi.fn(async (..._: FetchArgs) => new Response("", { status: 200, headers }))

  it("hands the caller the provider's own sentence, with the upstream's code", async () => {
    const fetchImpl = refused({ "x-brd-error": "requested site was blocked", "x-brd-status-code": "403" })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.providerError).toBe("requested site was blocked (upstream 403)")
  })

  it("carries the reason alone when there is no upstream code", async () => {
    const fetchImpl = refused({ "x-brd-error": "response body was rejected" })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(r.providerError).toBe("response body was rejected")
  })

  it("claims nothing when the provider said nothing", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("<html>ok</html>", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(r.providerError).toBeUndefined()
  })

  it("does not hide the zero-byte 200 behind the header", async () => {
    // The measured hard-block shape, now with its explanation attached. The
    // response is still returned exactly as it arrived, and it is still billed:
    // a request Bright Data serviced is a request Bright Data charges for.
    const fetchImpl = refused({ "x-brd-error": "requested site was blocked", "x-brd-status-code": "403" })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
    expect(r.usd).toBeGreaterThan(0)
  })

  it("reaches the sniffer, which still calls the outcome itself", async () => {
    // The whole point of the field: the verdict is unchanged and the reason
    // code is unchanged — persisted runs count unreadable hosts by that code —
    // and a reader finally learns WHY without the sniffer having to guess.
    const fetchImpl = refused({ "x-brd-error": "requested site was blocked", "x-brd-status-code": "403" })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const s = sniff(await f.get("https://stripe.com/radar", "unlocked"))
    expect(s.status).toBe("blocked")
    expect(s.reason).toBe("empty-body")
    expect(s.detail).toBe("requested site was blocked (upstream 403)")
  })
})

describe("brightDataSearch timeouts", () => {
  it("abandons a page that will not answer, and charges nothing for it", async () => {
    // Measured: in a worker pool, thirty of forty queries finished in 43s and
    // the last ten took 133s. A page that hangs holds a worker for minutes and
    // returns nothing its siblings did not already return.
    const fetchImpl = vi.fn((_u: unknown, init: unknown) => {
      const signal = (init as RequestInit).signal
      return new Promise<Response>((_res, rej) => {
        signal?.addEventListener("abort", () => {
          const e = new Error("timed out")
          e.name = "TimeoutError"
          rej(e)
        })
      })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, timeoutMs: 1_000 })
    const [r] = await s.search(["slow one"])
    expect(r!.ok).toBe(false)
    expect(r!.error).toContain("gave up")
    expect(r!.usd).toBe(0)
  })

  it("keeps the pages that did answer when one of them times out", async () => {
    let n = 0
    const fetchImpl = vi.fn((_u: unknown, init: unknown) => {
      n += 1
      if (n === 2) {
        const signal = (init as RequestInit).signal
        return new Promise<Response>((_res, rej) => {
          signal?.addEventListener("abort", () => {
            const e = new Error("timed out")
            e.name = "TimeoutError"
            rej(e)
          })
        })
      }
      return Promise.resolve(
        new Response(JSON.stringify({ organic: [{ link: `https://a${n}.com`, title: "t", description: "" }] }), { status: 200 }),
      )
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 3, timeoutMs: 1_000 })
    const [r] = await s.search(["x"])
    expect(r!.ok).toBe(true)
    expect(r!.hits).toHaveLength(2)
  })
})

describe("brightDataSearch error reporting", () => {
  /**
   * A run reported "42 failed" and nothing else while every response carried the
   * reason in a header: "response body was rejected" with an upstream 502.
   */
  it("reports the provider's own reason rather than a generic failure", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "x-brd-error": "response body was rejected", "x-brd-status-code": "502" },
        }),
    )
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    const [r] = await s.search(["anything"])
    expect(r!.ok).toBe(false)
    expect(r!.error).toContain("response body was rejected")
    expect(r!.error).toContain("502")
  })

  it("says the body was empty when there is no header to explain it", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("", { status: 200 }))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    const [r] = await s.search(["anything"])
    expect(r!.error).toContain("empty body")
  })

  it("carries the reason through on a non-2xx too", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 429, headers: { "x-brd-error": "cooldown, retry after 15 seconds" } }),
    )
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    const [r] = await s.search(["anything"])
    expect(r!.error).toContain("cooldown")
  })
})

describe("brightDataSearch retries", () => {
  /**
   * Measured: 42 of 44 searches came back "response body was rejected" with an
   * upstream 502, and the same query twenty seconds later returned eight
   * results. The zone was throttling, not broken.
   */
  it("retries a refusal that names its own retry interval", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n += 1
      return n === 1
        ? new Response("", { status: 200, headers: { "x-brd-error": "response body was rejected", "x-brd-status-code": "502" } })
        : new Response(JSON.stringify({ organic: [{ link: "https://a.com", title: "A", description: "" }] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    const [r] = await s.search(["x"])
    expect(r!.ok).toBe(true)
    expect(r!.hits).toHaveLength(1)
    // Both requests were serviced, so both are billed.
    expect(r!.usd).toBeCloseTo(0.003)
  })

  it("does not retry a failure that will not fix itself", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response("nope", { status: 401 }))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    await s.search(["x"])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("gives up after one retry rather than hammering a dead zone", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200, headers: { "x-brd-error": "response body was rejected" } }),
    )
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    const [r] = await s.search(["x"])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(r!.ok).toBe(false)
  })
})

describe("serp zone rotation", () => {
  it("spreads calls across every zone it was given", async () => {
    const zones: string[] = []
    const fetchImpl = vi.fn(async (_u: unknown, init: unknown) => {
      zones.push((JSON.parse((init as RequestInit).body as string) as { zone: string }).zone)
      return new Response(JSON.stringify({ organic: [] }), { status: 200 })
    })
    const s = brightDataSearch(
      { ...creds, serpZone: "one, two" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 },
    )
    await s.search(["a", "b", "c", "d"])
    expect(new Set(zones)).toEqual(new Set(["one", "two"]))
    expect(zones.filter((z) => z === "one")).toHaveLength(2)
  })

  it("still works with a single zone, unchanged", async () => {
    const fetchImpl = vi.fn(async (..._: FetchArgs) => new Response(JSON.stringify({ organic: [] }), { status: 200 }))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 })
    const [r] = await s.search(["a"])
    expect(r!.ok).toBe(true)
  })
})

describe("brightDataSearch obeys a stated rate limit", () => {
  /**
   * Measured: the account was auto-throttled with "please decrease your request
   * rate to 10/min", and the client kept firing eighty concurrent requests into
   * it — which holds the success rate down, which keeps the throttle on.
   */
  it("paces itself once the provider names a rate", async () => {
    const at: number[] = []
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      at.push(Date.now())
      n += 1
      return n === 1
        ? new Response("", {
            status: 200,
            headers: { "x-brd-error": "The request was auto-throttled due to low success rate. Please decrease your request rate to 600/min." },
          })
        : new Response(JSON.stringify({ organic: [{ link: "https://a.com", title: "A", description: "" }] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    await s.search(["a", "b", "c"])
    // 600/min at 90% → a ~111ms gap. The later calls must not all land at once.
    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    expect(Math.max(...gaps)).toBeGreaterThan(50)
  })

  it("does not pace at all until something reports a throttle", async () => {
    const at: number[] = []
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      at.push(Date.now())
      return new Response(JSON.stringify({ organic: [] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 })
    const t0 = Date.now()
    await s.search(["a", "b", "c", "d"])
    // Healthy account: four calls concurrent, essentially instant.
    expect(Date.now() - t0).toBeLessThan(300)
  })

  /**
   * THE PENALTY EXPIRES. `minGapMs` only ever rose, so one throttle — and the
   * provider throttles for LOW SUCCESS RATE, which a bad five minutes
   * triggers — serialized every remaining request of the run at 6.7s apart,
   * forever. MEASURED on a brightdata map: 706 requests took 37 minutes at an
   * effective concurrency of 1.5 against a pool configured for 32.
   */
  it("recovers the pace once the provider stops complaining", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n += 1
      return n === 1
        ? new Response("", {
            status: 200,
            headers: { "x-brd-error": "auto-throttled, decrease your request rate to 120/min" },
          })
        : new Response(JSON.stringify({ organic: [{ link: "https://a.com", title: "A", description: "" }] }), { status: 200 })
    })
    // 120/min at 90% is a 556ms gap, and the recovery window is shortened from
    // 45s to 2s so the test proves the behaviour rather than waiting it out.
    // The window must stay well ABOVE the gap, as it is in production (45s
    // against a 16s retry wait), or the retry's own pause spends it.
    const s = brightDataSearch(creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pages: 1,
      retryMs: 0,
      recoverMs: 2_000,
    })

    // The throttle lands, and the gap is real: two queries cannot both go now.
    await s.search(["a"])
    const pacedStart = Date.now()
    await s.search(["b", "c"])
    expect(Date.now() - pacedStart).toBeGreaterThan(200)

    // Successes keep arriving and the window elapses, so the penalty decays to
    // nothing and a wave goes concurrently again.
    await new Promise((r) => setTimeout(r, 2_100))
    await s.search(["d"])
    await new Promise((r) => setTimeout(r, 2_100))
    await s.search(["e"])
    const freeStart = Date.now()
    await s.search(["f", "g", "h", "i"])
    expect(Date.now() - freeStart).toBeLessThan(200)
  }, 15_000)

  it("reports the throttle text rather than a generic failure", async () => {
    const fetchImpl = vi.fn(
      async () =>
        // A fast stated rate so the pacing gap stays inside the test timeout.
        // At "10/min" this correctly waits 6.7 seconds, which is the point.
        new Response("", { status: 200, headers: { "x-brd-error": "auto-throttled, decrease your request rate to 6000/min" } }),
    )
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    const [r] = await s.search(["x"])
    expect(r!.ok).toBe(false)
    expect(r!.error).toContain("throttled")
  })

  /**
   * Measured: the "auto-throttled" sentence never opens a bad stretch, it
   * only confirms one already in progress — the stored runs show a run of
   * plain rejections before the account ever names a rate. Proactively
   * narrowing the pace on that trend, rather than waiting for the message,
   * is what this proves: a sagging success rate over a real window of
   * requests paces new work even though `x-brd-error` never once fired.
   */
  it("narrows the pace on a sagging success rate, before any throttle message", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n += 1
      // 5 plain failures (no x-brd-error at all) in a window of 20 — a 75%
      // success rate, under the 85% floor, with nothing for THROTTLED or
      // RETRYABLE to match so none of them retries.
      return n <= 5
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ organic: [] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })

    // Fills the rolling window: 20 distinct queries, one request each.
    await s.search(Array.from({ length: 20 }, (_, i) => `q${i}`))
    expect(fetchImpl).toHaveBeenCalledTimes(20)

    // No x-brd-error was ever sent, so this is the proactive signal alone.
    const pacedStart = Date.now()
    await s.search(["y", "z"])
    expect(Date.now() - pacedStart).toBeGreaterThan(500)
  })

  it("stays concurrent on an equally mixed run that never crosses the floor", async () => {
    let n = 0
    const fetchImpl = vi.fn(async (..._: FetchArgs) => {
      n += 1
      // 3 failures in 20 — an 85% success rate, exactly at the floor and not
      // below it.
      return n <= 3
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ organic: [] }), { status: 200 })
    })
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1, retryMs: 0 })
    await s.search(Array.from({ length: 20 }, (_, i) => `q${i}`))

    const t0 = Date.now()
    await s.search(["y", "z"])
    expect(Date.now() - t0).toBeLessThan(300)
  })
})
