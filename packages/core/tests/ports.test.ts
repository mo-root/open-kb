import { describe, it, expect } from "vitest"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"

describe("fake providers", () => {
  it("returns configured hits per query and reports cost", async () => {
    const s = new FakeSearch({ "web scraping api": [{ url: "https://x.com", title: "X", description: "scraping" }] })
    const [r] = await s.search(["web scraping api"])
    expect(r!.ok).toBe(true)
    expect(r!.hits[0]!.url).toBe("https://x.com")
    expect(r!.usd).toBeGreaterThan(0)
  })

  it("reports an unknown query as an empty but successful search", async () => {
    const s = new FakeSearch({})
    const [r] = await s.search(["nothing here"])
    expect(r!.ok).toBe(true)
    expect(r!.hits).toEqual([])
  })

  it("can be told to fail a specific query without failing the batch", async () => {
    const s = new FakeSearch({ good: [] }, { failing: ["bad"] })
    const rs = await s.search(["good", "bad"])
    expect(rs[0]!.ok).toBe(true)
    expect(rs[1]!.ok).toBe(false)
    expect(rs[1]!.error).toBeTruthy()
  })

  it("can simulate the measured 200-with-empty-body block", async () => {
    const f = new FakeFetch({ "https://stripe.com/radar": { httpStatus: 200, body: "" } })
    const r = await f.get("https://stripe.com/radar", "unlocked")
    expect(r.httpStatus).toBe(200)
    expect(r.body).toBe("")
  })
})
