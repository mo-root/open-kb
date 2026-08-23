import { describe, it, expect } from "vitest"
import { textDigest, addressKey, echoFoldedDigest, strongerTier, originKey } from "../src/run-evidence.js"

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
