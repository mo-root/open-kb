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
    // Blocked pages are not citable because the fetch did not succeed, not because a blocked
    // page never has text. (A thin-render block, for example, can carry up to ~199 characters of
    // real text; see the next test.) This particular case just happens to have none either.
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://stripe.com/radar", text: "", status: "blocked", reason: "empty-body" })
    expect(() => s.cite(rec.handle, "anything")).toThrow(CitationError)
  })

  it("refuses to cite a blocked page even when it carries real, substantial, quotable text", () => {
    // This is the test that would actually fail if the status gate were weakened or removed:
    // the text below contains a genuine >=8-character substring, so only the status check
    // stands between this quote and a minted Evidence.
    const s = new EvidenceStore(NOW)
    const rec = s.record({
      url: "https://a.com/app",
      text: "Please enable JavaScript to view this page correctly.",
      status: "blocked",
      reason: "thin-render",
    })
    expect(() => s.cite(rec.handle, "enable JavaScript")).toThrow(CitationError)
  })

  it("refuses to cite a not-found page even when it carries real, substantial, quotable text", () => {
    // Same guarantee for not_found: a soft-404 can carry genuine HTML-derived text. It is not
    // citable because the fetch did not resolve to the real resource, not because it was empty.
    const s = new EvidenceStore(NOW)
    const rec = s.record({
      url: "https://a.com/missing",
      text: "The page you requested could not be found on this server.",
      status: "not_found",
      reason: "soft-404",
    })
    expect(() => s.cite(rec.handle, "could not be found")).toThrow(CitationError)
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

  it("refuses a quote that is empty after whitespace normalisation", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    expect(() => s.cite(rec.handle, "")).toThrow(CitationError)
  })

  it("refuses a quote that is only whitespace", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    expect(() => s.cite(rec.handle, "   \n  ")).toThrow(CitationError)
  })

  it("refuses a quote just under the minimum length, even when it is a genuine substring", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    // "Acme se" is 7 characters and is a real substring of the stored text, length alone must refuse it.
    expect(() => s.cite(rec.handle, "Acme se")).toThrow(CitationError)
  })

  it("accepts a quote at exactly the minimum length", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    // "Acme sel" is 8 characters and is a real substring of the stored text.
    expect(() => s.cite(rec.handle, "Acme sel")).not.toThrow()
  })

  it("measures the minimum length after squashing whitespace, closing the padding workaround", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text: "Acme sells anti-bot bypass APIs.", status: "found" })
    // Raw length is 9 (>= 8), but it squashes down to "a b" (3 chars), the length that matters.
    expect(() => s.cite(rec.handle, "a       b")).toThrow(CitationError)
  })
})
