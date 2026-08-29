import { describe, it, expect } from "vitest"
import { textDigest, addressKey, echoFoldedDigest, strongerTier, originKey, RunEvidence, MAX_STORED_BYTES } from "../src/run-evidence.js"

/**
 * `RunEvidence`'s five pure key functions had zero direct test coverage
 * anywhere — grep for each name across packages/swarm/tests turns up only
 * `hasText`/`hasAddress`/`admit` exercising them indirectly through the class
 * (run-evidence-alias.test.ts covers `recallProbePool`, which is a different
 * export of this file). `strongerTier` and `originKey` are even re-exported
 * from the package's public `index.ts` with no caller in this repo pinning
 * their contract. D-scope sweep continuing from SELF-20 (orchestrator.ts):
 * moved to run-evidence.ts, the next named area with an uncovered surface.
 */

describe("textDigest: a page's content, independent of its markup", () => {
  it("collapses whitespace, so a differently-indented re-render is the same page", () => {
    expect(textDigest("hello   world")).toBe(textDigest("hello world"))
    expect(textDigest("  hello\n\nworld  ")).toBe(textDigest("hello world"))
  })

  it("differs on different content", () => {
    expect(textDigest("hello world")).not.toBe(textDigest("hello there"))
  })
})

describe("addressKey: the place a page was read, not the URL string that reached it", () => {
  it("drops the query string", () => {
    expect(addressKey("https://a.com/x?q=1")).toBe(addressKey("https://a.com/x"))
  })

  it("folds duplicate and trailing slashes", () => {
    expect(addressKey("https://a.com//x//y/")).toBe(addressKey("https://a.com/x/y"))
  })

  it("folds a subdomain to the registrable host, same as docs.a.com and a.com sharing one address space", () => {
    expect(addressKey("https://docs.a.com/api")).toBe(addressKey("https://a.com/api"))
  })

  it("lowercases the path", () => {
    expect(addressKey("https://a.com/X")).toBe(addressKey("https://a.com/x"))
  })

  it("falls back to the trimmed lowercase string when the URL does not parse", () => {
    expect(addressKey("Not-A-URL")).toBe("not-a-url")
  })

  it("does not throw on an undecodable escape — the raw path is the honest key", () => {
    expect(() => addressKey("https://a.com/100%")).not.toThrow()
    expect(addressKey("https://a.com/100%")).toBe("a.com/100%")
  })
})

describe("echoFoldedDigest: the digest a soft-404 template cannot escape", () => {
  it("masks the requested path out of the body, so two different missing paths on one template fold to one digest", () => {
    const urlA = "https://shop.example.com/products/abc-123"
    const textA = "Sorry, /products/abc-123 was not found. Browse our catalog."
    const urlB = "https://shop.example.com/products/xyz-999"
    const textB = "Sorry, /products/xyz-999 was not found. Browse our catalog."
    expect(echoFoldedDigest(textA, urlA)).toBe(echoFoldedDigest(textB, urlB))
  })

  it("masks case-insensitively — a template that title-cases the missing path is the same template", () => {
    const got = echoFoldedDigest("before abc after", "https://a.com/ABC")
    expect(got).toBe(textDigest("before after"))
  })

  it("falls back to a plain content digest when the URL does not parse", () => {
    const text = "some text here"
    expect(echoFoldedDigest(text, "not a url")).toBe(textDigest(text))
  })

  it("leaves an unrelated body untouched — it masks the echo, not the content", () => {
    const text = "totally unrelated content"
    expect(echoFoldedDigest(text, "https://a.com/some/path")).toBe(textDigest(text))
  })
})

describe("strongerTier: own-page beats page beats snippet", () => {
  it("keeps the stronger of two tiers, either order", () => {
    expect(strongerTier("page", "own-page")).toBe("own-page")
    expect(strongerTier("own-page", "page")).toBe("own-page")
    expect(strongerTier("snippet", "page")).toBe("page")
  })

  it("a tie returns either — they are equal", () => {
    expect(strongerTier("page", "page")).toBe("page")
  })
})

describe("originKey: the registrable host a URL's bytes came from", () => {
  it("folds a subdomain the same way addressKey does", () => {
    expect(originKey("https://docs.a.com/x")).toBe("a.com")
  })

  it("is empty, not a throw, when the URL does not parse", () => {
    expect(originKey("not a url")).toBe("")
  })
})

/**
 * SELF-134, D-scope, self-discovered. `record`'s own comment states the
 * invariant: "`rec.text` is already the MAX_STORED_BYTES slice, and `hasText`
 * asks about the same slice: a capped page must not digest one way going in
 * and another coming out." Nothing in this repo hands either method text at
 * or past the 4MB cap — every fixture across packages/swarm/tests tops out at
 * a few KB (`tools-paid.test.ts`'s largest is 2,000 repeats of "real words ",
 * a few tens of KB) — so the slice-consistency the comment promises had never
 * actually run.
 */
describe("RunEvidence.record + hasText: an over-cap page digests the same way going in and coming back out", () => {
  it("caps stored text at MAX_STORED_BYTES and recognizes a re-read of the identical over-cap bytes", () => {
    const url = "https://huge.example.com/page"
    // Content past the cap boundary that would leak into the digest if record()
    // and hasText() ever sliced to different lengths.
    const overCap = "a".repeat(MAX_STORED_BYTES) + "TAIL THAT MUST NEVER BE DIGESTED"
    const evidence = new RunEvidence()
    const rec = evidence.record({ url, text: overCap, status: "found", tier: "page" })

    expect(rec.text.length).toBe(MAX_STORED_BYTES)
    // A re-fetch handing back the same over-cap bytes under the same url is the
    // exact case the comment is about: without matching slices this returns false
    // and the run pays to re-read a giant page it already holds.
    expect(evidence.hasText(overCap, url)).toBe(true)
  })

  it("still tells two over-cap pages apart when they differ before the cap boundary", () => {
    const url = "https://huge.example.com/page"
    const evidence = new RunEvidence()
    evidence.record({ url, text: "a".repeat(MAX_STORED_BYTES), status: "found", tier: "page" })

    // Proves the pass above isn't vacuous — hasText does not just return true for
    // any text this long, only for the ones whose first MAX_STORED_BYTES bytes match.
    expect(evidence.hasText("b".repeat(MAX_STORED_BYTES), url)).toBe(false)
  })
})

/**
 * SELF-168, D-scope, self-discovered, continuing SELF-134's own sweep of this
 * file. That commit covered the five pure key functions and one class-level
 * behaviour (the over-cap `record`/`hasText` slice invariant), and named its
 * own limit: "hasText/hasAddress/admit exercising them indirectly through the
 * class". `pending`, `land`, `isPending`, `handlesFor`, `cite`, `ownPage`,
 * `hasAddress`, `snippetFor` and `unread` are exactly that indirect case —
 * grep for each as a `.name(` call across every test directory turns up
 * nothing but their production callers (tools-paid.ts's fetch/harvest paths,
 * tools-free.ts's read/harvest paths, orchestrator.ts's admit gate). Each is
 * live, load-bearing code with no test that pins its contract on its own
 * terms rather than through a tool wrapper's fixtures.
 */
describe("RunEvidence.pending/land/isPending: the promise cell for a fetch still in flight", () => {
  it("is pending until land(), and isPending flips false once it does", () => {
    const evidence = new RunEvidence()
    const handle = evidence.pending("https://a.com/x")
    expect(evidence.isPending(handle)).toBe(true)
    evidence.land(handle, { url: "https://a.com/x", text: "hello world, more than eight chars", status: "found", tier: "page" })
    expect(evidence.isPending(handle)).toBe(false)
  })

  it("a pending handle resolves through to the record land() produced", () => {
    const evidence = new RunEvidence()
    const handle = evidence.pending("https://a.com/x")
    expect(evidence.get(handle)).toBeUndefined()
    const landed = evidence.land(handle, { url: "https://a.com/x", text: "hello world, more than eight chars", status: "found", tier: "page" })
    expect(evidence.get(handle)).toEqual(landed)
  })

  it("isPending is false for a handle that was never minted pending", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://a.com/x", text: "hello world", status: "found", tier: "page" })
    expect(evidence.isPending(rec.handle)).toBe(false)
  })
})

describe("RunEvidence.handlesFor: every handle recorded for one URL, in arrival order", () => {
  it("returns [] for a URL never fetched", () => {
    const evidence = new RunEvidence()
    expect(evidence.handlesFor("https://a.com/x")).toEqual([])
  })

  it("collects every record under the URL's canonical form, oldest first", () => {
    const evidence = new RunEvidence()
    const first = evidence.record({ url: "https://a.com/x", text: "one two three four", status: "found", tier: "snippet" })
    const second = evidence.record({ url: "https://a.com/x", text: "five six seven eight", status: "found", tier: "page" })
    expect(evidence.handlesFor("https://a.com/x")).toEqual([first.handle, second.handle])
  })

  it("folds a different spelling of the same URL to one canonical key", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://www.a.com/x/", text: "one two three four", status: "found", tier: "page" })
    expect(evidence.handlesFor("https://a.com/x")).toEqual([rec.handle])
  })
})

describe("RunEvidence.cite: strongest record first, ties go to the newer one", () => {
  it("prefers a found page over a found snippet recorded for the same URL", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "the snippet text says something else entirely", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/x", text: "the page text names the real quote right here", status: "found", tier: "page" })
    const r = evidence.cite("https://a.com/x", "names the real quote")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.evidence.tier).toBe("page")
  })

  it("falls back to a weaker record when the strongest one does not contain the quote", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "the snippet text carries the real quote here", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/x", text: "the page text says something unrelated", status: "found", tier: "page" })
    const r = evidence.cite("https://a.com/x", "carries the real quote")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.evidence.tier).toBe("snippet")
  })

  it("prefers the newer record within the same tier — the two share a canonical but not a spelling", () => {
    const evidence = new RunEvidence()
    // Trailing slash folds to the same canonical (`canonicalUrl`), so both
    // land under one `handlesFor` key, but `rec.url` keeps the raw spelling —
    // which one `cite` returns tells apart the older from the newer.
    evidence.record({ url: "https://a.com/x/", text: "shared quote text here", status: "found", tier: "page" })
    evidence.record({ url: "https://a.com/x", text: "shared quote text here", status: "found", tier: "page" })
    const r = evidence.cite("https://a.com/x", "shared quote text")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.evidence.url).toBe("https://a.com/x")
  })

  it("when every record fails, reports the strongest one's own failure first", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x/", text: "the snippet text, unrelated to the quote asked for", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/x", text: "the page text, also unrelated to the quote asked for", status: "found", tier: "page" })
    const r = evidence.cite("https://a.com/x", "not present anywhere at all")
    expect(r.ok).toBe(false)
    // The page (stronger) is tried first, and its own message names ITS url —
    // no trailing slash — proving the snippet's failure was never reached.
    if (!r.ok) expect(r.reason).toBe("quote not present in https://a.com/x")
  })

  it("passes the mint's own refusal through verbatim for an unreadable page", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "", status: "not_found", reason: "404", tier: "page" })
    const r = evidence.cite("https://a.com/x", "anything at all")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("cannot cite ev1: page was not_found (404)")
  })

  it("names the URL and asks for a fetch first when nothing was ever recorded for it", () => {
    const evidence = new RunEvidence()
    const r = evidence.cite("https://never-fetched.com/", "anything")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("nothing was fetched from https://never-fetched.com/")
  })
})

describe("RunEvidence.ownPage: a found page fetched from the host's own site", () => {
  it("returns null when the run never read a page from that host", () => {
    const evidence = new RunEvidence()
    expect(evidence.ownPage("a.com")).toBeNull()
  })

  it("matches any found page on the registrable host, not only the front page", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/pricing", text: "our pricing page", status: "found", tier: "page" })
    expect(evidence.ownPage("a.com")?.url).toBe("https://a.com/pricing")
  })

  it("ignores a snippet-tier record — reading ABOUT the host is not reading its own page", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/pricing", text: "snippet about pricing", status: "found", tier: "snippet" })
    expect(evidence.ownPage("a.com")).toBeNull()
  })

  it("folds a subdomain to the registrable host", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://docs.a.com/api", text: "the docs page", status: "found", tier: "page" })
    expect(evidence.ownPage("a.com")?.url).toBe("https://docs.a.com/api")
  })
})

describe("RunEvidence.hasAddress: has this run already read a page at this address", () => {
  it("is false before anything is recorded", () => {
    const evidence = new RunEvidence()
    expect(evidence.hasAddress("https://a.com/x")).toBe(false)
  })

  it("is true after a found page lands at that address, whatever query string is asked with", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "hello world", status: "found", tier: "page" })
    expect(evidence.hasAddress("https://a.com/x?utm_source=foo")).toBe(true)
  })

  it("stays false for a snippet — only a fetched page occupies an address", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "hello world", status: "found", tier: "snippet" })
    expect(evidence.hasAddress("https://a.com/x")).toBe(false)
  })
})

describe("RunEvidence.snippetFor: the newest found snippet from a host", () => {
  it("returns null when the run never saw the host in a search", () => {
    const evidence = new RunEvidence()
    expect(evidence.snippetFor("a.com")).toBeNull()
  })

  it("returns the newest snippet when the host was seen more than once", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "older snippet", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/y", text: "newer snippet", status: "found", tier: "snippet" })
    expect(evidence.snippetFor("a.com")?.text).toBe("newer snippet")
  })

  it("ignores a page-tier record — this is the snippet-only fallback", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "the actual page", status: "found", tier: "page" })
    expect(evidence.snippetFor("a.com")).toBeNull()
  })
})

describe("RunEvidence.unread: harvestable pages nobody has opened yet", () => {
  it("lists a URL seen only as a snippet", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://a.com/x", text: "snippet text", status: "found", tier: "snippet" })
    expect(evidence.unread()).toEqual([{ url: "https://a.com/x", handle: rec.handle }])
  })

  it("drops a URL once it has also been fetched as a page", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/x", text: "snippet text", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/x", text: "page text", status: "found", tier: "page" })
    expect(evidence.unread()).toEqual([])
  })

  it("dedupes: a host seen in two searches lists once, under its first handle", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://a.com/x", text: "first snippet", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/x", text: "second snippet", status: "found", tier: "snippet" })
    expect(evidence.unread()).toEqual([{ url: "https://a.com/x", handle: rec.handle }])
  })
})
