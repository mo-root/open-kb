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
