import { describe, it, expect } from "vitest"
import { EvidenceStore, CitationError, checkQuote } from "../src/evidence.js"

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

  it("drops the parenthetical when a non-found record carries no reason", () => {
    // `reason` is optional on FetchRecord (every production sniff.ts path fills it, but the
    // type does not require it), and the message builds it as `${status}${reason ? " (...)" : ""}`.
    // Every other status-gate test above supplies a reason, so this ternary's false side had
    // never run: nothing pinned that an omitted reason renders as a bare status, not "undefined"
    // or a dangling " ()".
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/missing", text: "gone", status: "not_found" })
    expect(() => s.cite(rec.handle, "anything")).toThrow(`cannot cite ${rec.handle}: page was not_found`)
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

/**
 * The mint's containment check, exported on its own so the sweep's span
 * verification and the mint stay ONE implementation. If these two ever
 * disagree, a span the kernel verified could fail the mint or vice versa —
 * the exact drift the export exists to prevent.
 */
describe("checkQuote", () => {
  const text = "Acme sells anti-bot bypass APIs.\n  We also   resell proxies."

  it("accepts a quote that is a literal substring", () => {
    expect(checkQuote(text, "anti-bot bypass APIs")).toBe("ok")
  })

  it("matches with the mint's own squash: case and wrapped whitespace do not matter", () => {
    expect(checkQuote(text, "ALSO RESELL proxies")).toBe("ok")
    expect(checkQuote(text, "also\n  resell   proxies")).toBe("ok")
  })

  it("refuses a paraphrase — containment is literal, not semantic", () => {
    expect(checkQuote(text, "sells proxy products")).toBe("absent")
  })

  it("refuses a quote under the mint's minimum, measured after squashing", () => {
    expect(checkQuote(text, "Acme se")).toBe("too-short")
    expect(checkQuote(text, "a       b")).toBe("too-short")
  })

  it("agrees with cite() on both edges of the minimum", () => {
    const s = new EvidenceStore(NOW)
    const rec = s.record({ url: "https://a.com/p", text, status: "found" })
    expect(checkQuote(text, "Acme sel")).toBe("ok")
    expect(() => s.cite(rec.handle, "Acme sel")).not.toThrow()
    expect(checkQuote(text, "Acme se")).toBe("too-short")
    expect(() => s.cite(rec.handle, "Acme se")).toThrow(CitationError)
  })
})
