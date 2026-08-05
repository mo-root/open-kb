import { outboundHosts } from "./verdict.js"
import { registrableHost } from "./url.js"

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
  opts: { anchor: string; mapHosts: ReadonlySet<string>; minVendors?: number },
): RecallReport {
  const minVendors = opts.minVendors ?? 5
  const anchor = registrableHost(opts.anchor)
  const probes: RecallProbe[] = []
  for (const p of pages) {
    if (!p.html.toLowerCase().includes(anchor)) continue
    const vendors = outboundHosts(p.html, p.url).filter((h) => h !== anchor)
    if (vendors.length < minVendors) continue
    const found = vendors.filter((v) => opts.mapHosts.has(v))
    probes.push({ url: p.url, vendors, found, recall: found.length / vendors.length })
  }
  const total = probes.reduce((n, p) => n + p.vendors.length, 0)
  const hit = probes.reduce((n, p) => n + p.found.length, 0)
  return { pooled: total ? hit / total : null, probes }
}
