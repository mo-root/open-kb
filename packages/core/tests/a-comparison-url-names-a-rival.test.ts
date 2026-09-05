import { describe, expect, it } from "vitest"
import {
  candidatesFromSitemap,
  rivalsFromComparisonUrls,
  rivalsFromSitemap,
} from "../src/catalog.js"

/**
 * The slug shapes here are real ones, taken off shopify.com/sitemap.xml
 * (838 urls, fetched 2026-08-12) and ramp.com, which is where the extraction's
 * rules came from. The four rejected `/compare/*` slugs are that file's four
 * separator-less urls, and not one of them is a company.
 */

const u = (host: string, path: string) => `https://${host}${path}`

describe("rivalsFromComparisonUrls", () => {
  it("reads both sides of a `-vs-` slug and drops the anchor's own", () => {
    const leads = rivalsFromComparisonUrls(
      [u("www.shopify.com", "/compare/shopify-vs-woocommerce")],
      "shopify.com",
    )
    expect(leads.map((l) => l.name)).toEqual(["woocommerce"])
    expect(leads[0]).toMatchObject({
      seen: 1,
      foundAt: "https://www.shopify.com/compare/shopify-vs-woocommerce",
    })
  })

  it("reads a three-way roundup as three rivals, minus the anchor", () => {
    const leads = rivalsFromComparisonUrls(
      [u("shopify.com", "/compare/bigcommerce-vs-salesforce-vs-shopify")],
      "shopify.com",
    )
    expect(leads.map((l) => l.name).sort()).toEqual(["bigcommerce", "salesforce"])
  })

  it("takes the single segment under a namespace that IS the comparison", () => {
    const leads = rivalsFromComparisonUrls(
      [u("ramp.com", "/versus/brex"), u("ramp.com", "/alternatives/expensify")],
      "ramp.com",
    )
    expect(leads.map((l) => l.name).sort()).toEqual(["brex", "expensify"])
  })

  it("refuses a bare `/compare/<slug>`, which is where the non-names live", () => {
    const leads = rivalsFromComparisonUrls(
      [
        u("shopify.com", "/compare"),
        u("shopify.com", "/compare/tco"),
        u("shopify.com", "/compare/tco/webinar"),
        u("shopify.com", "/compare/time-to-value"),
        u("shopify.com", "/compare/sitespeed"),
      ],
      "shopify.com",
    )
    expect(leads).toEqual([])
  })

  it("strips the anchor wearing a tier, and keeps the rival beside it", () => {
    const leads = rivalsFromComparisonUrls(
      [
        u("shopify.com", "/compare/shopify-enterprise-vs-adobe"),
        u("shopify.com", "/compare/shopify-enterprise-vs-salesforce-commercecloud"),
      ],
      "shopify.com",
    )
    // Multi-word slugs stay one name: `salesforce-commercecloud` is a product
    // line, not two companies.
    expect(leads.map((l) => l.name).sort()).toEqual(["adobe", "salesforce commercecloud"])
  })

  it("drops a side that is all framing and no company", () => {
    const leads = rivalsFromComparisonUrls(
      [
        u("shopify.com", "/compare/shopify-vs-custom-platform"),
        u("shopify.com", "/compare/shopify-vs-open-source"),
      ],
      "shopify.com",
    )
    expect(leads.map((l) => l.name)).toEqual([])
  })

  /**
   * `rivalName`'s three guards below the anchor/all-generic checks had never
   * run: every fixture in this file names a rival in one to three plain
   * words, so the >4-word ceiling, the leading-generic-word strip, and the
   * two-letter floor were dead code by coverage, not by construction.
   */
  it("refuses a side that runs past four words, same as an essay title would", () => {
    const leads = rivalsFromComparisonUrls(
      [u("shopify.com", "/compare/shopify-vs-my-really-long-competitor-name-here")],
      "shopify.com",
    )
    expect(leads).toEqual([])
  })

  it("strips a generic word stuck to the FRONT of a real name, not just the back", () => {
    const leads = rivalsFromComparisonUrls(
      [u("shopify.com", "/compare/best-globex-corp-vs-shopify")],
      "shopify.com",
    )
    expect(leads.map((l) => l.name)).toEqual(["globex corp"])
  })

  it("refuses a two-letter side that is neither the anchor nor generic filler", () => {
    // Same rule the file comment already states: "ai", "go" and other
    // two-letter names lose here, deliberately, because a one-word search
    // for one buys a page of noise.
    const leads = rivalsFromComparisonUrls(
      [u("shopify.com", "/compare/ai-vs-shopify")],
      "shopify.com",
    )
    expect(leads).toEqual([])
  })

  it("takes the framing off a name and leaves the name", () => {
    const leads = rivalsFromComparisonUrls(
      [
        u("acme.com", "/compare/acme-vs-webflow-pricing"),
        u("acme.com", "/compare/acme-vs-wix-2024"),
      ],
      "acme.com",
    )
    expect(leads.map((l) => l.name).sort()).toEqual(["webflow", "wix"])
  })

  it("reads `/migrate/<rival>` — a migration guide is about whoever the buyer is leaving", () => {
    // The real shape, off resend.com/migrate/sitemap.xml (fetched 2026-08-16):
    // five slugs, every one a rival, no framing pages beside them.
    const leads = rivalsFromComparisonUrls(
      [
        u("resend.com", "/migrate/customer-io"),
        u("resend.com", "/migrate/mailchimp"),
        u("resend.com", "/migrate/mailgun"),
        u("resend.com", "/migrate/postmark"),
        u("resend.com", "/migrate/sendgrid"),
      ],
      "resend.com",
    )
    expect(leads.map((l) => l.name).sort()).toEqual([
      "customer io",
      "mailchimp",
      "mailgun",
      "postmark",
      "sendgrid",
    ])
  })

  it("reads the comparison that lives in the slug, not the namespace", () => {
    // The other real shape, off brightdata.com (6,845 urls, fetched
    // 2026-08-16): 135 comparison-shaped urls and not one under a comparison
    // namespace — `/solutions/<rival>-alternative`, over a hundred times.
    const leads = rivalsFromComparisonUrls(
      [
        u("brightdata.com", "/solutions/zyte-alternative"),
        u("brightdata.com", "/solutions/scrapy-alternative"),
        u("brightdata.com", "/solutions/parsehub-alternative"),
      ],
      "brightdata.com",
    )
    expect(leads.map((l) => l.name).sort()).toEqual(["parsehub", "scrapy", "zyte"])
  })

  it("refuses the slug shape at depth three and in content namespaces", () => {
    const leads = rivalsFromComparisonUrls(
      [
        // Depth three: formats arguing, not vendors. Real url, same sitemap.
        u("brightdata.com", "/faqs/json/json-vs-xml"),
        // A blog's `-vs-` slug is an essay about a comparison, not the anchor
        // naming whom it competes with.
        u("brightdata.com", "/blog/playwright-vs-puppeteer"),
        // A bare offering page wearing no comparison shape at all.
        u("brightdata.com", "/solutions/ecommerce"),
      ],
      "brightdata.com",
    )
    expect(leads).toEqual([])
  })

  it("refuses an essay title wearing a -vs- slug, however many it publishes", () => {
    // MEASURED, and it was a regression: one auth vendor publishes comparison
    // ESSAYS under /articles/, and reading their slugs produced seventeen
    // leads of which three held a company name — "oidc", "scim", "build",
    // "per mau p 2", "scale economics 3" — and the run spent real query
    // budget on `oidc alternatives`. Two guards, both needed: an article
    // namespace is content, and a comparison of names is short where an
    // essay title is not.
    const leads = rivalsFromComparisonUrls(
      [
        u("clerk.com", "/articles/oidc-vs-saml-for-enterprise-sso-a-2026-decision-guide"),
        u("clerk.com", "/articles/the-real-cost-of-enterprise-sso-per-connection-vs-per-mau-p-2"),
        u("clerk.com", "/articles/scim-vs-jit-provisioning-when-to-use-each"),
        u("clerk.com", "/articles/clerk-vs-auth0-which-authentication-platform-fits-your-team"),
        u("clerk.com", "/blog/multi-tenant-vs-single-tenant"),
      ],
      "clerk.com",
    )
    expect(leads).toEqual([])
  })

  it("keeps the short slug shapes that really do name companies", () => {
    // The guard must not eat the shapes it was written around: a dedicated
    // comparison namespace, a migration guide, and the slug-shape a proxy
    // vendor publishes a hundred of.
    const names = (urls: string[], anchor: string) =>
      rivalsFromComparisonUrls(urls, anchor).map((l) => l.name).sort()
    expect(names([u("www.shopify.com", "/compare/bigcommerce-vs-salesforce-vs-shopify")], "shopify.com")).toEqual([
      "bigcommerce",
      "salesforce",
    ])
    expect(names([u("brightdata.com", "/solutions/zyte-alternative")], "brightdata.com")).toEqual(["zyte"])
    expect(names([u("resend.com", "/migrate/sendgrid")], "resend.com")).toEqual(["sendgrid"])
  })

  it("refuses an encyclopedia: a -vs- slug outside a comparison namespace needs the anchor on a side", () => {
    // MEASURED on vercel.com: its /i/ namespace compares OTHER PEOPLE'S
    // technologies — svelte-vs-react, a2a-vs-mcp, graphql-vs-grpc — forty
    // leads of which one involved the company, and reading them as
    // self-comparisons put "react" and "next js" on the rival list of the
    // company that makes Next.js.
    const leads = rivalsFromComparisonUrls(
      [
        u("vercel.com", "/i/svelte-vs-react"),
        u("vercel.com", "/i/a2a-vs-mcp"),
        u("vercel.com", "/i/graphql-vs-grpc"),
        u("vercel.com", "/i/cursor-vs-claude-code"),
      ],
      "vercel.com",
    )
    expect(leads).toEqual([])
  })

  it("keeps the anchored -vs- slug in the same loose namespace", () => {
    const leads = rivalsFromComparisonUrls(
      [u("vercel.com", "/i/vercel-ai-gateway-vs-openrouter")],
      "vercel.com",
    )
    // The anchor's own side is dropped by name, the other side stays.
    expect(leads.map((l) => l.name)).toEqual(["openrouter"])
  })

  it("counts how often a name was published and puts the most-named first", () => {
    const leads = rivalsFromComparisonUrls(
      [
        u("shopify.com", "/compare/shopify-vs-wix"),
        u("shopify.com", "/compare/godaddy-vs-wix-vs-shopify"),
        u("shopify.com", "/compare/shopify-vs-etsy"),
      ],
      "shopify.com",
    )
    expect(leads.map((l) => `${l.seen} ${l.name}`)).toEqual(["2 wix", "1 etsy", "1 godaddy"])
  })

  it("reads a comparison url that sits under a locale prefix", () => {
    const leads = rivalsFromComparisonUrls(
      [u("shopify.com", "/de-de/compare/shopify-vs-magento")],
      "shopify.com",
    )
    expect(leads.map((l) => l.name)).toEqual(["magento"])
  })

  it("returns NAMES, never domains — a lead has to be resolved like any host", () => {
    const leads = rivalsFromComparisonUrls(
      [u("shopify.com", "/compare/shopify-vs-woocommerce")],
      "shopify.com",
    )
    for (const l of leads) {
      expect(l.name).not.toContain(".")
      expect(l.name).not.toContain("/")
    }
  })

  it("honours the limit and stays stable between two reads of one sitemap", () => {
    const urls = ["wix", "magento", "etsy", "webflow"].map((r) =>
      u("shopify.com", `/compare/shopify-vs-${r}`),
    )
    expect(rivalsFromComparisonUrls(urls, "shopify.com", 2).map((l) => l.name)).toEqual([
      "etsy",
      "magento",
    ])
    expect(rivalsFromComparisonUrls(urls, "shopify.com")).toEqual(
      rivalsFromComparisonUrls(urls, "shopify.com"),
    )
  })
})

describe("rivalsFromSitemap", () => {
  const xml =
    `<urlset>` +
    [
      "/products/checkout",
      "/pricing",
      "/blog/how-to-sell",
      "/compare/acme-vs-woocommerce",
      "/compare/acme-vs-magento",
      "/compare/tco",
    ]
      .map((p) => `<url><loc>https://acme.com${p}</loc></url>`)
      .join("") +
    `</urlset>`

  it("reads the rivals out of the same bytes the product hunt reads", () => {
    expect(rivalsFromSitemap(xml, "acme.com").map((l) => l.name)).toEqual([
      "magento",
      "woocommerce",
    ])
  })

  it("takes nothing the product hunt wanted, and leaves it nothing", () => {
    const products = candidatesFromSitemap(xml).map((c) => c.url)
    const rivals = rivalsFromSitemap(xml, "acme.com").map((l) => l.foundAt)
    expect(products).toEqual([
      "https://acme.com/pricing",
      "https://acme.com/products/checkout",
    ])
    expect(products.filter((p) => rivals.includes(p))).toEqual([])
  })

  it("finds nothing in a sitemap with no comparison pages, and says so quietly", () => {
    expect(rivalsFromSitemap(`<urlset><url><loc>https://acme.com/pricing</loc></url></urlset>`, "acme.com")).toEqual([])
    expect(rivalsFromSitemap("", "acme.com")).toEqual([])
  })
})
