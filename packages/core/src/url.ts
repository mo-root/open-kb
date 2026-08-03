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
