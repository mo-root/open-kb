import { registrableHost } from "./url.js"

/**
 * Alias identity from structural web signals — the cheap, high-precision half.
 *
 * Identity everywhere in this codebase is `registrableHost`, which makes an
 * anchor's ccTLD property a separate company — and, worse, a VENDOR in the
 * recall probe pool, so the instrument counts the anchor's own foreign
 * front page as a company the map missed. The fix is not string similarity
 * (that instrument exists to over-merge: a wrong merge destroys two
 * companies, a wrong split costs one row). It is the same-publisher
 * assertions already sitting in HTML the run paid for:
 *
 *   - `<link rel="alternate" hreflang>` across registrable hosts. Strong only
 *     when RECIPROCAL: anyone can claim to be anyone's alternate, which is
 *     why search engines ignore non-reciprocal hreflang. A mutual declaration
 *     is a same-publisher assertion by both parties.
 *   - cross-registrable-host `rel=canonical`, accepted only on MUTUAL
 *     agreement — each host naming the other. One-sided canonical against a
 *     self-canonicalizing target is the forgeable shape: anyone can point
 *     canonical at a company they are not.
 *
 * A one-sided assertion is NEVER accepted, and the two instruments do not
 * mix (one-sided hreflang plus one-sided canonical is reciprocity in
 * neither). Precision over recall, deliberately: this module's output is
 * subtracted from a measurement, and a false alias would subtract a real
 * competitor from the map's grade.
 *
 * The third structural signal — the redirect chain's terminal host — is a
 * PORT concern and is deliberately absent: `FetchResponse.url` is the
 * requested URL, not the final one (the shipped provider follows redirects
 * and returns the input `url`, discarding `res.url`; the old ledger records
 * this as "url is the requested not final URL"). Until the port carries the
 * terminal URL, no pure function downstream can see it.
 *
 * Scope, stated once: this feeds the RECALL INSTRUMENT only. Map identity
 * keying and drift both key on `registrableHost` and are untouched — folding
 * identities there changes drift readings between runs, which is an
 * owner-visible decision, not a bug fix. And the recall rise this module
 * causes IS mechanical: the pool stops counting the anchor's own properties
 * as missed vendors. That is a bug fix in the instrument, not a coverage
 * improvement, and the report language carries that sentence wherever the
 * exclusion fires (see `coverage.ts`'s `aliasExclusion`). The hard half —
 * brand aliases with no structural relationship between the pages — has no
 * signal here and stays an owner judgement.
 */

/** The structural same-publisher assertions one stored page makes. */
export interface AliasSignals {
  /** Registrable hosts named as hreflang alternates, cross-host only, sorted.
   *  Candidates for reciprocity — never aliases on their own. */
  hreflang: string[]
  /** The registrable host this page canonicalizes to, when it differs from
   *  the page's own; null otherwise. First canonical wins, as browsers do. */
  canonical: string | null
}

const LINK_TAG = /<link\b[^>]*>/gi

/** One attribute's value out of a tag, any order, any quoting, any case. */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`[\\s"']${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null
}

/** The registrable host an href points at, resolved against the page; "" when
 *  it does not resolve to an http(s) URL. */
function targetHost(href: string, pageUrl: string): string {
  try {
    const u = new URL(href, pageUrl)
    if (u.protocol !== "http:" && u.protocol !== "https:") return ""
    return registrableHost(u.hostname)
  } catch {
    return ""
  }
}

/**
 * Extract the structural same-publisher assertions from a stored page.
 * Pure text over bytes the run already fetched — no DOM, no HTTP, $0.
 */
export function aliasSignals(html: string, pageUrl: string): AliasSignals {
  let self = ""
  try {
    self = registrableHost(new URL(pageUrl).hostname)
  } catch {
    // An unparseable page URL has no "own host" to compare against; nothing
    // it asserts can be called cross-host, so it asserts nothing.
    return { hreflang: [], canonical: null }
  }
  const hreflang = new Set<string>()
  // The FIRST canonical tag decides, as browsers do — a page that
  // self-canonicalizes and then carries a stray cross-host canonical has
  // asserted itself, and the stray must not count as a publisher claim.
  let canonical: string | null = null
  let canonicalSeen = false
  for (const m of html.matchAll(LINK_TAG)) {
    const tag = m[0]
    const rel = (attrOf(tag, "rel") ?? "").toLowerCase().split(/\s+/)
    const href = attrOf(tag, "href")
    if (!href) continue
    if (rel.includes("alternate") && attrOf(tag, "hreflang")) {
      const h = targetHost(href, pageUrl)
      if (h && h !== self) hreflang.add(h)
    }
    if (rel.includes("canonical") && !canonicalSeen) {
      canonicalSeen = true
      const h = targetHost(href, pageUrl)
      if (h && h !== self) canonical = h
    }
  }
  return { hreflang: [...hreflang].sort(), canonical }
}

/** Union-find over registrable hosts: path-compressed find, size-aware union.
 *  Written here rather than imported — twenty lines is cheaper than a
 *  dependency, and the tests own its behavior. */
class UF {
  #parent = new Map<string, string>()
  find(x: string): string {
    let root = this.#parent.get(x) ?? x
    while (root !== (this.#parent.get(root) ?? root)) root = this.#parent.get(root)!
    // Path compression: point everything on the walk straight at the root.
    let cur = x
    while (cur !== root) {
      const next = this.#parent.get(cur)!
      this.#parent.set(cur, root)
      cur = next
    }
    return root
  }
  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    // Deterministic root choice — lexicographic, not insertion order — so the
    // sets come out identical whatever order the pages arrived in.
    if (ra < rb) this.#parent.set(rb, ra)
    else this.#parent.set(ra, rb)
  }
}

/**
 * Pairwise alias acceptance over stored pages, then transitive closure.
 *
 * A pair of registrable hosts is accepted ONLY on:
 *   - hreflang reciprocity: A's pages name B as an alternate AND B's pages
 *     name A; or
 *   - mutual canonical agreement: A canonicalizes to B AND B canonicalizes
 *     to A.
 *
 * Both require the run to have READ both sides — an assertion whose target
 * page is not in `pages` is unprovable and refused. Returns the disjoint
 * sets of size two or more, members sorted, sets ordered by first member.
 */
export function aliasSets(pages: ReadonlyArray<{ url: string; html: string }>): Array<ReadonlySet<string>> {
  // Union each host's assertions across its pages: a site declares hreflang
  // sitewide, and which of its stored pages carried the tag is incidental.
  const hreflangOut = new Map<string, Set<string>>()
  const canonicalOut = new Map<string, Set<string>>()
  for (const p of pages) {
    let host = ""
    try {
      host = registrableHost(new URL(p.url).hostname)
    } catch {
      continue
    }
    if (!host) continue
    const s = aliasSignals(p.html, p.url)
    if (!hreflangOut.has(host)) hreflangOut.set(host, new Set())
    if (!canonicalOut.has(host)) canonicalOut.set(host, new Set())
    for (const t of s.hreflang) hreflangOut.get(host)!.add(t)
    if (s.canonical) canonicalOut.get(host)!.add(s.canonical)
  }

  const uf = new UF()
  const members = new Set<string>()
  const acceptIfMutual = (out: Map<string, Set<string>>) => {
    for (const [a, targets] of out) {
      for (const b of targets) {
        // Reciprocity needs B's own read pages asserting A back; a host the
        // run never read has an empty (absent) entry and can prove nothing.
        if (!out.get(b)?.has(a)) continue
        uf.union(a, b)
        members.add(a)
        members.add(b)
      }
    }
  }
  acceptIfMutual(hreflangOut)
  acceptIfMutual(canonicalOut)

  const byRoot = new Map<string, string[]>()
  for (const m of [...members].sort()) {
    const r = uf.find(m)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(m)
  }
  return [...byRoot.values()]
    .sort((x, y) => (x[0]! < y[0]! ? -1 : 1))
    .map((xs) => new Set(xs))
}

/**
 * The anchor's own alias set, anchor key always included — the shape the
 * recall instrument subtracts. An anchor with no reciprocated assertion gets
 * the singleton it always had; someone else's alias set is never handed over.
 */
export function anchorAliasSet(
  pages: ReadonlyArray<{ url: string; html: string }>,
  anchor: string,
): ReadonlySet<string> {
  const key = registrableHost(anchor)
  for (const set of aliasSets(pages)) {
    if (set.has(key)) return set
  }
  return new Set([key])
}
