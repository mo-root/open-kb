import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ProductsTab } from "./ProductsTab"
import type { NoteRef } from "@/lib/viewTypes"

/**
 * THE TAB WHERE THE COMPANY SPEAKS FOR ITSELF.
 *
 * Everything below the catalog on this tab is the classifier judging strangers.
 * Two blocks above it are not: the integrations the anchor's own docs claim,
 * and the rivals it names on its own comparison pages. Both were written by
 * every run since the understand stage learned to keep them and read by
 * nothing, which is the defect these tests hold shut.
 *
 * AND BOTH MUST VANISH CLEANLY. Every map in the committed gallery predates
 * them, so the shape that has to be pinned twice is "renders the riches" and
 * "renders no heading over an empty list" — a section head with a 0 beside it
 * is how a reader learns a company has no partners, which is not what the file
 * says.
 */

function note(domain: string, over: Partial<NoteRef> = {}): NoteRef {
  return {
    path: `players/${domain}.md`,
    title: domain,
    relevance: 60,
    type: "player",
    kind: "company",
    relation: "competitor",
    domain,
    what: `what ${domain} does`,
    why: `why ${domain} is here`,
    ...over,
  }
}

const notes: NoteRef[] = [note("postmarkapp.com"), note("mailgun.com")]

const integrations = [
  {
    with: "Supabase",
    does: "Send transactional emails from Supabase projects.",
    foundAt: "https://resend.com/features/smtp-service",
  },
  { with: "Zapier", does: "Automate emails using Zapier." },
]

const rivalLeads = [
  { name: "postmark", foundAt: "https://resend.com/migrate/postmark" },
  { name: "mailgun", foundAt: "https://resend.com/migrate/mailgun" },
]

/**
 * THE CATALOG BLOCK HAD NO TEST AT ALL. `catalog`, `readPages`, `markets` and
 * `strips` never appeared in this file — every card, link and heading in
 * "What <brand> sells" rendered untested, including the four sibling
 * `try { new URL(x).pathname } catch { return x }` fallbacks the catalog,
 * strip, integration and read-page links each carry their own copy of.
 *
 * `foundAt` on a catalog or strip entry is a model-written string
 * (`decomposition.products[].foundAt`, `report.strips[].foundAt` —
 * kb-from-run.ts keeps it verbatim, no URL validation), so a relative path or
 * bare title reaching `new URL()` is a real shape, not a hypothetical one.
 * Confirmed by dropping the catch on the catalog card's copy and re-running:
 * `new URL("docs/templates")` throws "Invalid URL" uncaught, taking the whole
 * tab down with it — restored before committing.
 */
describe("the catalog — what the company says it sells", () => {
  it("renders product cards, the pages they were read from, markets and search-term strips", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={notes}
        catalog={[
          { name: "Transactional Email API", does: "Send emails from code.", foundAt: "https://resend.com/docs/send" },
        ]}
        readPages={["https://resend.com/pricing"]}
        markets={[
          {
            name: "Transactional email",
            does: "Send email from application code.",
            centrality: "core",
            covers: ["send", "deliver"],
          },
        ]}
        strips={[
          {
            product: "Transactional Email API",
            terms: ["email api", "smtp service"],
            generic: false,
            foundAt: "https://resend.com/docs/send",
          },
        ]}
        brand="Resend"
        openNote={() => {}}
      />,
    )
    expect(html).toContain("What Resend sells")
    expect(html).toContain("Transactional Email API")
    expect(html).toContain("/docs/send")
    expect(html).toContain("/pricing")
    expect(html).toContain("grouped into 1 markets")
    expect(html).toContain("Transactional email")
    expect(html).toContain("stripped to 1 search term")
    expect(html).toContain("email api")
  })

  it("falls back to the raw string, not a thrown error, when a catalog or strip link is not a valid URL", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={notes}
        catalog={[{ name: "Email Templates", does: "Design emails in React.", foundAt: "docs/templates" }]}
        strips={[
          { product: "Email Templates", terms: ["email templates"], generic: false, foundAt: "docs/templates" },
        ]}
        brand="Resend"
        openNote={() => {}}
      />,
    )
    expect(html).toContain("docs/templates")
  })

  /**
   * The catalog and strip cases above leave the OTHER two `try { new
   * URL(x).pathname } catch { return x }` copies in this same 181-292 block
   * unexercised: the "read from:" link (line 205) walks `readPages`, a plain
   * `string[]` kept verbatim from `report.readPages` in kb-from-run.ts:685 —
   * no URL validation, same unchecked-model-output shape as `foundAt`.
   * Confirmed by dropping this catch (`new URL(u).pathname || "/"`, no try)
   * and re-running: "Invalid URL" escaped uncaught, taking the tab down.
   * Restored before committing.
   */
  it("falls back to the raw string when a read-from page is not a valid URL", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={notes}
        catalog={[{ name: "Email Templates", does: "Design emails in React." }]}
        readPages={["docs/pricing"]}
        brand="Resend"
        openNote={() => {}}
      />,
    )
    expect(html).toContain("docs/pricing")
  })
})

describe("what the company published about itself", () => {
  it("renders each integration as a card, with the page that claimed it", () => {
    const html = renderToStaticMarkup(
      <ProductsTab notes={notes} integrations={integrations} brand="Resend" openNote={() => {}} />,
    )
    // The heading carries an apostrophe React escapes, so it is matched on the
    // half of the sentence that survives verbatim.
    expect(html).toContain("Integrations, from the company")
    expect(html).toContain("Supabase")
    expect(html).toContain("Send transactional emails from Supabase projects.")
    // The claim and its receipt, the same pathname-truncated link the catalog
    // cards above it wear.
    expect(html).toContain('href="https://resend.com/features/smtp-service"')
    expect(html).toContain("/features/smtp-service")
    // An entry the run recorded without a url is still a claim worth showing;
    // it simply carries no link.
    expect(html).toContain("Automate emails using Zapier.")
  })

  /**
   * The fourth of the four sibling `try { new URL(x).pathname } catch {
   * return x }` copies SELF-249 named but did not itself drive: the
   * integration card's link (line 334). `integrations[].foundAt` is kept
   * verbatim by kb-from-run.ts:287 (a trim check, no URL validation), the
   * same unchecked-model-output shape as the catalog/strip `foundAt`s SELF-249
   * covered. Confirmed by dropping this catch and re-running: "Invalid URL"
   * escaped uncaught from inside the render. Restored before committing.
   */
  it("falls back to the raw string, not a thrown error, when an integration's link is not a valid URL", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={notes}
        integrations={[{ with: "Docs Site", does: "Reads its own docs.", foundAt: "docs/integrations" }]}
        brand="Resend"
        openNote={() => {}}
      />,
    )
    expect(html).toContain("docs/integrations")
  })

  it("states the rival count off the list it is printing, and links every lead", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={notes}
        rivalLeads={rivalLeads}
        rivalsOnMap={1}
        brand="Resend"
        openNote={() => {}}
      />,
    )
    expect(html).toContain("names 2 rivals on its own")
    expect(html).toContain('href="https://resend.com/migrate/postmark"')
    expect(html).toContain('href="https://resend.com/migrate/mailgun"')
    // The run's own honesty check: it named two, this map holds one of them.
    expect(html).toContain("of them match a row on this map")
    expect(html).toContain(">1</span>")
  })

  it("says nothing about how many reached the map when the run never measured it", () => {
    const html = renderToStaticMarkup(
      <ProductsTab notes={notes} rivalLeads={rivalLeads} openNote={() => {}} />,
    )
    expect(html).toContain("names 2 rivals on its own")
    expect(html).not.toContain("match a row on this map")
  })

  it("draws neither block for a map recorded before either existed", () => {
    const html = renderToStaticMarkup(<ProductsTab notes={notes} openNote={() => {}} />)
    expect(html).not.toContain("Integrations, from the company")
    expect(html).not.toContain("rivals on its own")
    // And the rest of the tab is untouched by their absence.
    expect(html).toContain("postmarkapp.com")
  })
})

/**
 * The roads on a card: the literal queries that returned this host, in the
 * drawer that already answers "why this one". The sentence beside them is a
 * judgement about the row; this is the retrieval that produced it.
 */
describe("the searches behind a card", () => {
  it("prints the queries that surfaced the host", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={[note("postmarkapp.com", { roads: ["transactional email api", "postmark alternative"] })]}
        openNote={() => {}}
      />,
    )
    expect(html).toContain("searched")
    expect(html).toContain("transactional email api")
    expect(html).toContain("postmark alternative")
  })

  /** The rows a skeptical reader clicks first are the ones whose front page the
   *  run could not read: no `what`, no `why`, and until now no drawer at all.
   *  The query that found them survives when the judgement does not. */
  it("opens the drawer for a blank row that still knows what was typed", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={[
          note("g2.com", { kind: "unknown", relation: "unknown", what: "", why: "", roads: ["best email api"] }),
        ]}
        openNote={() => {}}
      />,
    )
    expect(html).toContain("why this one")
    expect(html).toContain("best email api")
  })

  it("draws no drawer at all when the row knows neither", () => {
    const html = renderToStaticMarkup(
      <ProductsTab
        notes={[note("g2.com", { kind: "unknown", relation: "unknown", what: "", why: "" })]}
        openNote={() => {}}
      />,
    )
    expect(html).toContain("g2.com")
    expect(html).not.toContain("why this one")
  })
})
