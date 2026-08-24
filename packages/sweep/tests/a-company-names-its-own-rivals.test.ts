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

  it("hands the harvested names to the model that writes queries", async () => {
    // The collision shape asks the model to cross players it knows. Measured
    // gap: hand-written queries name a third party 42.8% of the time, model
    // queries 0.85% — and one structural cause was that the catalog call
    // carried no names at all. Now it carries the run's own harvest.
    const h = await runFixture({ fetchTable: withSitemap })
    const catalog = h.calls.find((c) => c.phase === "catalog")
    expect(catalog, "a catalog call").toBeDefined()
    expect(catalog!.prompt).toContain("names in hand")
    for (const name of ["grepstack", "tailwatch", "loglens", "quicklogs"]) {
      expect(catalog!.prompt).toContain(name)
    }
  })

  it("finds the sitemap robots.txt names when the conventional path 404s", async () => {
    /**
     * `/sitemap.xml` is a convention, not a rule. stripe.com 404s there and
     * names `/sitemap/sitemap.xml` in robots.txt; sentry.io names
     * `/sitemap-index.xml`. Those two anchors are exactly the two that
     * reported `rivals.found: 0` — stripe on all three of its runs — which was
     * being read as "publishes no comparison pages" when nothing had been read
     * at all.
     */
    const h = await runFixture({
      fetchTable: {
        // The conventional path is absent, as it is on stripe.com.
        [`https://${ANCHOR}/robots.txt`]: {
          httpStatus: 200,
          contentType: "text/plain",
          body: `User-agent: *\nSitemap: https://${ANCHOR}/sitemap/sitemap.xml\n`,
        },
        [`https://${ANCHOR}/sitemap/sitemap.xml`]: {
          httpStatus: 200,
          contentType: "application/xml",
          body: SITEMAP,
        },
      },
    })
    const rv = h.result.report.rivals as { found: number; urlsScanned: number }
    expect(rv.urlsScanned).toBeGreaterThan(0)
    expect(rv.found).toBe(4)
  }, 30_000)

  it("does not follow a robots.txt sitemap pointing at another host", async () => {
    // robots.txt is the anchor's own file, but a `Sitemap:` line pointing
    // off-site is not something to follow on its say-so.
    const h = await runFixture({
      fetchTable: {
        [`https://${ANCHOR}/robots.txt`]: {
          httpStatus: 200,
          contentType: "text/plain",
          body: `Sitemap: https://elsewhere.example/sitemap.xml\n`,
        },
        "https://elsewhere.example/sitemap.xml": {
          httpStatus: 200,
          contentType: "application/xml",
          body: SITEMAP,
        },
      },
    })
    const rv = h.result.report.rivals as { found: number; urlsScanned: number }
    expect(rv.urlsScanned).toBe(0)
    expect(rv.found).toBe(0)
  }, 30_000)

  it("separates an anchor with no comparison pages from a run with no sitemap", async () => {
    /**
     * `found: 0` had two readings and no way to tell them apart. stripe.com is
     * the case: three runs, zero names, and no way to know whether its sitemap
     * was empty, unreachable, or simply free of /vs/ pages.
     *
     * `urlsScanned` high with `found` 0 is "this anchor publishes no
     * comparison pages", which is a fact about the anchor. `urlsScanned` 0 is
     * a source never read, which is a fixable problem.
     */
    const h = await runFixture({
      fetchTable: {
        [`https://${ANCHOR}/sitemap.xml`]: {
          httpStatus: 200,
          contentType: "application/xml",
          body:
            `<urlset>` +
            [`/pricing`, `/docs`]
              .map((path) => `<url><loc>https://${ANCHOR}${path}</loc></url>`)
              .join("") +
            `</urlset>`,
        },
      },
    })
    const rv = h.result.report.rivals as { found: number; urlsScanned: number }
    // Two urls offered, neither a comparison page: the charitable reading,
    // confirmed rather than assumed.
    expect(rv.urlsScanned).toBe(2)
    expect(rv.found).toBe(0)
  }, 30_000)

  it("says so plainly when there are no names to hand over", async () => {
    const h = await runFixture()
    const catalog = h.calls.find((c) => c.phase === "catalog")
    expect(catalog!.prompt).toContain("(none harvested")
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
