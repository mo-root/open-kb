const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i

/**
 * Reduce a URL to a stable identity so "did we fetch this?" survives spelling.
 * Never throws: an unparseable string is its own canonical form.
 */
export function canonicalUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  u.hash = ""
  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "")
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key)) u.searchParams.delete(key)
  }
  u.searchParams.sort()
  let path = u.pathname
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  u.pathname = path
  const qs = u.searchParams.toString()
  return `${u.protocol}//${u.host}${u.pathname}${qs ? "?" + qs : ""}`
}

/**
 * Two-label public suffixes common enough to matter for market maps. Not the
 * PSL: a wrong fold here merges two companies, and every entry is a suffix
 * under which real, distinct registrations exist. Extend when a run shows a
 * miss; do not import a 15k-line list for a keying heuristic.
 */
const TWO_PART_TLD = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.jp", "co.nz", "co.in", "com.br", "com.mx", "co.za", "com.sg",
  "com.hk", "com.tw", "co.kr", "com.cn",
])

/** The domain a company actually registered: `docs.apify.com` -> `apify.com`.
 *  Identity for company/product nodes keys on this, never on the display name. */
export function registrableHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^www\./, "")
  const parts = h.split(".")
  if (parts.length <= 2) return h
  const lastTwo = parts.slice(-2).join(".")
  const keep = TWO_PART_TLD.has(lastTwo) ? 3 : 2
  return parts.slice(-keep).join(".")
}
