import { describe, it, expect, vi } from "vitest"
import { brightDataSearch, brightDataFetch } from "../src/brightdata.js"

const creds = { token: "t", serpZone: "serp", unlockerZone: "unlock" }

describe("brightDataSearch", () => {
  it("asks google for parsed json and maps organic results", async () => {
    const fetchSpy = vi.fn(async () =>
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
    const fetchImpl = vi.fn(async () => {
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
    expect(r!.usd).toBeCloseTo(0.0045) // billed per page, because each page is a call
  })

  it("keeps a query that only partly failed, rather than discarding what it got", async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
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

describe("brightDataFetch", () => {
  it("uses no proxy at all for direct mode", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "direct")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://a.com")
    expect(r.usd).toBe(0)
    expect(r.body).toBe("hello")
  })

  it("routes unlocked mode through the unlocker zone and prices it", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>ok</html>", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.brightdata.com/request")
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.zone).toBe("unlock")
    expect(r.usd).toBeGreaterThan(0)
  })

  it("returns a zero-byte 200 unchanged so the sniffer can judge it", async () => {
    // measured: this is exactly what stripe.com does. The provider must not paper over it.
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
  })

  it("does not throw and charges nothing when direct mode never gets a response", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND a.com")
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "direct")
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
  })

  it("does not throw and charges nothing when the unlocked request never reaches Bright Data", async () => {
    // A connection that never opens (DNS failure, reset, timeout before any response) is a
    // call Bright Data never billed, unlike a completed request that comes back as a 500,
    // which stays priced. Charging for this would corrupt the run's cost accounting.
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed: connection reset")
    })
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://a.com", "unlocked")
    expect(r.httpStatus).toBe(0)
    expect(r.usd).toBe(0)
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
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }))
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
    const fetchImpl = vi.fn(async () => {
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
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }))
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ organic: [] }), { status: 200 }))
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch, pages: 1 })
    const [r] = await s.search(["a"])
    expect(r!.ok).toBe(true)
  })
})
