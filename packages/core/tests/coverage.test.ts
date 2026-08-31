import { describe, it, expect } from "vitest"
import { answerKeyRecall, escapeRe, namesHost } from "../src/coverage.js"

const page = (vendors: string[], namesAnchor = true) => ({
  url: "https://listicle.com/best",
  html:
    (namesAnchor ? "The top pick is anchor.com. " : "") +
    vendors.map((v) => `<a href="https://${v}/x">${v}</a>`).join(" "),
})

describe("answerKeyRecall", () => {
  it("scores map coverage against a probe page's vendor list", () => {
    const r = answerKeyRecall([page(["a.com", "b.com", "c.com", "d.com", "e.com"])], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com", "b.com", "c.com"]),
      minVendors: 5,
    })
    expect(r.probes).toHaveLength(1)
    expect(r.probes[0]!.recall).toBeCloseTo(0.6)
    expect(r.pooled).toBeCloseTo(0.6)
  })
  it("ignores pages that do not name the anchor", () => {
    const r = answerKeyRecall([page(["a.com", "b.com", "c.com", "d.com", "e.com"], false)], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com"]),
    })
    expect(r.probes).toHaveLength(0)
    expect(r.pooled).toBeNull()
  })
  it("ignores pages listing fewer than minVendors", () => {
    const r = answerKeyRecall([page(["a.com", "b.com"])], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com"]),
      minVendors: 5,
    })
    expect(r.probes).toHaveLength(0)
  })
  it("excludes the anchor and the probe's own host from the key", () => {
    const r = answerKeyRecall(
      [{ url: "https://listicle.com/best", html: `anchor.com <a href="https://anchor.com/"><a href="https://listicle.com/other"><a href="https://a.com/"><a href="https://b.com/"><a href="https://c.com/"><a href="https://d.com/"><a href="https://e.com/">` }],
      { anchor: "anchor.com", mapHosts: new Set(["a.com"]), minVendors: 5 },
    )
    expect(r.probes[0]!.vendors).not.toContain("anchor.com")
    expect(r.probes[0]!.vendors).not.toContain("listicle.com")
  })
  it("does not qualify a page where the anchor only appears inside another domain", () => {
    const r = answerKeyRecall(
      [{ url: "https://x.com/best", html: `radio.com is great <a href="https://a.com/"><a href="https://b.com/"><a href="https://c.com/"><a href="https://d.com/"><a href="https://e.com/">` }],
      { anchor: "io.com", mapHosts: new Set(["a.com"]) },
    )
    expect(r.probes).toHaveLength(0)
  })
  it("still matches the anchor followed by a path or punctuation", () => {
    const r = answerKeyRecall(
      [{ url: "https://x.com/best", html: `see anchor.com/pricing. <a href="https://a.com/"><a href="https://b.com/"><a href="https://c.com/"><a href="https://d.com/"><a href="https://e.com/">` }],
      { anchor: "anchor.com", mapHosts: new Set(["a.com"]) },
    )
    expect(r.probes).toHaveLength(1)
  })
  it("never emits NaN recall even at minVendors 0", () => {
    const r = answerKeyRecall([{ url: "https://x.com/", html: "anchor.com" }], { anchor: "anchor.com", mapHosts: new Set(), minVendors: 0 })
    expect(r.probes.length).toBeGreaterThan(0)
    expect(r.probes.every((p) => Number.isFinite(p.recall))).toBe(true)
  })
  // The host-exclusion pass only runs when anchorAliases is set (sweep.ts and
  // orchestrator.ts both always pass it, which is why this line reads
  // covered in the full suite despite this file never exercising it on its
  // own — but answerKeyRecall is exported public API, and probePages' url is
  // not always the `https://${host}/` shape judgeHosts constructs: nothing
  // stops a future or test caller from handing it something new URL() can't
  // parse. The catch's own comment says the contract for that case: "nothing
  // to exclude by host" — nothing crashes, and the page is just not excluded
  // by host, not silently dropped.
  it("does not throw on an unparseable probe url, and does not exclude it by host", () => {
    const r = answerKeyRecall([{ url: "not a valid url", html: page(["a.com", "b.com", "c.com", "d.com", "e.com"]).html }], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com"]),
      minVendors: 5,
      anchorAliases: new Set(["alias.com"]),
    })
    expect(r.probes).toHaveLength(1)
    expect(r.probes[0]!.url).toBe("not a valid url")
  })
  // aliasHosts.length === 1 ? "it" : "them" (coverage.ts:108) had only ever
  // seen the singular side: every other caller of anchorAliases in this file
  // and in alias.test.ts passes exactly one alias host (the brightdata.com/.es
  // ccTLD pair), so "them" had never run anywhere in the suite.
  it("says \"them\", not \"it\", when the alias set excludes more than one host", () => {
    const r = answerKeyRecall([page(["a.com", "b.com", "c.com", "d.com", "e.com"])], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com"]),
      minVendors: 5,
      anchorAliases: new Set(["alias1.com", "alias2.com"]),
    })
    expect(r.aliasExclusion?.hosts).toEqual(["alias1.com", "alias2.com"])
    expect(r.aliasExclusion?.note).toContain("them")
    expect(r.aliasExclusion?.note).not.toMatch(/\bit\b/)
  })
})

/**
 * The boundary semantics answerKeyRecall always had, exported so the probe
 * gate in sweep's rank pass can share them instead of re-deriving them as a
 * bare substring check — which over-collects: "io.com" is inside "radio.com".
 */
describe("namesHost", () => {
  it("does not match the host inside a larger token", () => {
    expect(namesHost("radio.com is great", "io.com")).toBe(false)
    expect(namesHost("bright-sdk.com ships today", "sdk.com")).toBe(false)
  })
  it("matches the host as a word of its own", () => {
    expect(namesHost("we compared io.com against five rivals", "io.com")).toBe(true)
  })
  it("matches the host followed by a path or punctuation", () => {
    expect(namesHost("see io.com/pricing.", "io.com")).toBe(true)
  })
  it("is case-insensitive, pages shout and hosts do not", () => {
    expect(namesHost("IO.COM is our top pick", "io.com")).toBe(true)
  })
  it("matches at the very start and very end of the text", () => {
    expect(namesHost("io.com leads the pack", "io.com")).toBe(true)
    expect(namesHost("the pack is led by io.com", "io.com")).toBe(true)
  })
  it("treats the host's own dot as a literal, not a regex wildcard", () => {
    // Every case above uses a real hostname, so an unescaped "." (which matches
    // any character as a regex wildcard) would pass them all the same — the
    // dot always sits between two real characters in the fixture text too.
    // This is the one case that tells the two apart: "a.com" must not match
    // "aXcom", where an unescaped "." would.
    expect(namesHost("check out aXcom for pricing", "a.com")).toBe(false)
    expect(namesHost("check out a.com for pricing", "a.com")).toBe(true)
  })
})

/**
 * escapeRe is shared by namesHost above and by grounding.ts's span matcher
 * (`grounding.ts:41`) so the two cannot drift on what counts as a literal —
 * neither caller tested it directly before this. The property that matters
 * is not "it inserts backslashes" but that the escaped string, dropped into
 * `new RegExp()`, matches only the exact original text and nothing a
 * metacharacter reading of it would additionally match.
 */
describe("escapeRe", () => {
  it("escapes every regex metacharacter it lists", () => {
    expect(escapeRe(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\")
  })
  it("leaves ordinary characters untouched", () => {
    expect(escapeRe("a-b_c 123")).toBe("a-b_c 123")
  })
  it("round-trips through RegExp to match only the literal string", () => {
    for (const raw of ["a.com", "sdk.com", "a+b.io", "weird[host].com", "a(b).com"]) {
      const re = new RegExp(`^${escapeRe(raw)}$`)
      expect(re.test(raw)).toBe(true)
      // The mangled form a metacharacter reading would additionally accept —
      // "." as any-char, "+" as one-or-more, "[...]" as a class — must not match.
      expect(re.test(raw.replace(/[.+[\]()]/g, "X"))).toBe(false)
    }
  })
})
