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
    const s = brightDataSearch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const rs = await s.search(["bad", "good"])
    expect(rs[0]!.ok).toBe(false)
    expect(rs[1]!.ok).toBe(true)
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
    // MEASURED: this is exactly what stripe.com does. The provider must not paper over it.
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }))
    const f = brightDataFetch(creds, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
  })
})
