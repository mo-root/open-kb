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
 *
 * The same sitemap is read twice, for two different facts. `candidatesFromSitemap`
 * wants the product pages and drops everything else; `rivalsFromSitemap` (below)
 * reads the comparison urls that first read discards, where a company names its
 * rivals in a slug for free.
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

/**
 * Not every offering path is equally likely to be a product.
 *
 * Measured: a 25-page budget spent depth-first-alphabetically gave nine slots
 * to `/solutions/*` industry verticals and ran out at the letter M, losing a
 * real product that sat later in the alphabet. A vertical page names an
 * AUDIENCE; a product page names a CAPABILITY, and only the second is a thing
 * to buy.
 *
 * So the second tier is spent only once the first is exhausted. It is not
 * excluded, because some vendors genuinely ship products under `/solutions`.
 */
const FIRST_TIER = /^\/(products?|platform|pricing|features?)(\/|$)/i

/**
 * A THIRD TIER: the product that sits at the root.
 *
 * `OFFERING` requires a namespace — `/products/x`, `/platform/x`. A large
 * class of modern sites has none: the product IS the top-level path.
 * MEASURED on cursor.com/sitemap.xml (189 urls, fetched 2026-08-23):
 * `/tab`, `/bugbot`, `/cli`, `/cloud`, `/composer`, `/sdk`, `/automate` and
 * `/mobile` are its products, and `candidatesFromSitemap` returned exactly
 * two candidates — `/pricing` and `/product`, the two the understand prompt
 * itself calls "pages *about* products rather than products". With no
 * catalog to read, four runs of the same anchor on the same day decomposed
 * it into 4, 7, 8 and 17 products: the model was naming products off a
 * documentation index because nothing else was offered.
 *
 * So a depth-1 path that is not content and not one of the pages every site
 * has is a candidate, ranked after the two namespaced tiers. It is a
 * CANDIDATE, not a product — each is fetched and shown to the model as what
 * the page says about itself, and the prompt already tells it that a hub, a
 * pricing page or a solutions page is not a product. The cost of a wrong
 * guess is one fetch out of twenty-five; the cost of the miss was the whole
 * decomposition.
 */
const ROOT_TIER = /^\/[^/]+\/?$/

/** How few namespaced candidates mean the site has no product namespace at
 *  all, and the root tier should be consulted. cursor.com and linear.app
 *  yield two each (`/pricing` and one hub); shopify.com yields five and
 *  vercel.com eleven, and neither of those needs or gets the fallback. */
const NO_NAMESPACE_BELOW = 5

/** A path that names a file is not a page about a product: `/ads.txt`,
 *  `/404-static`, `/sitemap.xml`. Root paths only — a namespaced path with a
 *  dot in it is rare enough to leave to the tiers above. */
const FILEISH = /\.[a-z0-9]{2,4}$|^\/\d{3}(-|$)/i

/**
 * Depth-1 paths that are on almost every site and are never the thing it
 * sells: legal, account, company, and the calls to action. Written against
 * the real sitemaps of cursor.com, vercel.com, linear.app and shopify.com —
 * `CONTENT` above already drops the big content namespaces, and this drops
 * what is left at the root once those are gone.
 */
const NOT_PRODUCT =
  /^\/(privacy|terms|terms-of-service|tos|cookie-policy|cookies|legal|dpa|gdpr|ccpa|acceptable-use-policy|acceptable-use|data-use|data-processing|abuse|trust|security|compliance|subprocessors|imprint|accessibility|sitemap|robots|rss|feed|search|login|log-in|signin|sign-in|signup|sign-up|register|logout|account|dashboard|app|admin|settings|billing-portal|download|downloads|install|start|get-started|getting-started|demo|contact|contact-sales|contact-us|sales|book|booking|schedule|talk-to-sales|support|status|changelog|releases|roadmap|brand|press-kit|media-kit|logos|newsletter|subscribe|unsubscribe|jobs|hiring|team|leadership|investors|partners|affiliates|ambassadors|students|education|nonprofits|startups|workshops|events|webinars|awards|merch|store|shop|swag|refer|referrals|sitemap-index)\/?$/i

/** Legal boilerplate that varies in name from site to site — matched by
 *  shape rather than by listing every wording. cursor.com alone carries
 *  `/licenses`, `/cookie-table` and `/marketplace-publisher-terms`. */
const LEGALISH = /(^\/|-)(terms|policy|policies|agreement|licen[sc]es?|eula|dmca|disclaimer|cookie-table)\/?$/i

/** Content namespaces that swamp a sitemap and never contain a product. */
const CONTENT = /^\/(blog|news|articles?|posts?|stories|resources?|guides?|templates?|customers?|case-studies?|events?|docs?|help|support|legal|about|careers?|press|community|universe|learn|academy|glossary|integrations?|lp|landing|compare|vs|alternatives?)(\/|$)/i

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
  const kept: { c: Candidate; depth: number; tier: number }[] = []
  const rooted: { c: Candidate; depth: number; tier: number }[] = []
  for (const c of cands) {
    const path = pathOf(c.url)
    if (!path || CONTENT.test(path)) continue
    const depth = path.split("/").filter(Boolean).length
    if (depth > MAX_DEPTH) continue
    if (seen.has(path)) continue
    if (OFFERING.test(path)) {
      seen.add(path)
      kept.push({ c, depth, tier: FIRST_TIER.test(path) ? 0 : 1 })
      continue
    }
    // The root tier, held back — see ROOT_TIER. `/` itself is the homepage,
    // which has already been read.
    if (
      ROOT_TIER.test(path) &&
      path !== "/" &&
      !NOT_PRODUCT.test(path) &&
      !LEGALISH.test(path) &&
      !FILEISH.test(path)
    ) {
      seen.add(path)
      rooted.push({ c, depth, tier: 2 })
    }
  }
  const byRank = (
    a: { tier: number; depth: number; c: Candidate },
    b: { tier: number; depth: number; c: Candidate },
  ) => a.tier - b.tier || a.depth - b.depth || a.c.url.localeCompare(b.c.url)
  // A FALLBACK, not a widening. A site with a real product namespace has
  // already said where its products live and is left exactly as it was; the
  // root tier is consulted only when almost nothing came back, which is the
  // measured failure (cursor.com: 189 urls, two candidates, both of them
  // pages *about* products). Selection inside the root tier is alphabetical
  // like every other tier, which on a big site would be meaningless — hence
  // the guard rather than a blend.
  const pool = kept.length < NO_NAMESPACE_BELOW ? [...kept, ...rooted] : kept
  return pool.sort(byRank).slice(0, limit).map((k) => k.c)
}

/** True when every entry points at another sitemap, which means this is an index. */
export function isSitemapIndex(xml: string): boolean {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
  return locs.length > 0 && locs.every((l) => /\.xml(\?|$)/i.test(l))
}

/**
 * A sitemap index's child sitemaps, in the order they are worth fetching.
 *
 * Every caller of `isSitemapIndex` used to follow exactly ONE child: the first
 * `<loc>` in the file. Alphabetical order decided what a run read, and on the
 * company that surfaced this the first child was `/blog/sitemap.xml` — so
 * phase one read 166 blog posts, found zero products and zero rival names,
 * and never saw the `/migrate/` sitemap naming five rivals or the child
 * holding the actual page inventory. The nav merge happened to save that run;
 * a company with a thin nav has nothing to save it.
 *
 * So: all of them, content-heavy ones last. The reorder matters because the
 * caller caps how many it fetches, and a cap spent on the blog is the same
 * bug with a bigger number. The namespaces pushed back are the ones CONTENT
 * already drops url-by-url — a child sitemap NAMED for one of them can only
 * yield urls the filter discards (`rivalsFromSitemap` is the one exception,
 * and comparison pages live beside products, not in a blog sitemap).
 *
 * Pure: takes bytes, returns urls, fetches nothing.
 */
export function sitemapChildren(xml: string, limit = 12): string[] {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
  const contentNamed = (u: string) => {
    try {
      return CONTENT.test(new URL(u).pathname)
    } catch {
      return true
    }
  }
  return [...locs.filter((u) => !contentNamed(u)), ...locs.filter(contentNamed)].slice(0, limit)
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

/**
 * A rival's NAME, read off a comparison url the anchor published about itself.
 *
 * A LEAD, NOT AN ENTITY, and the distinction is the whole of this type's
 * contract. `magento` here is a string a marketing team typed into a slug: it
 * has no domain, no fetched page and no quote behind it. Nothing may write one
 * of these onto the map as a rival on the strength of the slug — a lead is
 * resolved and judged exactly like a host that arrived from a search, or it is
 * not used at all. What it is for is asking a better question.
 */
export interface RivalLead {
  /** The name as a query would spell it: slug hyphens become spaces. */
  name: string
  /** How many of the anchor's own comparison urls named it. */
  seen: number
  /** One url that named it, so a lead is checkable rather than asserted. */
  foundAt: string
}

/**
 * Path prefixes holding a comparison rather than a product.
 *
 * Every one of these is dropped by `CONTENT` above, correctly — they contain no
 * products. Being dropped was also the end of them: the urls went in the bin
 * because nothing else in the run ever read them.
 */
const COMPARISON = /^\/(compare|comparisons?|versus|vs|alternatives?|alternative-to|migrate(?:-from)?|switch(?:ing)?-from)(\/|$)/i

/**
 * Namespaces whose own name IS the comparison, so one segment under them is a
 * rival and nothing else: `/versus/<x>`, `/alternatives/<x>`.
 *
 * `compare` is deliberately absent. MEASURED on one commerce platform's sitemap
 * (838 urls, fetched 2026-08-12): 40 urls sit in these namespaces, 36 of them
 * carry a `-vs-` separator, and all four that do not — `/compare`,
 * `/compare/tco`, `/compare/time-to-value`, `/compare/sitespeed` — are pages
 * about the comparison rather than about a company. Reading a bare
 * `/compare/<slug>` as a name buys those four and nothing else.
 *
 * `migrate` IS here, because its slug is nothing but the rival: an email
 * company's sitemap (fetched 2026-08-16) holds `/migrate/mailchimp`,
 * `/migrate/mailgun`, `/migrate/postmark`, `/migrate/sendgrid`,
 * `/migrate/customer-io` — five rivals, no framing pages. A company writes a
 * migration guide about exactly one thing: whoever its buyers are leaving.
 */
const NAMES_ONE_RIVAL = /^(versus|vs|alternatives?|alternative-to|migrate(?:-from)?|switch(?:ing)?-from)$/i

/** `a-vs-b`, `a_versus_b`. The separator every comparison slug measured used. */
const VS = /[-_](?:vs|versus)[-_]/i

/**
 * Words that frame a comparison rather than name a company.
 *
 * Small and literal. It exists for two shapes the sitemap actually contains:
 * a slug that is entirely framing (`shopify-vs-custom-platform` — "custom
 * platform" is not a vendor) and a name wearing framing at one end
 * (`<x>-comparison`, `best-<x>`), where the name is still in there and only
 * the frame comes off. Every word here would be a strange company name and a
 * useless search on its own; a word that could plausibly be a vendor — `square`,
 * `base` — is not in this list, because the cost of dropping a real rival is
 * higher than the cost of one weak query.
 */
const GENERIC_IN_SLUG = new Set([
  "alternative", "alternatives", "best", "compare", "comparison", "comparisons",
  "competitor", "competitors", "cost", "costs", "custom", "enterprise",
  "features", "free", "migration", "open", "platform", "platforms", "price",
  "pricing", "review", "reviews", "software", "solution", "solutions", "source",
  "switch", "tool", "tools", "top", "versus", "vs", "website", "websites",
])

/** The anchor's own words, as a slug would spell them: `shopify.com` -> shopify. */
function anchorWords(anchor: string): Set<string> {
  const host = (anchor.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "").replace(/^www\./i, "")
  const label = host.split(".")[0] ?? ""
  return new Set(label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

/**
 * One side of a comparison slug, as a name — or null when it is not one.
 *
 * The anchor's own side is dropped by name: `shopify-enterprise-vs-adobe` is
 * the anchor twice and Adobe once, and a run that searched its own name here
 * would be doing the exact thing this engine refuses to do.
 */
function rivalName(part: string, anchor: Set<string>): string | null {
  const words = part
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    // A year in a slug is when the page was written, not who it is about.
    .filter((w) => !/^(19|20)\d{2}$/.test(w))
  // Four words is already a phrase. A company name in a slug is one or two.
  if (!words.length || words.length > 4) return null
  if (words.some((w) => anchor.has(w))) return null
  if (words.every((w) => GENERIC_IN_SLUG.has(w))) return null
  while (words.length > 1 && GENERIC_IN_SLUG.has(words[0]!)) words.shift()
  while (words.length > 1 && GENERIC_IN_SLUG.has(words.at(-1)!)) words.pop()
  // "ai", "go" and other two-letter names lose here. Deliberate: a two-letter
  // token is far more often an abbreviation in a slug than a vendor, and a
  // one-word search for one buys a page of noise.
  if (words.join("").length < 3) return null
  return words.join(" ")
}

/**
 * The rivals an anchor names in its own comparison urls.
 *
 * Free by construction: these are the urls `rank()` already threw away, out of
 * a sitemap every run already downloads. On the measured sitemap above the 36
 * separator-carrying urls gave 26 distinct names, every one of them a company
 * — and five of those names were absent, as companies, from the 4,251-entity
 * map the run that downloaded those same bytes produced.
 *
 * PRECISION IS NOT THE SAME AS PROOF. An earlier count of the same namespace,
 * taken before any filtering, found 22 of its 34 raw tokens already on that
 * map — the channel is precise rather than noisy. Precise still does not make
 * a token an entity. See `RivalLead`: every one of these is a lead to be
 * resolved and judged, never a rival to be written down.
 */
export function rivalsFromComparisonUrls(
  urls: readonly string[],
  anchor: string,
  limit = 40,
): RivalLead[] {
  const mine = anchorWords(anchor)
  const found = new Map<string, RivalLead>()
  for (const url of urls) {
    const path = pathOf(url)
    if (!path) continue
    const segs = path.split("/").filter(Boolean)
    const slug = segs[1] ?? ""
    if (!slug) continue

    let sides: string[] = []
    if (COMPARISON.test(path)) {
      const ns = segs[0]!.toLowerCase()
      const parts = slug.split(VS)
      // `a-vs-b-vs-c` is three rivals on one page, which is the roundup shape
      // and the densest url in the whole namespace.
      sides = parts.length > 1 ? parts : NAMES_ONE_RIVAL.test(ns) ? [slug] : []
    } else if (segs.length === 2 && !CONTENT.test(path)) {
      // The comparison that lives in the SLUG rather than the namespace.
      // MEASURED on one proxy vendor's sitemap (6,845 urls, fetched
      // 2026-08-16): 135 comparison-shaped urls, zero of them under a
      // comparison namespace — the whole strategy is `/solutions/<rival>-
      // alternative`, over a hundred pages, and the namespace gate alone read
      // none of it. Depth two only: the same sitemap's `/faqs/json/json-vs-xml`
      // shapes sit at depth three and name formats, not vendors. CONTENT is
      // excluded because a blog's `-vs-` slug is an essay about a comparison,
      // not the anchor naming whom it competes with.
      // A COMPARISON OF NAMES IS SHORT; AN ESSAY TITLE IS NOT. Measured on one
      // auth vendor's sitemap: `/articles/oidc-vs-saml-for-enterprise-sso-a-
      // 2026-decision-guide` yielded "oidc", and `/articles/the-real-cost-of-
      // enterprise-sso-per-connection-vs-per-mau-p-2` yielded "per mau p 2" —
      // seventeen leads of which three held a real company name, and the run
      // spent query budget on `oidc alternatives` and `scim alternatives`.
      // Real comparison slugs run three to six words: `shopify-vs-woocommerce`
      // is three, `bigcommerce-vs-salesforce-vs-shopify` five. Past that the
      // slug is a sentence, and a sentence is an article about a comparison
      // rather than the anchor naming whom it competes with.
      const slugWords = slug.split(/[^a-z0-9]+/i).filter(Boolean).length
      if (slugWords <= 6) {
        if (/-alternatives?$/i.test(slug)) {
          // `<rival>-alternative` is implicitly anchored: alternative TO US.
          sides = slug.split(VS)
        } else if (VS.test(slug)) {
          // A symmetric `-vs-` outside a comparison namespace names rivals
          // only when the anchor is one of the sides. MEASURED on vercel.com:
          // its /i/ namespace is an encyclopedia — svelte-vs-react,
          // a2a-vs-mcp, graphql-vs-grpc, 40 leads of which one involved the
          // company — and reading it as self-comparison put "react" and
          // "next js" on the rival list of the company that MAKES next.js. A
          // company comparing itself puts itself in the slug.
          const parts = slug.split(VS)
          const anchorSide = parts.some((part) =>
            part.toLowerCase().split(/[^a-z0-9]+/).some((w) => mine.has(w)),
          )
          if (anchorSide) sides = parts
        }
      }
    }

    for (const side of sides) {
      const name = rivalName(side, mine)
      if (!name) continue
      const prev = found.get(name)
      if (prev) prev.seen += 1
      else found.set(name, { name, seen: 1, foundAt: url })
    }
  }
  return [...found.values()]
    // Most-named first: a company the anchor wrote three comparison pages about
    // is more central to its market than one it wrote a single page about.
    // Alphabetical within a tie, so two runs of the same sitemap agree.
    .sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** The same read, from the sitemap bytes rather than from a url list — the form
 *  the sweep calls, beside `candidatesFromSitemap` and over the identical
 *  `<loc>` entries. Two consumers, one download, no second fetch. */
export function rivalsFromSitemap(xml: string, anchor: string, limit = 40): RivalLead[] {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
  return rivalsFromComparisonUrls(locs, anchor, limit)
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

/**
 * Drop pages that are the same page twice.
 *
 * Measured: `/platform` and `/platform/connected-apps-platform` returned a
 * byte-identical title and description, so the flagship was counted twice and a
 * slot was spent saying nothing. Deduping on the path cannot see this; two urls
 * really are two urls.
 */
export function dedupeFacts(facts: readonly PageFacts[]): PageFacts[] {
  const seen = new Set<string>()
  const out: PageFacts[] = []
  for (const f of facts) {
    const key = `${f.title}|${f.description}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** The block handed to the model, one line per page. */
export function renderPageFacts(facts: readonly PageFacts[]): string {
  return dedupeFacts(facts)
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
