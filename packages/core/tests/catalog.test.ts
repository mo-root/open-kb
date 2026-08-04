import { describe, it, expect } from "vitest"
import {
  candidatesFromSitemap,
  candidatesFromLinks,
  isSitemapIndex,
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

  it("recognises a sitemap index so the caller follows it rather than folding it", () => {
    expect(isSitemapIndex(sitemap(["https://x.com/sitemap-1.xml", "https://x.com/sitemap-2.xml"]))).toBe(true)
    expect(isSitemapIndex(sitemap(["https://x.com/products/a"]))).toBe(false)
    expect(isSitemapIndex("")).toBe(false)
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
