import { afterEach, describe, expect, it, vi } from "vitest"
import { ANCHOR, HOSTS, SERP, runFixture } from "./fixture.js"

/**
 * Every run downloads the anchor's sitemap and reads it for product pages. A
 * company that publishes `/compare/<us>-vs-<them>` has also named its rivals in
 * that same file, for free, and until now those urls were filtered out and
 * dropped on the floor.
 *
 * MEASURED on shopify.com/sitemap.xml: 838 urls, 40 comparison urls, 26 rival
 * names, five of which appear as companies nowhere in the 4,251-entity map the
 * run that downloaded those bytes produced.
 */

/** The anchor's sitemap: two products, one blog post, four comparison urls and
 *  two of the separator-less slugs that are pages rather than companies. */
const SITEMAP =
  `<urlset>` +
  [
    "/products/log-search",
    "/products/uptime-alerts",
    "/blog/incident-review",
    "/compare/pellucid-vs-grepstack",
    "/compare/pellucid-vs-tailwatch",
    "/compare/loglens-vs-pellucid",
    "/compare/pellucid-vs-quicklogs",
    "/compare/tco",
    "/compare/time-to-value",
  ]
    .map((p) => `<url><loc>https://${ANCHOR}${p}</loc></url>`)
    .join("") +
  `</urlset>`

const withSitemap = {
  [`https://${ANCHOR}/sitemap.xml`]: {
    httpStatus: 200,
    contentType: "application/xml",
    body: SITEMAP,
  },
}

interface RivalsReport {
  found: number
  cap: number
  queries: number
  reachedMap: number
  leads: { name: string; seen: number; foundAt: string }[]
}
const rivalsOf = (r: Record<string, unknown>) => r.rivals as RivalsReport

afterEach(() => vi.restoreAllMocks())

describe("the comparison urls a company publishes about itself", () => {
  it("turns the sitemap's other half into rival-grounded queries, and buys them", async () => {
    const h = await runFixture({
      fetchTable: withSitemap,
      serp: {
        ...SERP,
        "grepstack alternatives": [
          { url: `https://${HOSTS.loglens}/`, title: "Loglens", description: "Priced on ingest." },
        ],
      },
    })

    const rivals = rivalsOf(h.result.report)
    // Four comparison urls, four names once the anchor's own token is stripped;
    // `/compare/tco` and `/compare/time-to-value` are pages, not companies.
    expect(rivals.found).toBe(4)
    expect(rivals.leads.map((l) => l.name)).toEqual([
      "grepstack",
      "loglens",
      "quicklogs",
      "tailwatch",
    ])
    // Every lead cites the url it was read off, so it can be checked.
    for (const l of rivals.leads) expect(l.foundAt).toContain("/compare/")

    // THE CAP IS THE RUN'S OWN BRANDED COUNT: three company-level queries plus
    // one for the single product whose name the catalog call did not call
    // generic. Nothing here is a constant.
    expect(rivals.cap).toBe(4)
    expect(rivals.queries).toBe(4)
    expect(h.result.report.families).toMatchObject({ rival: 4 })

    // Two thirds to the shortlist shape, the remainder to a pair — and the
    // queries reached the wire, in the shape core wrote them.
    expect(h.asked).toContain("grepstack alternatives")
    expect(h.asked).toContain("loglens alternatives")
    expect(h.asked).toContain("quicklogs alternatives")
    expect(h.asked).toContain("grepstack vs loglens")
  })

  it("never names the anchor in a rival query, whatever the slug said", async () => {
    const h = await runFixture({ fetchTable: withSitemap })
    const rival = h.asked.filter((q) => /grepstack|loglens|quicklogs|tailwatch/.test(q))
    expect(rival.length).toBeGreaterThan(0)
    for (const q of rival) expect(q.toLowerCase()).not.toContain("pellucid")
  })

  it("reports how many of the names it was handed ended up on the map", async () => {
    const h = await runFixture({ fetchTable: withSitemap })
    // grepstack, tailwatch and loglens are classified onto the map by this
    // market's script; quicklogs is a name the anchor published and nothing
    // ever found. That gap is the number this channel exists to make visible.
    expect(rivalsOf(h.result.report).reachedMap).toBe(3)
  })

  it("costs nothing and asks nothing when the company publishes no comparison pages", async () => {
    const h = await runFixture()
    const rivals = rivalsOf(h.result.report)
    expect(rivals).toMatchObject({ found: 0, queries: 0, reachedMap: 0, leads: [] })
    expect(h.result.report.families).not.toHaveProperty("rival")
    // And the run says nothing about a channel that had nothing to say.
    expect(h.says.some((s) => s.includes("rival-grounded"))).toBe(false)
  })
})
