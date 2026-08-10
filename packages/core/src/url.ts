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
  const h = host.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "")

  // IPv4 addresses should pass through unchanged
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return h
  }

  const parts = h.split(".")
  if (parts.length <= 2) return h
  const lastTwo = parts.slice(-2).join(".")
  const keep = TWO_PART_TLD.has(lastTwo) ? 3 : 2
  return parts.slice(-keep).join(".")
}

/**
 * Trim a host down to the thing a resolver would actually be handed.
 *
 * Four spellings of the same host reach this file and only one of them is the
 * plain one: `[::1]` arrives bracketed from `URL.hostname` when the host is
 * IPv6, `127.0.0.1.` arrives with the FQDN root dot that DNS accepts and
 * strips, `fe80::1%en0` arrives carrying a zone id that belongs to the socket
 * and not to the address, and any of them can arrive with capitals. Each of
 * those is a way to write a reserved host that a check on the raw string
 * misses.
 */
function bareHost(raw: string): string {
  let h = raw.trim().toLowerCase()
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1)
  const zone = h.indexOf("%")
  if (zone !== -1) h = h.slice(0, zone)
  return h.replace(/\.+$/, "")
}

/**
 * An IPv4 literal's 32-bit value, in every notation that resolves to one.
 *
 * This is inet_aton's grammar, which is also the WHATWG URL parser's, which is
 * what `fetch` will use — so anything this reads as an address is an address
 * `fetch` will connect to, and reading it any other way is the bug. Three parts
 * of that grammar are the ones people forget:
 *
 *   - a leading `0` means OCTAL, so `0177.0.0.1` is `127.0.0.1`. `parseInt(p,
 *     10)` reads it as 177 and calls it public.
 *   - `0x` means hex, so `0x7f.0.0.1` is loopback too.
 *   - there do not have to be four parts. The LAST part absorbs whatever is
 *     left, so `127.1` is `127.0.0.1` and the bare `2130706433` is as well.
 *     `new URL("https://127.1/")` reports its hostname as `127.0.0.1`; a check
 *     that only understands dotted quads sees a two-label name and waves it
 *     through.
 *
 * Returns null when the host is not an IPv4 literal at all, which is the normal
 * answer for a domain name.
 */
function ipv4Value(host: string): number | null {
  const parts = host.split(".")
  if (parts.length < 1 || parts.length > 4) return null

  const nums: number[] = []
  for (const p of parts) {
    if (!p) return null
    let n: number
    if (/^0x[0-9a-f]*$/.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16)
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8)
    else if (/^\d+$/.test(p)) n = parseInt(p, 10)
    else return null // a non-numeric label: this is a name, not an address
    if (!Number.isSafeInteger(n) || n < 0) return null
    nums.push(n)
  }

  const last = nums.pop()!
  if (nums.some((v) => v > 255)) return null
  if (last >= 256 ** (4 - nums.length)) return null
  let value = last
  for (let i = 0; i < nums.length; i++) value += nums[i]! * 256 ** (3 - i)
  return value
}

/** The eight 16-bit groups of an IPv6 literal, or null if it is not one. Handles
 *  `::` elision and the `::ffff:1.2.3.4` tail, whose dotted part is folded into
 *  the last two groups exactly as the address grammar says. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null

  let text = host
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    const v4 = ipv4Value(tail)
    if (v4 === null) return null
    const hi = (Math.floor(v4 / 0x10000) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0]!.split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1]!.split(":") : []
  if (halves.length === 1 && head.length !== 8) return null
  if (head.length + rest.length > 8) return null

  const groups: number[] = []
  for (const p of head) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null
    groups.push(parseInt(p, 16))
  }
  for (let i = groups.length; i < 8 - rest.length; i++) groups.push(0)
  for (const p of rest) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null
    groups.push(parseInt(p, 16))
  }
  return groups.length === 8 ? groups : null
}

/** Is this 32-bit IPv4 value one a server must not be steered onto? */
function reservedV4(value: number): boolean {
  const a = (value >>> 24) & 0xff
  const b = (value >>> 16) & 0xff
  const c = (value >>> 8) & 0xff
  return (
    a === 0 || // 0.0.0.0/8 "this network" — and 0.0.0.0 itself is every local interface
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 carrier-grade NAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local — the cloud metadata endpoint lives here
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay anycast
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  )
}

/** Is this IPv6 address reserved — including the four ways an IPv6 address can
 *  carry an IPv4 one inside it, each of which is a way to spell 127.0.0.1. */
function reservedV6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number]
  const embedded = (hi: number, lo: number) => reservedV4(hi * 0x10000 + lo)
  const topFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0

  if (topFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true // :: and ::1
  if (topFiveZero && g5 === 0xffff) return embedded(g6, g7) // ::ffff:a.b.c.d v4-mapped
  if (topFiveZero && g5 === 0) return embedded(g6, g7) // ::a.b.c.d v4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7) // 64:ff9b::/96 NAT64
  if (g0 === 0x2002) return embedded(g1, g2) // 2002::/16 6to4, v4 in the next 32 bits
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated, still routed by some stacks)
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * Suffixes that name a network rather than a place on the internet.
 *
 * `.internal` is the one that matters most — `metadata.google.internal` is the
 * GCP metadata endpoint by name — and `.corp`, `.lan`, `.intranet`,
 * `.localdomain` and `.home.arpa` are the rest of the set a corporate resolver
 * completes inward.
 *
 * `.test`, `.example`, `.invalid` and `.onion` are deliberately NOT here. They
 * are reserved, but reserved is not the question this predicate answers: none of
 * them resolves to anything on a normal host, so the resolving guard refuses
 * them anyway when it fails to get an address, and listing them here would only
 * turn "this domain does not exist" into a differently-worded refusal while
 * breaking every fixture in this repo that uses `.example` as a stand-in for a
 * public domain.
 */
const INTERNAL_SUFFIX = /\.(?:local|localhost|localdomain|internal|intranet|corp|lan|home|home\.arpa)$/

/**
 * Is this host something a server must never be told to fetch?
 *
 * The map takes a domain from whoever is holding the web app, and the server
 * then fetches that domain's own pages — `/llms.txt`, `docs.<host>/llms.txt`,
 * `/` — before any paid call happens. Measured on the shipped validator, which
 * required only "letters, dots, letters": every one of `127.0.0.1`, `10.0.0.5`,
 * `169.254.169.254`, `metadata.google.internal`, `internal-jenkins.corp` and
 * `0177.0.0.1` passed it. On AWS or GCP the third of those is the instance
 * metadata endpoint, and the body of what comes back is condensed, handed to
 * the model, and readable afterwards at `GET /api/kb`. Free to probe, too,
 * since all three fetches precede the first billed call.
 *
 * PURE, and it has to be: this lives in core, which may not resolve DNS or open
 * a socket. So it answers a narrower question than "is this address private" —
 * it answers "is this host WRITTEN as something reserved", for every notation
 * that resolves to one. Both other layers consult it, which is the reason it is
 * here rather than in either of them: the route needs it to refuse input and the
 * fetch seam needs it to judge a resolved address, and two copies of an address
 * table are two tables that drift.
 *
 * WHAT IT DOES NOT COVER, stated because a partial guard read as a total one is
 * worse than none: a PUBLIC name whose DNS answer is a private address —
 * `127.0.0.1.nip.io` is exactly that, and so is any domain an attacker owns and
 * points at `127.0.0.1` — passes here, and so does a public page that 302s onto
 * one. Nothing spelled can catch those; they need the resolved address at
 * connect time and a fresh check per redirect hop, which is `publicOnlyFetch`
 * in `@open-kb/providers`. This is the first of two layers and is not sufficient
 * on its own.
 */
export function isReservedHost(raw: string): boolean {
  const host = bareHost(raw)
  if (!host) return true

  const v6 = ipv6Groups(host)
  if (v6) return reservedV6(v6)

  const v4 = ipv4Value(host)
  if (v4 !== null) return reservedV4(v4)

  // A bare name with no dot never reaches the public DNS root: `localhost`, and
  // every single-label intranet name a resolver completes with a search domain.
  if (!host.includes(".")) return true

  return INTERNAL_SUFFIX.test(host)
}

/**
 * Is this host an IP address rather than a name?
 *
 * The resolving guard needs this to know whether there is anything to resolve:
 * a literal has already been judged in full by `isReservedHost`, and handing it
 * to a resolver would only get the same address back. Exported rather than
 * re-derived at the fetch seam so that "what counts as an address" is decided in
 * exactly one place — the notations are the whole subtlety, and a second opinion
 * about them is how `0177.0.0.1` gets treated as a name and then as an address
 * by two halves of the same check.
 */
export function isIpLiteral(raw: string): boolean {
  const host = bareHost(raw)
  return ipv6Groups(host) !== null || ipv4Value(host) !== null
}
