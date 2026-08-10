import { outboundHosts } from "./verdict.js"
import { registrableHost } from "./url.js"

/** Escape a string for literal use inside a RegExp. Shared by the host
 *  matcher below and the description-grounding meter (grounding.ts), so the
 *  two cannot drift on what counts as a literal. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Does this text name this host as a word of its own?
 *
 * A bare substring check over-collects: "io.com" sits inside "radio.com", and
 * a probe gate built on `includes` graded the map against pages that never
 * named the anchor at all. The boundary is anything that cannot be part of a
 * hostname — so "radio.com" does not name "io.com" and "bright-sdk.com" does
 * not name "sdk.com", while "see io.com/pricing" does. Case-insensitive:
 * pages shout, hosts do not.
 */
export function namesHost(text: string, host: string): boolean {
  return new RegExp(`(^|[^a-z0-9-])${escapeRe(host)}([^a-z0-9-]|$)`, "i").test(text)
}

export interface RecallProbe {
  url: string
  vendors: string[]
  found: string[]
  recall: number
}

export interface RecallReport {
  /** Sum(|found|) / Sum(|vendors|) across probes; null when no page qualified. */
  pooled: number | null
  probes: RecallProbe[]
  /**
   * Present only when a structural alias set (alias.ts) excluded hosts from
   * the key: which hosts, and the sentence the report must carry. It rides
   * INSIDE the recall object so it serializes wherever recall serializes —
   * both engines ship this object verbatim, and a reader comparing this run's
   * recall against an older one must see, beside the number, that the rise
   * is the instrument corrected, not the map improved.
   */
  aliasExclusion?: { hosts: string[]; note: string }
}

/**
 * The one defensible coverage number, and the run has already paid for it.
 *
 * A page that names the anchor and enumerates vendors is not a competitor —
 * it is an answer key. Recall against it needs no estimator and no
 * independence assumption (capture-recapture fails both here: the spec works
 * it through to a divide-by-zero). The probe list ships with the number so a
 * reader can disagree with the key rather than trust the percentage.
 */
export function answerKeyRecall(
  pages: ReadonlyArray<{ url: string; html: string }>,
  opts: {
    anchor: string
    mapHosts: ReadonlySet<string>
    minVendors?: number
    /**
     * The anchor's structural alias set (alias.ts `anchorAliasSet`) — hosts
     * the anchor's own pages and theirs mutually assert as one publisher.
     * When present, "minus the anchor" becomes "minus the alias set", in both
     * places the anchor was already subtracted: an alias-hosted page cannot
     * be a probe (the anchor must not grade itself in translation), and an
     * alias host cannot be a vendor (the anchor's own foreign property is
     * not a company the map missed). The recall rise this causes is
     * MECHANICAL — a bug fix in the instrument, not a coverage improvement —
     * and the returned `aliasExclusion.note` says so beside the number.
     */
    anchorAliases?: ReadonlySet<string>
  },
): RecallReport {
  const minVendors = opts.minVendors ?? 5
  const anchor = registrableHost(opts.anchor)
  const excluded = new Set([anchor, ...[...(opts.anchorAliases ?? [])].map(registrableHost)])
  const probes: RecallProbe[] = []
  for (const p of pages) {
    if (opts.anchorAliases) {
      let probeHost = ""
      try {
        probeHost = registrableHost(new URL(p.url).hostname)
      } catch {
        /* unparseable probe URL: nothing to exclude by host */
      }
      if (probeHost && excluded.has(probeHost)) continue
    }
    if (!namesHost(p.html, anchor)) continue
    const vendors = outboundHosts(p.html, p.url).filter((h) => !excluded.has(h))
    if (vendors.length < minVendors) continue
    const found = vendors.filter((v) => opts.mapHosts.has(v))
    probes.push({ url: p.url, vendors, found, recall: vendors.length ? found.length / vendors.length : 0 })
  }
  const total = probes.reduce((n, p) => n + p.vendors.length, 0)
  const hit = probes.reduce((n, p) => n + p.found.length, 0)
  const aliasHosts = [...excluded].filter((h) => h !== anchor).sort()
  return {
    pooled: total ? hit / total : null,
    probes,
    ...(aliasHosts.length
      ? {
          aliasExclusion: {
            hosts: aliasHosts,
            note:
              `recall excludes ${aliasHosts.join(", ")}: the run's pages mutually assert ` +
              `${aliasHosts.length === 1 ? "it" : "them"} and the anchor as one publisher ` +
              `(reciprocal hreflang or mutual canonical). Any rise against runs without this ` +
              `exclusion is a bug fix in the instrument, not a coverage improvement.`,
          },
        }
      : {}),
  }
}
