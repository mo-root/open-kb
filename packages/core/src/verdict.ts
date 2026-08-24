import { registrableHost } from "./url.js"

/** What is being asserted about a host. Kind and relation are strings, not
 *  enums: core owns the rules, the sweep owns the vocabulary. */
export interface Claim {
  host: string
  kind: string
  relation: string
}

/** What the run learned by opening the host's own front page. */
export interface JudgedPage {
  url: string
  readable: boolean
  outboundHosts: string[]
}

export interface VerdictCtx {
  anchor: string
  /** N: distinct external registrable hosts a front page may link before it
   *  reads as a document that enumerates vendors. Measured by
   *  scripts/calibrate-kernel.ts, never guessed. */
  aggregatorThreshold: number
}

export type Admission =
  | { ok: true }
  | { ok: false; kind: string; relation: string; because: string }

const COMMERCIAL = new Set(["competitor", "substitute"])
const COMPANY_LIKE = new Set(["company", "product"])

/** Distinct external registrable hosts a page links to. The shape test that
 *  replaces a denylist: nothing here names G2 or Thomasnet, so an unlisted
 *  vertical's dominant directory is caught by the same arithmetic. */
export function outboundHosts(html: string, pageUrl: string): string[] {
  let self = ""
  try { self = registrableHost(new URL(pageUrl).hostname) || "" } catch { /* unparseable: no self to exclude */ }
  const hosts = new Set<string>()
  for (const m of html.matchAll(/href=["'](?:https?:)?\/\/([^/"'\s:?#]+)/gi)) {
    const h = registrableHost(m[1]!)
    if (h && h !== self) hosts.add(h)
  }
  return [...hosts]
}

/**
 * ONE DIRECTORY, SEVEN ROWS — measured, unfixed, and the naive fix is unsafe.
 *
 * A map carries every registrable domain it finds, so a directory that runs
 * per-country mirrors lands once per country. Grouping on-map rows by the
 * brand label of their registrable domain, on two recent runs:
 *
 *   shopify     getapp x7   capterra x7   softwareadvice x4    18 rows
 *   cloudflare  capterra x4                                     4 rows
 *
 * getapp.com.mx, getapp.com.au, getapp.ie, getapp.co.nz, getapp.ca … are one
 * company. A reader who counts Capterra seven times reads that as sloppiness,
 * and it is about 1.5% of the map.
 *
 * It connects to the unlock decision at judge.ts: this same population is what
 * the 4xx-walled hosts turn out to BE, because per-country listing mirrors are
 * the sites that wall a datacentre fetcher hardest.
 *
 * FOLDING ON THE BRAND LABEL WOULD BE WRONG, which is why nothing here does
 * it. The same grouping puts `go.dev` with `go.jp` and `opensource.com` with
 * `opensource.to` — different owners entirely — beside true mirrors like
 * `amazon.co.uk`/`amazon.com` and `sourceforge.io`/`sourceforge.net`. A fold
 * that cannot tell those apart trades seven honest duplicates for a merge that
 * invents a relationship, which is the trade this file exists to refuse.
 *
 * THE SECOND SIGNAL DOES NOT RESCUE IT EITHER, and that was worth testing
 * rather than assuming, because the pipeline already knows each host's
 * classified `name` and an obvious fix is "fold when the names agree too".
 *
 * Exact agreement is too strict. The seven GetApp mirrors are named "GetApp",
 * "GetApp México", "GetApp Australia", "GetApp Ireland" — one company, four
 * names — so requiring equality refuses the folds that are actually right.
 *
 * Prefix agreement is too loose, and loose in the dangerous direction. Both
 * `opensource.to` ("Opensource.to") and `opensource.com` ("Opensource.com")
 * start with the brand, as do `static.run` and `static.app`. It would merge
 * every one of those.
 *
 * So neither rule separates a mirror from a collision, and the fold stays
 * unbuilt on evidence rather than on caution.
 *
 * Recorded so the count is known and the trap is known with it.
 */

/**
 * The gate on a classification. The model still says what a host is; this
 * refuses claims whose evidence does not support them. A refusal downgrades,
 * it never deletes — the caller keeps the node with `because` attached.
 *
 * Why this exists: the mint proves a quote came from a page, never that it was
 * the right page. An audit found 121 of 207 entities wrong through exactly that
 * gap — comparison pages ranking the anchor, recorded as rivals.
 */
export function admit(claim: Claim, page: JudgedPage | null, ctx: VerdictCtx): Admission {
  // A page that enumerates many vendors is a document, not a company.
  if (COMPANY_LIKE.has(claim.kind) && page?.readable && page.outboundHosts.length >= ctx.aggregatorThreshold) {
    return {
      ok: false,
      kind: "directory",
      relation: "lists",
      because: `its front page links ${page.outboundHosts.length} distinct vendor domains; a page that enumerates vendors is a document, not a company`,
    }
  }
  // A commercial stance needs the host's own page behind it.
  if (COMMERCIAL.has(claim.relation) && !page?.readable) {
    return {
      ok: false,
      kind: claim.kind,
      relation: "unknown",
      because: "nothing on its own site says it does this — the front page could not be read this run",
    }
  }
  return { ok: true }
}
