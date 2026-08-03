import { describe, it, expect } from "vitest"
import { EvidenceStore, CitationError } from "../src/evidence.js"

const NOW = () => "2026-08-03T10:00:00.000Z"

describe("EvidenceStore", () => {
  it("mints a citation whose quote is present in fetched bytes", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    const ev = s.cite(rec.handle, "anti-bot bypass APIs")
    expect(ev.url).toBe("https://a.com/p")
    expect(ev.quote).toBe("anti-bot bypass APIs")
    expect(ev.status).toBe("found")
    expect(ev.fetchedAt).toBe("2026-08-03T10:00:00.000Z")
  })

  it("refuses a quote that is not in the fetched bytes", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells proxies.", status: "found" })
    expect(() => s.cite(rec.handle, "Acme raised $50M")).toThrow(CitationError)
  })

  it("refuses a citation against an unknown handle", () => {
    const s = new EvidenceStore(NOW)
    expect(() => s.cite("ev999", "anything")).toThrow(CitationError)
  })

  it("refuses to cite a page that was blocked", () => {
    // A blocked page has no bytes to prove anything with.
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://stripe.com/radar", text: "", status: "blocked", reason: "empty-body" })
    expect(() => s.cite(rec.handle, "anything")).toThrow(CitationError)
  })

  it("normalises whitespace when matching so wrapped quotes still verify", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "we assemble\n  printed circuit  boards", status: "found" })
    expect(() => s.cite(rec.handle, "assemble printed circuit boards")).not.toThrow()
  })

  it("knows whether a url was fetched, across spelling differences", () => {
    const s = new EvidenceStore(NOW)
    s.record({ url: "https://WWW.A.com/p/", text: "x".repeat(50), status: "found" })
    expect(s.hasFetched("https://a.com/p")).toBe(true)
    expect(s.hasFetched("https://a.com/other")).toBe(false)
  })
})
