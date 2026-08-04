/**
 * Find the pages where a company describes what it sells, and read those.
 *
 * MEASURED, against ground truth on three companies. Reading an index and
 * inferring products from it recovered 96% of them at 20% precision: everything
 * real, drowned in eighty-nine things that were not products. Reading the
 * product pages themselves scored 72% precision, three times better, and cost
 * between two and six seconds of concurrent fetching.
 *
 * An index tells you what URLs exist. Only a page tells you what it is, and the
 * two disagree in both directions: one company's `/platform/ai` is titled
 * "Airtable Assistant", so a URL-only reading loses the brand, while a slug
 * saying `scraping-browser` fronts a product actually called "Browser API".
 *
 * Nothing here fetches. It decides WHICH urls are worth fetching and what to
 * make of the bodies, so it stays testable without a network.
 */

/** A candidate product page, before anything has been fetched. */
export interface Candidate {
  url: string
  /** Which surface proposed it, kept so a run can say where its catalog came from. */
  from: "sitemap" | "links"
}

/**
 * Path prefixes that name a company's own offering rather than its content.
 * Deliberately small: this is a filter over urls a site already published, not
 * a guess about what a market calls things.
 */
const OFFERING = /^\/(products?|platform|pricing|solutions?|services?|features?)(\/|$)/i

/** Content namespaces that swamp a sitemap and never contain a product. */
const CONTENT = /^\/(blog|news|resources?|guides?|templates?|customers?|case-studies?|events?|docs?|help|support|legal|about|careers?|press|community|universe|learn|academy|glossary|integrations?|lp|landing|compare|vs|alternatives?)(\/|$)/i

/**
 * A product sits shallow; a variant of it sits one level deeper.
 *
 * Measured on one company: `/products/web-unlocker` and `/products/serp-api`
 * are products, while `/products/scraping-browser/puppeteer`,
 * `/products/scraping-browser/selenium` and `/products/datasets/product-barcode`
 * are the same product framed for a search term, or one row of a catalog. The
 * ground truth excluded roughly eight hundred of those.
 *
 * Two segments past the root, so `/products/<name>` is in and
 * `/products/<name>/<variant>` is out. `/pricing` at one segment is in, because
 * a pricing route is a company stating what it sells separately.
 */
const MAX_DEPTH = 2

/**
 * Locale prefixes multiply every section: one company's sitemap folded 5503
 * urls into 4369 "sections" because de-de, es-es and fr-fr each got their own.
 *
 * Hyphenated forms only. A bare two-letter segment is indistinguishable from a
 * short path, and treating every one as a locale meant `/lp/product/okr-planning`
 * had its `lp` stripped and became `/product/okr-planning`, so a marketing
 * landing page entered the catalog as a product.
 */
const LOCALE = /^\/([a-z]{2}-[a-z]{2})(\/|$)/i

function pathOf(url: string): string | null {
  try {
    const p = new URL(url).pathname
    const stripped = p.replace(LOCALE, "/")
    // Only strip a locale when doing so leaves something. "/de-de" alone is a
    // landing page, not a locale prefix on a product path.
    const kept = stripped === "/" && p !== "/" ? p : stripped
    // `/pricing` and `/pricing/` are one page. Deduping on the raw path listed
    // both, and a slot spent on a duplicate is a product not read.
    return kept.length > 1 ? kept.replace(/\/+$/, "") : kept
  } catch {
    return null
  }
}

/**
 * Pick the product urls out of a sitemap.
 *
 * `<loc>` entries only, and the caller is responsible for following a sitemap
 * INDEX one level down first — a file whose every entry ends in `.xml` is an
 * index and folding it here would return nothing but more sitemaps.
 */
export function candidatesFromSitemap(xml: string, limit = 25): Candidate[] {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
  return rank(locs.map((url) => ({ url, from: "sitemap" as const })), limit)
}

/**
 * Keep the offering pages, drop the content, and take the shallowest.
 *
 * Shallowest first is the whole selection rule. A budget of twenty-five spent
 * on depth-three pages buys twenty-five framings of one product; spent on
 * depth-two pages it buys the catalog.
 */
function rank(cands: readonly Candidate[], limit: number): Candidate[] {
  const seen = new Set<string>()
  const kept: { c: Candidate; depth: number }[] = []
  for (const c of cands) {
    const path = pathOf(c.url)
    if (!path || CONTENT.test(path) || !OFFERING.test(path)) continue
    const depth = path.split("/").filter(Boolean).length
    if (depth > MAX_DEPTH) continue
    if (seen.has(path)) continue
    seen.add(path)
    kept.push({ c, depth })
  }
  return kept
    .sort((a, b) => a.depth - b.depth || a.c.url.localeCompare(b.c.url))
    .slice(0, limit)
    .map((k) => k.c)
}

/** True when every entry points at another sitemap, which means this is an index. */
export function isSitemapIndex(xml: string): boolean {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
  return locs.length > 0 && locs.every((l) => /\.xml(\?|$)/i.test(l))
}

/**
 * Product urls linked from a page the run already has.
 *
 * The fallback for a site with no useful sitemap: one company's has 118 urls
 * and only 12 of them are products, another's has none at all, and both still
 * link their products from the homepage nav.
 */
export function candidatesFromLinks(html: string, base: string, limit = 25): Candidate[] {
  const hrefs = [
    ...[...html.matchAll(/href=["']([^"']+)["']/g)].map((m) => m[1]!),
    // Client-rendered sites keep their nav in an embedded JSON payload, where
    // the urls are absolute strings rather than href attributes.
    ...[...html.matchAll(/"(https?:\/\/[^"]{8,200})"/g)].map((m) => m[1]!),
  ]
  let origin: string
  try {
    origin = new URL(base).origin
  } catch {
    return []
  }
  const abs: Candidate[] = []
  for (const href of hrefs) {
    try {
      const u = new URL(href, base).toString()
      if (u.startsWith(origin)) abs.push({ url: u, from: "links" })
    } catch {
      // not a url
    }
  }
  return rank(abs, limit)
}

export interface PageFacts {
  url: string
  title: string
  heading: string
  description: string
}

/**
 * What a product page says it is, in about a hundred characters.
 *
 * Title, first heading and meta description, and nothing else. The whole point
 * is to read the page's own claim about itself rather than infer one from its
 * url, and a product page states that claim in exactly these three places.
 *
 * Reading only these is also what makes the strategy cheap: twenty-five pages
 * cost 22MB to fetch and about 2,500 characters to consider.
 */
export function readPageFacts(url: string, html: string): PageFacts | null {
  const strip = (s: string) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()

  const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
  // og:title over <title>: a site that suffixes every title with its own brand
  // still gives the product's own name here.
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i.exec(html)?.[1] ?? ""
  const h1 = strip(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "")
  const desc =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description/i.exec(html)?.[1] ??
    ""

  const heading = h1 || strip(og)
  if (!title && !heading) return null
  return {
    url,
    title: (og ? strip(og) : title).slice(0, 120),
    heading: heading.slice(0, 120),
    description: strip(desc).slice(0, 200),
  }
}

/** The block handed to the model, one line per page. */
export function renderPageFacts(facts: readonly PageFacts[]): string {
  return facts
    .map((f) => {
      const path = (() => {
        try {
          return new URL(f.url).pathname
        } catch {
          return f.url
        }
      })()
      const name = f.heading && f.heading !== f.title ? `${f.heading}  (title: ${f.title})` : f.title
      return `${path}\n   ${name}\n   ${f.description}`
    })
    .join("\n\n")
}
