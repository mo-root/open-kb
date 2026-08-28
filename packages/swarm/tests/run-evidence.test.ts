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
