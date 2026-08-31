import { describe, it, expect } from "vitest"
import { aliasSignals, aliasSets, anchorAliasSet } from "../src/alias.js"
import { answerKeyRecall } from "../src/coverage.js"

/**
 * The measured shape this seam exists for: an anchor whose ccTLD property
 * (brightdata.com / brightdata.es) was counted by the recall instrument as a
 * missed VENDOR. The fixtures here are that shape verbatim — the anchor's
 * page asserting its alternate, the alternate asserting back — because the
 * precision rule (one-sided is forgeable, a wrong merge destroys two
 * companies) is easiest to hold against the real case that motivated it.
 */

const page = (url: string, html: string) => ({ url, html })

const ANCHOR_HOME = page(
  "https://brightdata.com/",
  `<html><head>
    <link rel="alternate" hreflang="en" href="https://brightdata.com/" />
    <link rel="alternate" hreflang="es-ES" href="https://brightdata.es/" />
    <link rel="canonical" href="https://brightdata.com/" />
  </head><body><h1>Web data for teams</h1></body></html>`,
)

// Reciprocates: hreflang back to the anchor's registrable host. Attribute
// order deliberately shuffled — extraction must not depend on it.
const ES_HOME = page(
  "https://brightdata.es/",
  `<html><head>
    <link hreflang="en-US" rel="alternate" href="https://brightdata.com/" />
    <link rel="alternate" hreflang="es" href="https://brightdata.es/" />
  </head><body><h1>Datos web</h1></body></html>`,
)

describe("aliasSignals", () => {
  it("extracts cross-registrable-host hreflang targets and skips self-references", () => {
    const s = aliasSignals(ANCHOR_HOME.html, ANCHOR_HOME.url)
    expect(s.hreflang).toEqual(["brightdata.es"])
    // Same-host canonical is not a cross-host assertion.
    expect(s.canonical).toBeNull()
  })
  it("reads attributes in any order, any quoting, any case", () => {
    const s = aliasSignals(
      `<LINK HREFLANG=de REL='alternate' HREF='https://example.de/'>`,
      "https://example.com/",
    )
    expect(s.hreflang).toEqual(["example.de"])
  })
  it("folds subdomain targets into the registrable host and drops same-host results", () => {
    const s = aliasSignals(
      `<link rel="alternate" hreflang="es" href="https://es.example.com/">`,
      "https://www.example.com/",
    )
    expect(s.hreflang).toEqual([])
  })
  it("resolves protocol-relative and ignores page-relative hrefs", () => {
    const s = aliasSignals(
      `<link rel="alternate" hreflang="es" href="//example.es/">` +
        `<link rel="alternate" hreflang="fr" href="/fr/">`,
      "https://example.com/",
    )
    expect(s.hreflang).toEqual(["example.es"])
  })
  it("takes a cross-host canonical, first one wins", () => {
    const s = aliasSignals(
      `<link rel="canonical" href="https://example.es/p">` +
        `<link rel="canonical" href="https://other.net/p">`,
      "https://example.com/p",
    )
    expect(s.canonical).toBe("example.es")
  })
  it("a self-canonicalizing page asserts nothing — a stray second cross-host canonical does not count", () => {
    const s = aliasSignals(
      `<link rel="canonical" href="https://example.com/p">` +
        `<link rel="canonical" href="https://example.es/p">`,
      "https://example.com/p",
    )
    expect(s.canonical).toBeNull()
  })
  it("requires rel=alternate for hreflang and ignores non-alias link tags", () => {
    const s = aliasSignals(
      `<link hreflang="es" href="https://example.es/">` + // no rel
        `<link rel="stylesheet" href="https://cdn.shared.net/a.css">` +
        `<link rel="preconnect" href="https://cdn.shared.net">`,
      "https://example.com/",
    )
    expect(s.hreflang).toEqual([])
    expect(s.canonical).toBeNull()
  })
  it("never throws on an unparseable page URL or garbage hrefs", () => {
    expect(aliasSignals(`<link rel="canonical" href="javascript:void(0)">`, "not a url")).toEqual({
      hreflang: [],
      canonical: null,
    })
  })
  it("never throws when an href is absolute-looking but malformed, even against a valid page URL", () => {
    // "not a url" above short-circuits before targetHost ever runs (aliasSignals'
    // own try/catch returns early on an unparseable pageUrl) — this page URL
    // parses fine, so the href has to fail inside targetHost's own try/catch
    // (measured: 0% branch coverage on that catch before this test existed).
    const s = aliasSignals(`<link rel="canonical" href="http://[bad">`, "https://example.com/p")
    expect(s.canonical).toBeNull()
  })
})

describe("aliasSets", () => {
  it("accepts a pair on hreflang reciprocity", () => {
    const sets = aliasSets([ANCHOR_HOME, ES_HOME]).map((s) => [...s].sort())
    expect(sets).toEqual([["brightdata.com", "brightdata.es"]])
  })
  it("NEVER accepts a one-sided hreflang — the other page stays silent", () => {
    const silent = page("https://brightdata.es/", `<html><head></head><body>Datos</body></html>`)
    expect(aliasSets([ANCHOR_HOME, silent])).toEqual([])
  })
  it("NEVER accepts an assertion whose target page was not read — reciprocity is unprovable", () => {
    expect(aliasSets([ANCHOR_HOME])).toEqual([])
  })
  it("accepts mutual canonical agreement, both hosts naming each other", () => {
    const a = page("https://example.com/", `<link rel="canonical" href="https://example.es/">`)
    const b = page("https://example.es/", `<link rel="canonical" href="https://example.com/">`)
    const sets = aliasSets([a, b]).map((s) => [...s].sort())
    expect(sets).toEqual([["example.com", "example.es"]])
  })
  it("NEVER accepts a one-sided canonical against a self-canonicalizing target — the forgeable shape", () => {
    // Anyone can point rel=canonical at a company they are not; the company's
    // own self-canonical is agreement about itself, not about the claimant.
    const claimant = page("https://impostor.net/", `<link rel="canonical" href="https://victim.com/">`)
    const victim = page("https://victim.com/", `<link rel="canonical" href="https://victim.com/">`)
    expect(aliasSets([claimant, victim])).toEqual([])
  })
  it("does not mix instruments: one-sided hreflang plus one-sided canonical is not reciprocity", () => {
    const a = page("https://a-co.com/", `<link rel="alternate" hreflang="es" href="https://b-co.com/">`)
    const b = page("https://b-co.com/", `<link rel="canonical" href="https://a-co.com/">`)
    expect(aliasSets([a, b])).toEqual([])
  })
  it("union-finds transitively across accepted pairs and keeps disjoint sets apart", () => {
    const a = page("https://a-co.com/", `<link rel="alternate" hreflang="x" href="https://b-co.com/">`)
    const b = page(
      "https://b-co.com/",
      `<link rel="alternate" hreflang="y" href="https://a-co.com/">` +
        `<link rel="canonical" href="https://c-co.com/">`,
    )
    const c = page("https://c-co.com/", `<link rel="canonical" href="https://b-co.com/">`)
    const d = page("https://d-co.com/", `<link rel="alternate" hreflang="z" href="https://e-co.com/">`)
    const e = page("https://e-co.com/", `<link rel="alternate" hreflang="z" href="https://d-co.com/">`)
    const sets = aliasSets([a, b, c, d, e]).map((s) => [...s].sort())
    expect(sets).toEqual([
      ["a-co.com", "b-co.com", "c-co.com"],
      ["d-co.com", "e-co.com"],
    ])
    // Order of the input pages must not change the answer.
    const reversed = aliasSets([e, d, c, b, a]).map((s) => [...s].sort())
    expect(reversed).toEqual(sets)
  })
  it("skips a page whose own url fails to parse, without touching anyone else's assertions", () => {
    // A page list is upstream content, not validated input — one page.url that
    // fails `new URL()` must not crash the whole run or block the other
    // pages' reciprocity (measured: the catch that drops it had 0% branch
    // coverage before this test existed).
    const garbage = page("not a url", `<link rel="canonical" href="https://example.es/">`)
    const sets = aliasSets([ANCHOR_HOME, ES_HOME, garbage]).map((s) => [...s].sort())
    expect(sets).toEqual([["brightdata.com", "brightdata.es"]])
  })
  it("a NON-alias pair sharing a CDN never merges", () => {
    const a = page(
      "https://one-co.com/",
      `<link rel="stylesheet" href="https://cdn.shared.net/lib.css">` +
        `<a href="https://cdn.shared.net/widget.js">widget</a>`,
    )
    const b = page(
      "https://two-co.com/",
      `<link rel="stylesheet" href="https://cdn.shared.net/lib.css">` +
        `<a href="https://cdn.shared.net/widget.js">widget</a>`,
    )
    expect(aliasSets([a, b])).toEqual([])
  })
})

describe("anchorAliasSet", () => {
  it("returns the set containing the anchor, anchor key included", () => {
    const set = anchorAliasSet([ANCHOR_HOME, ES_HOME], "brightdata.com")
    expect([...set].sort()).toEqual(["brightdata.com", "brightdata.es"])
  })
  it("is just the anchor when no structural assertion reciprocates", () => {
    const set = anchorAliasSet([ANCHOR_HOME], "www.brightdata.com")
    expect([...set]).toEqual(["brightdata.com"])
  })
  it("does not hand the anchor someone else's alias set", () => {
    const set = anchorAliasSet([ANCHOR_HOME, ES_HOME], "unrelated.io")
    expect([...set]).toEqual(["unrelated.io"])
  })
})

describe("answerKeyRecall with anchorAliases — the mechanical fix, measured", () => {
  // A third-party roundup that names the anchor and lists six "vendors", one
  // of which is the anchor's own ccTLD property.
  const ROUNDUP = page(
    "https://roundup.example/best",
    `<p>We compared brightdata.com against the field.</p>` +
      `<a href="https://brightdata.es/">es</a>` +
      `<a href="https://v1.com/">1</a><a href="https://v2.com/">2</a><a href="https://v3.com/">3</a>` +
      `<a href="https://m1.com/">4</a><a href="https://m2.com/">5</a>`,
  )
  const MAP_HOSTS = new Set(["v1.com", "v2.com", "v3.com"])
  const ALIASES = anchorAliasSet([ANCHOR_HOME, ES_HOME], "brightdata.com")

  it("pins the mechanical rise: 3/6 = 0.5 polluted, 3/5 = 0.6 fixed — a bug fix, not new coverage", () => {
    const before = answerKeyRecall([ROUNDUP], { anchor: "brightdata.com", mapHosts: MAP_HOSTS })
    expect(before.pooled).toBeCloseTo(0.5)
    expect(before.probes[0]!.vendors).toContain("brightdata.es")

    const after = answerKeyRecall([ROUNDUP], {
      anchor: "brightdata.com",
      mapHosts: MAP_HOSTS,
      anchorAliases: ALIASES,
    })
    expect(after.pooled).toBeCloseTo(0.6)
    expect(after.probes[0]!.vendors).not.toContain("brightdata.es")
  })

  it("excludes an alias-hosted page from the probe pool — the anchor must not grade itself in translation", () => {
    // The .es front page names the anchor (its hreflang backlink does) and
    // lists five vendors, so without the alias set it would qualify as a probe.
    const esAsProbe = page(
      "https://brightdata.es/",
      ES_HOME.html +
        `<a href="https://v1.com/">1</a><a href="https://v2.com/">2</a><a href="https://v3.com/">3</a>` +
        `<a href="https://m1.com/">4</a><a href="https://m2.com/">5</a>`,
    )
    const without = answerKeyRecall([esAsProbe, ROUNDUP], { anchor: "brightdata.com", mapHosts: MAP_HOSTS })
    expect(without.probes).toHaveLength(2)

    const withAliases = answerKeyRecall([esAsProbe, ROUNDUP], {
      anchor: "brightdata.com",
      mapHosts: MAP_HOSTS,
      anchorAliases: anchorAliasSet([ANCHOR_HOME, esAsProbe], "brightdata.com"),
    })
    expect(withAliases.probes).toHaveLength(1)
    expect(withAliases.probes[0]!.url).toBe(ROUNDUP.url)
  })

  it("ships the exclusion and its sentence where recall serializes", () => {
    const r = answerKeyRecall([ROUNDUP], {
      anchor: "brightdata.com",
      mapHosts: MAP_HOSTS,
      anchorAliases: ALIASES,
    })
    expect(r.aliasExclusion?.hosts).toEqual(["brightdata.es"])
    expect(r.aliasExclusion?.note).toContain("bug fix")
    expect(r.aliasExclusion?.note).toContain("not a coverage improvement")
  })

  it("carries no exclusion record when the alias set is just the anchor", () => {
    const r = answerKeyRecall([ROUNDUP], {
      anchor: "brightdata.com",
      mapHosts: MAP_HOSTS,
      anchorAliases: new Set(["brightdata.com"]),
    })
    expect(r.aliasExclusion).toBeUndefined()
    expect(r.pooled).toBeCloseTo(0.5)
  })
})
