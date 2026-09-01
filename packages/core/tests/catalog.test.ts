import { describe, it, expect } from "vitest"
import {
  candidatesFromSitemap,
  candidatesFromLinks,
  isSitemapIndex,
  sitemapChildren,
  readPageFacts,
  renderPageFacts,
  dedupeFacts,
} from "../src/catalog.js"

const sitemap = (urls: string[]) =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<loc>${u}</loc>`).join("")}</urlset>`

describe("candidate selection", () => {
  /**
   * The selection rule. Measured on one company: `/products/web-unlocker` is a
   * product while `/products/scraping-browser/puppeteer` is the same product
   * framed for a search term, and `/products/datasets/product-barcode` is one
   * row of a catalog. Ground truth excluded roughly eight hundred of those.
   */
  it("keeps a product and drops its deeper variants", () => {
    const out = candidatesFromSitemap(
      sitemap([
        "https://x.com/products/web-unlocker",
        "https://x.com/products/scraping-browser/puppeteer",
        "https://x.com/products/scraping-browser/selenium",
        "https://x.com/products/datasets/product-barcode",
      ]),
    )
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/products/web-unlocker"])
  })

  it("puts the shallowest first, because a budget spent deep buys one product many times", () => {
    const out = candidatesFromSitemap(
      sitemap(["https://x.com/products/a-thing", "https://x.com/pricing", "https://x.com/platform/ai"]),
    )
    expect(new URL(out[0]!.url).pathname).toBe("/pricing")
  })

  it("drops content namespaces however many of them there are", () => {
    const out = candidatesFromSitemap(
      sitemap([
        ...Array.from({ length: 300 }, (_, i) => `https://x.com/blog/post-${i}`),
        ...Array.from({ length: 200 }, (_, i) => `https://x.com/templates/t-${i}`),
        "https://x.com/products/the-only-real-one",
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toContain("the-only-real-one")
  })

  /**
   * THE PRODUCT THAT SITS AT THE ROOT.
   *
   * `OFFERING` requires a namespace, and a large class of sites has none.
   * MEASURED on cursor.com/sitemap.xml (189 urls, 2026-08-23): its products
   * are `/tab`, `/bugbot`, `/cli`, `/cloud`, `/composer`, `/sdk`,
   * `/automate` and `/mobile`, and this function returned exactly two
   * candidates — `/pricing` and `/product`, the two the understand prompt
   * itself calls pages *about* products. With no catalog to read, four runs
   * of that anchor on one day decomposed it into 4, 7, 8 and 17 products.
   */
  it("falls back to root-level paths when no namespace claims any product", () => {
    const out = candidatesFromSitemap(
      sitemap([
        "https://x.com/",
        "https://x.com/pricing",
        "https://x.com/product",
        "https://x.com/tab",
        "https://x.com/bugbot",
        "https://x.com/cli",
      ]),
    )
    const paths = out.map((c) => new URL(c.url).pathname)
    expect(paths).toContain("/tab")
    expect(paths).toContain("/bugbot")
    expect(paths).toContain("/cli")
    // The namespaced ones still rank first, and the homepage is not a
    // candidate — it has already been read.
    expect(paths.slice(0, 2)).toEqual(["/pricing", "/product"])
    expect(paths).not.toContain("/")
  })

  /**
   * A FALLBACK, NOT A WIDENING. A site that has said where its products live
   * is left exactly as it was — otherwise a big sitemap's root would flood
   * the budget alphabetically, which is the bug FIRST_TIER exists to prevent.
   */
  it("ignores root-level paths when the site does have a product namespace", () => {
    const out = candidatesFromSitemap(
      sitemap([
        "https://x.com/products/alpha",
        "https://x.com/products/beta",
        "https://x.com/products/gamma",
        "https://x.com/platform/delta",
        "https://x.com/solutions/epsilon",
        "https://x.com/ads",
        "https://x.com/zebra",
      ]),
    )
    const paths = out.map((c) => new URL(c.url).pathname)
    expect(paths).not.toContain("/ads")
    expect(paths).not.toContain("/zebra")
    expect(paths).toHaveLength(5)
  })

  it("never offers legal, account or file paths as products", () => {
    const out = candidatesFromSitemap(
      sitemap([
        "https://x.com/thing",
        "https://x.com/privacy",
        "https://x.com/terms-of-service",
        "https://x.com/licenses",
        "https://x.com/cookie-table",
        "https://x.com/marketplace-publisher-terms",
        "https://x.com/login",
        "https://x.com/contact-sales",
        "https://x.com/download",
        "https://x.com/ads.txt",
        "https://x.com/404-static",
      ]),
    )
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/thing"])
  })

  /** A landing page is a campaign, not a product. */
  it("drops marketing landing pages", () => {
    const out = candidatesFromSitemap(
      sitemap(["https://x.com/lp/product/okr-planning", "https://x.com/platform"]),
    )
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/platform"])
  })

  /**
   * The bug that let the landing page through. Stripping every two-letter first
   * segment as a locale turned `/lp/product/okr-planning` into
   * `/product/okr-planning`, which looks exactly like a product.
   */
  it("does not mistake a two-letter path segment for a locale", () => {
    const out = candidatesFromSitemap(sitemap(["https://x.com/lp/product/thing"]))
    expect(out).toEqual([])
  })

  it("strips a real locale so one product is not counted once per language", () => {
    const out = candidatesFromSitemap(
      sitemap([
        "https://x.com/de-de/products/thing",
        "https://x.com/es-es/products/thing",
        "https://x.com/products/thing",
      ]),
    )
    expect(out).toHaveLength(1)
  })

  it("treats a trailing slash as the same page", () => {
    const out = candidatesFromSitemap(sitemap(["https://x.com/pricing", "https://x.com/pricing/"]))
    expect(out).toHaveLength(1)
  })

  /**
   * `pathOf`'s catch branch, never fed a bad entry before this. Every other
   * fixture in this file is a well-formed absolute url, so the one line that
   * keeps one dirty `<loc>` in a dirty sitemap from crashing the whole read
   * — `new URL(url)` throwing on a string that is not a url at all — had
   * never actually run.
   */
  it("drops a <loc> entry that new URL() can't parse, instead of throwing", () => {
    const out = candidatesFromSitemap(
      sitemap(["not a url at all", "https://x.com/products/real"]),
    )
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/products/real"])
  })

  it("recognises a sitemap index so the caller follows it rather than folding it", () => {
    expect(isSitemapIndex(sitemap(["https://x.com/sitemap-1.xml", "https://x.com/sitemap-2.xml"]))).toBe(true)
    expect(isSitemapIndex(sitemap(["https://x.com/products/a"]))).toBe(false)
    expect(isSitemapIndex("")).toBe(false)
  })

  /**
   * The bug this replaces: every caller followed the FIRST child only, so
   * alphabetical order decided what a run read. resend.com's first child is
   * `/blog/sitemap.xml` — 166 posts, zero products — while `/migrate/` five
   * entries down names five rivals in its slugs.
   */
  it("returns every child of an index, content-named ones last", () => {
    const out = sitemapChildren(
      sitemap([
        "https://x.com/blog/sitemap.xml",
        "https://x.com/docs/sitemap.xml",
        "https://x.com/migrate/sitemap.xml",
        "https://x.com/other/sitemap.xml",
      ]),
    )
    expect(out).toHaveLength(4)
    // The children a product or rival can actually live in come first…
    expect(out.slice(0, 2)).toEqual([
      "https://x.com/migrate/sitemap.xml",
      "https://x.com/other/sitemap.xml",
    ])
    // …and the blog is still read, just never INSTEAD of them.
    expect(out).toContain("https://x.com/blog/sitemap.xml")
  })

  it("caps the children it hands back, dropping content-named ones first", () => {
    const kids = [
      "https://x.com/blog/sitemap.xml",
      ...Array.from({ length: 12 }, (_, i) => `https://x.com/section-${String(i).padStart(2, "0")}/sitemap.xml`),
    ]
    const out = sitemapChildren(sitemap(kids), 12)
    expect(out).toHaveLength(12)
    expect(out).not.toContain("https://x.com/blog/sitemap.xml")
  })

  /**
   * `contentNamed`'s `new URL(u).pathname` catch had never run: every fixture
   * above hands it well-formed absolute urls. A `<loc>` a dirty sitemap can
   * still contain — not a url at all — treats it as content-named (sorted
   * last) rather than throwing and losing every child behind it.
   */
  it("sorts an unparseable loc entry to the back rather than throwing", () => {
    const out = sitemapChildren(
      sitemap(["not a valid url", "https://x.com/migrate/sitemap.xml"]),
    )
    expect(out).toEqual(["https://x.com/migrate/sitemap.xml", "not a valid url"])
  })
})

describe("candidates from links", () => {
  it("reads product urls out of a nav", () => {
    const html = `<nav><a href="/products/one">One</a><a href="/blog/x">Blog</a>
      <a href="https://other.com/products/two">Elsewhere</a></nav>`
    const out = candidatesFromLinks(html, "https://x.com/")
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/products/one"])
  })

  /** A client-rendered site keeps its nav in an embedded JSON payload, where
   *  href regexes find nothing at all. */
  it("finds urls inside an embedded json payload", () => {
    const html = `<script>{"nav":[{"href":"https://x.com/platform/ai","label":"AI"}]}</script>`
    const out = candidatesFromLinks(html, "https://x.com/")
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/platform/ai"])
  })

  it("stays on the company's own origin", () => {
    const out = candidatesFromLinks(`<a href="https://competitor.com/products/x">x</a>`, "https://x.com/")
    expect(out).toEqual([])
  })

  /** The `new URL(base).origin` catch had never run: every fixture above passes
   *  an absolute base. A base that is not itself a valid url can't anchor
   *  anything, so the function returns no candidates rather than throwing. */
  it("returns nothing when the base itself is not a valid url", () => {
    const out = candidatesFromLinks(`<a href="/products/one">One</a>`, "not-a-url")
    expect(out).toEqual([])
  })

  /** The per-href catch had never run either: one bad href among good ones is
   *  dropped, not fatal to the rest of the page's nav. */
  it("skips a href that fails to resolve against the base, keeping the rest", () => {
    const html = `<a href="http://">Bad</a><a href="/products/one">One</a>`
    const out = candidatesFromLinks(html, "https://x.com/")
    expect(out.map((c) => new URL(c.url).pathname)).toEqual(["/products/one"])
  })
})

describe("reading a page", () => {
  /**
   * The reason pages are read at all. One company's `/platform/ai` is titled
   * "Airtable Assistant", so a url-only reading loses the brand entirely, and
   * another's `scraping-browser` slug fronts a product called "Browser API".
   */
  it("prefers what the page calls itself over what its url says", () => {
    const f = readPageFacts(
      "https://x.com/platform/ai",
      `<title>Airtable Assistant | Airtable</title><h1>Airtable Assistant</h1>
       <meta name="description" content="AI built for the way your business works">`,
    )
    expect(f!.heading).toBe("Airtable Assistant")
    expect(f!.description).toContain("AI built for")
  })

  it("takes og:title over a title suffixed with the company's own name", () => {
    const f = readPageFacts(
      "https://x.com/products/a",
      `<meta property="og:title" content="Browser API"><title>Browser API | Bright Data</title>`,
    )
    expect(f!.title).toBe("Browser API")
  })

  it("returns null for a page that names nothing", () => {
    expect(readPageFacts("https://x.com/a", "<div>no title, no heading</div>")).toBeNull()
  })

  it("renders one short block per page, not the page", () => {
    const facts = [
      readPageFacts("https://x.com/products/a", "<title>A</title><h1>A</h1><meta name='description' content='does a'>")!,
    ]
    const out = renderPageFacts(facts)
    expect(out).toContain("/products/a")
    expect(out).toContain("does a")
    // The whole argument for this strategy: it is small.
    expect(out.length).toBeLessThan(200)
  })
})

describe("spending the budget", () => {
  /**
   * The failure this fixes. A 25-page budget spent depth-first-alphabetically
   * gave nine slots to industry verticals and ran out at the letter M, losing a
   * real product that sat later in the alphabet. A vertical page names an
   * audience; a product page names a capability.
   */
  it("spends on products before industry verticals", () => {
    const out = candidatesFromSitemap(
      sitemap([
        "https://x.com/solutions/agencies",
        "https://x.com/solutions/finance",
        "https://x.com/solutions/hr",
        "https://x.com/platform/zzz-last-alphabetically",
      ]),
      2,
    )
    expect(out.map((c) => new URL(c.url).pathname)).toContain("/platform/zzz-last-alphabetically")
  })

  it("still takes verticals once the products are exhausted", () => {
    const out = candidatesFromSitemap(
      sitemap(["https://x.com/solutions/agencies", "https://x.com/platform"]),
      5,
    )
    expect(out).toHaveLength(2)
  })

  /** Measured: /platform and /platform/connected-apps-platform returned a
   *  byte-identical title and description, so the flagship counted twice. */
  it("drops a page that is the same page under another url", () => {
    const same = { title: "The platform", description: "one description", heading: "The platform" }
    const out = dedupeFacts([
      { url: "https://x.com/platform", ...same },
      { url: "https://x.com/platform/connected-apps-platform", ...same },
      { url: "https://x.com/platform/ai", title: "AI", heading: "AI", description: "different" },
    ])
    expect(out).toHaveLength(2)
  })
})

describe("market names are snapped to the declared list", () => {
  // The join the sweep does, extracted here so it is testable without a run.
  const canonicalise = (declared: string[], m: string | undefined) => {
    const d = new Map(declared.map((c) => [c.trim().toLowerCase(), c]))
    return m ? d.get(m.trim().toLowerCase()) : undefined
  }

  it("matches a declared market whatever its casing", () => {
    expect(canonicalise(["Proxy Infrastructure"], "proxy infrastructure")).toBe("Proxy Infrastructure")
  })

  /** A measured run tagged 25 entities with its LENS instead of a market. */
  it("refuses a lens name", () => {
    expect(canonicalise(["Proxy Infrastructure"], "Who solves it a different way")).toBeUndefined()
  })

  it("refuses a market the planner invented mid-run", () => {
    expect(canonicalise(["Proxy Infrastructure"], "Headless browser rendering APIs")).toBeUndefined()
  })
})

/**
 * Budget allocation across products, extracted so it is testable without a run.
 * Measured failure: a fifteen-product company with a sixteen-query budget
 * funded eight products in order and left a CORE market with zero queries.
 */
function allocate(
  markets: { name: string; centrality: string; covers: string[] }[],
  target: number,
  cap = 5,
) {
  const ranked = [...markets].sort((a, b) =>
    a.centrality === b.centrality ? 0 : a.centrality === "core" ? -1 : 1,
  )
  const queues = ranked.map((m) => ({ m, products: (m.covers.length ? m.covers : [m.name]).slice() }))
  const per = Math.max(1, Math.min(cap, Math.max(3, Math.ceil(target / Math.max(queues.length, 1)))))
  const room = Math.max(1, Math.ceil(target / per))
  const out: { market: string; product: string }[] = []
  const drain = (qs: typeof queues) => {
    let moved = true
    while (moved && out.length < room) {
      moved = false
      for (const q of qs) {
        if (out.length >= room) break
        const p = q.products.shift()
        if (!p) continue
        out.push({ market: q.m.name, product: p })
        moved = true
      }
    }
  }
  drain(queues.filter((q) => q.m.centrality === "core"))
  drain(queues.filter((q) => q.m.centrality !== "core"))
  return { per, funded: out }
}

describe("spending the query budget across products", () => {
  const mk = (name: string, centrality: string, covers: string[]) => ({ name, centrality, covers })

  it("reaches every core market before giving any market a second product", () => {
    const { funded } = allocate(
      [
        mk("Proxy", "core", ["Residential", "Datacenter", "ISP"]),
        mk("Unblocking", "core", ["Unlocker", "Browser"]),
        mk("Web Datasets", "core", ["Datasets"]),
      ],
      16,
    )
    expect(new Set(funded.map((f) => f.market))).toEqual(new Set(["Proxy", "Unblocking", "Web Datasets"]))
  })

  /** Taking products in order looks fair and starves a market that sorts late. */
  it("does not starve a core market whose products sort last", () => {
    const { funded } = allocate(
      [mk("A", "core", ["a1", "a2", "a3", "a4", "a5", "a6"]), mk("Z", "core", ["z1"])],
      6,
    )
    expect(funded.some((f) => f.market === "Z")).toBe(true)
  })

  it("funds core markets before touching an adjacent one", () => {
    const { funded } = allocate(
      [mk("Core", "core", ["c1", "c2"]), mk("Side", "adjacent", ["s1"])],
      6,
    )
    expect(funded.length).toBeGreaterThan(0)
    expect(funded.every((f) => f.market === "Core")).toBe(true)
  })

  /** One query per product cannot spread across even the first shapes, so a
   *  wide catalog buys nineteen versions of the same question. */
  it("never drops below three queries per funded product", () => {
    const many = Array.from({ length: 19 }, (_, i) => mk(`m${i}`, "core", [`p${i}`]))
    expect(allocate(many, 16).per).toBeGreaterThanOrEqual(3)
  })

  it("respects the per-product cap when the budget is generous", () => {
    expect(allocate([mk("A", "core", ["a1"])], 80, 5).per).toBe(5)
  })
})
