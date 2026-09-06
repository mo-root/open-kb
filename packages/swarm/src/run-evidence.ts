import { createHash } from "node:crypto"
import {
  EvidenceStore,
  anchorAliasSet,
  canonicalUrl,
  registrableHost,
  type Evidence,
  type EvidenceTier,
  type FetchRecord,
  type FetchStatus,
} from "@open-kb/core"

/**
 * The swarm's view of the evidence store: the kernel's mint, plus the four
 * things the tools need that the store deliberately does not do.
 *
 *   - cite by URL. The store's mint takes a handle; the swarm's `remember`
 *     takes `{url, quote}` because that is how a model writes a claim. One URL
 *     can have several records behind it (a snippet from search, then the page
 *     itself), so citing tries the strongest record first and the sentence
 *     that comes back on failure is the mint's own, verbatim.
 *   - raw bodies. The store's `text` is what quotes are proven against — the
 *     extracted text the model actually read. The raw body is kept beside it
 *     (capped) so `read` can project headings, links, or the raw markup from
 *     bytes the extractor would have flattened.
 *   - enumeration. `unread` and the admit() gate need to ask "what did this
 *     run fetch from this host" — questions the store answers for no one.
 *   - identity by BYTES, not by spelling (`hasText`). Everything else in this
 *     file keys on `canonicalUrl`, which is a string rule and therefore a rule
 *     an alias walks around; the digest set is the one question that cannot be
 *     re-spelled.
 *   - identity by ADDRESS rather than by URL string (`hasAddress`), so that
 *     "the run already read this page" survives the query string a caller
 *     hangs off it.
 */

/** Full body kept per page. Pages run to 900KB; 4MB is the ceiling on hostile ones. */
export const MAX_STORED_BYTES = 4 * 1024 * 1024

/**
 * The identity of a page's CONTENT, for "has this run already read these
 * bytes?". Whitespace is collapsed first — a re-render that differs only in
 * indentation is the same page — and nothing else is touched: normalising
 * further would start guessing which differences are meaningful, and this
 * function's whole value is that it guesses nothing.
 *
 * sha1 over the extracted text, not the raw body: the extracted text is what
 * the model actually reads, so two URLs that hand the run the same reading are
 * the same page whatever their markup, their scheme, or their query string.
 */
export function textDigest(text: string): string {
  return createHash("sha1").update(text.trim().replace(/\s+/g, " ")).digest("hex")
}

/**
 * The ADDRESS a page was read at: registrable host plus decoded path, with the
 * query dropped, duplicate and trailing slashes folded, lowercased.
 *
 * The URL string is not an address. `canonicalUrl` keeps the scheme, keeps a
 * doubled slash, keeps every query key its tracking list does not name and
 * keeps subdomains, so `https://a.com/x`, `http://a.com/x`, `https://a.com//x`
 * and `https://a.com/x?q=1` are four store keys for one place. This folds them
 * to one, which is what "have I been here before?" has to mean.
 *
 * THE QUERY IS DROPPED DELIBERATELY, and it costs something. A site that
 * addresses distinct pages by query alone (`/item?id=1`, `/item?id=2`) reads
 * as one address here, so a run that reads both is credited with one. That is
 * accepted: the alternative leaves `?q=1`, `?q=2`, `?q=3` — the round-2 bypass,
 * measured — as an unbounded supply of fresh addresses on ANY host, and the
 * cost is bounded on the other side, since a path the run has not read yet is
 * always a new address and the gate never asks for more than one unit of work
 * per refusal. Subdomains fold for the same reason and at the same kind of
 * cost (`docs.a.com/api` and `a.com/api` are one address).
 *
 * Because it is a cost and not an accident, THE LEAD IS TOLD. Driven: the seed
 * reads `/item?id=7`, the lead answers its refusal with `/item?id=42` —
 * genuinely different bytes, both stored, both readable — and it does not pay.
 * That honest answer is refused knowingly, so the skill's finish paragraph
 * carries "one path is one page whatever its query" beside the rest of what
 * gains nothing, and the README states the trade in full. Neither the gate nor
 * the fetch tool can say it at the moment it bites: the fetch succeeded, and
 * the gate's sentences are about the MAP, not about this rule.
 */
export function addressKey(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url.trim().toLowerCase()
  }
  let path = u.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    /* a lone % is not an escape; the raw spelling is the honest key */
  }
  path = path.replace(/\/+/g, "/").replace(/\/+$/, "")
  return `${registrableHost(u.hostname)}${path.toLowerCase()}`
}

/** Escapes for a literal inside a RegExp alternation. */
const RE_META = /[.*+?^${}()|[\]\\]/g

/**
 * The words a HOST can print back at a run that asked for them: the decoded
 * path and query segments of the requested URL, longest first.
 *
 * Never the hostname. A page that names its own site is just a page; a page
 * that names the PATH IT WAS HANDED is the run reading its own request back,
 * and that is what makes `https://anchor.com/<anything>` a fresh digest.
 *
 * Two characters is the floor. Below it a token is one character, and masking
 * one character out of every page would fold pages with nothing in common.
 */
function echoWords(url: string): string[] {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return []
  }
  const out = new Set<string>()
  const add = (s: string) => {
    const t = s.trim()
    if (t.length >= 2) out.add(t)
  }
  const decoded = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  // The whole address, the path, and each of the path's segments: a template
  // prints any of the three, and the longest-first sort makes the widest one
  // that matches win.
  for (const raw of [u.pathname + u.search, u.pathname, ...u.pathname.split("/")]) {
    add(raw)
    add(decoded(raw))
    add(raw.replace(/^\//, ""))
    add(decoded(raw).replace(/^\//, ""))
  }
  // Both spellings of the query: `searchParams` decodes (`a+b` -> `a b`) and
  // a page that echoes the raw query string prints what was on the wire.
  for (const [k, v] of u.searchParams) {
    add(k)
    add(v)
  }
  for (const raw of u.search.replace(/^\?/, "").split(/[&=]/)) {
    add(raw)
    add(decoded(raw))
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
}

/**
 * The identity of a page's content with the address it was fetched at masked
 * out of it — the digest a SOFT 404, a site-search page or a "did you mean"
 * template cannot escape, because the only thing distinguishing one of those
 * from the next is the path it was handed.
 *
 * Longest token first, so the whole path masks before its segments do and the
 * alternation's leftmost-match rule cannot leave a fragment behind. Case
 * insensitive: a template that title-cases the missing path is the same
 * template.
 */
export function echoFoldedDigest(text: string, url: string): string {
  const words = echoWords(url)
  if (words.length === 0) return textDigest(text)
  const re = new RegExp(words.map((w) => w.replace(RE_META, "\\$&")).join("|"), "gi")
  return textDigest(text.replace(re, " "))
}

export interface RecordInput {
  url: string
  /** What quotes are proven against: extracted text for a page, title+snippet for a search hit. */
  text: string
  /** The raw body as the wire delivered it, for raw/headings/links projections. */
  raw?: string
  status: FetchStatus
  reason?: string
  tier?: EvidenceTier
}

export type CiteOutcome = { ok: true; evidence: Evidence } | { ok: false; reason: string }

/** How firmly a claim is grounded, computed — never asserted by a model. */
export type ProvenanceTier = "own-page" | "page" | "snippet"

const TIER_RANK: Record<ProvenanceTier, number> = { "own-page": 3, page: 2, snippet: 1 }

export function strongerTier(a: ProvenanceTier, b: ProvenanceTier): ProvenanceTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b
}

/** The registrable host a URL's bytes came from; "" when the URL does not parse. */
export function originKey(url: string): string {
  try {
    return registrableHost(new URL(url).hostname)
  } catch {
    return ""
  }
}

export class RunEvidence {
  #store: EvidenceStore
  #all: FetchRecord[] = []
  #raw = new Map<string, string>()
  #byUrl = new Map<string, string[]>()
  /** Handles promised before their bytes arrived: `p3` -> the store handle it
   *  became, or the URL still in flight. A fetch past its deadline answers
   *  `{status:"pending", handle}` so the caller is never stuck; the promise
   *  keeps filling the store, and the handle starts answering when it lands. */
  #pending = new Map<string, { url: string; landed?: string }>()
  #pn = 0
  /** Content digests of every readable page this run holds, whatever URL each
   *  arrived under. Run-wide, like the store itself: a page an investigator
   *  read is a page the run holds. */
  #texts = new Set<string>()
  /** The same pages digested again with the address each was ASKED for masked
   *  out of the reading. A separate set, never a replacement: `#texts` is what
   *  makes an alias and a redirect fold, and that property is address-blind by
   *  construction — a masked digest is computed against ONE url, so asking the
   *  masked question alone would un-fold the redirect case the moment the two
   *  spellings shared a word with the body. Both sets are asked; a hit in
   *  either is a reading the run already holds. */
  #echoFolded = new Set<string>()
  /** Every ADDRESS (see `addressKey`) this run holds a readable page for. */
  #addresses = new Set<string>()

  constructor(store: EvidenceStore = new EvidenceStore()) {
    this.#store = store
  }

  /** Mint a handle for a fetch still in flight. */
  pending(url: string): string {
    const handle = `p${++this.#pn}`
    this.#pending.set(handle, { url })
    return handle
  }

  /** The in-flight fetch behind a pending handle finished; its bytes land now
   *  and the pending handle starts answering as the record it became. */
  land(pendingHandle: string, input: RecordInput): FetchRecord {
    const rec = this.record(input)
    const slot = this.#pending.get(pendingHandle)
    if (slot) slot.landed = rec.handle
    return rec
  }

  /** True while a pending handle's bytes have not arrived yet. */
  isPending(handle: string): boolean {
    const slot = this.#pending.get(handle)
    return !!slot && slot.landed === undefined
  }

  /** A pending handle resolves to the store handle it became, once landed. */
  #resolve(handle: string): string {
    return this.#pending.get(handle)?.landed ?? handle
  }

  record(input: RecordInput): FetchRecord {
    const rec = this.#store.record({
      url: input.url,
      text: input.text.slice(0, MAX_STORED_BYTES),
      status: input.status,
      reason: input.reason,
      tier: input.tier,
    })
    this.#all.push(rec)
    // The bytes join the run's content memory here, at the one place every
    // page enters the store — the lead's fetch, an investigator's fetch and
    // harvest's recording port all land on this line. `rec.text` is already
    // the MAX_STORED_BYTES slice, and `hasText` asks about the same slice: a
    // capped page must not digest one way going in and another coming out.
    if (rec.status === "found" && rec.tier === "page") {
      this.#texts.add(textDigest(rec.text))
      this.#echoFolded.add(echoFoldedDigest(rec.text, input.url))
      this.#addresses.add(addressKey(input.url))
    }
    if (input.raw !== undefined) this.#raw.set(rec.handle, input.raw.slice(0, MAX_STORED_BYTES))
    const list = this.#byUrl.get(rec.canonical) ?? []
    list.push(rec.handle)
    this.#byUrl.set(rec.canonical, list)
    return rec
  }

  get(handle: string): FetchRecord | undefined {
    return this.#store.get(this.#resolve(handle))
  }

  rawOf(handle: string): string | undefined {
    return this.#raw.get(this.#resolve(handle))
  }

  /** Every handle recorded for this URL, in arrival order. */
  handlesFor(url: string): string[] {
    return this.#byUrl.get(canonicalUrl(url)) ?? []
  }

  size(): number {
    return this.#all.length
  }

  /**
   * Prove a quote against what this run fetched from a URL. Strongest record
   * first — the page itself over the snippet that pointed at it — and the
   * failure sentence is the mint's own for the strongest record, verbatim,
   * because that sentence is written to the model and re-wording it here
   * would break the feedback loop the skill teaches.
   */
  cite(url: string, quote: string): CiteOutcome {
    const handles = this.handlesFor(url)
    if (handles.length === 0) {
      return {
        ok: false,
        reason: `nothing was fetched from ${url} this run; fetch it (or cite the search hit's own url) before quoting it`,
      }
    }
    const ranked = [...handles].sort((a, b) => this.#strength(b) - this.#strength(a))
    let firstFailure: string | null = null
    for (const h of ranked) {
      try {
        return { ok: true, evidence: this.#store.cite(h, quote) }
      } catch (e) {
        if (firstFailure === null) firstFailure = (e as Error).message
      }
    }
    // `firstFailure ?? ...`: dead by construction, not an untested branch. This line is
    // reached only by exhausting `ranked` without a single iteration returning — and
    // `handles.length === 0` already returned above, so `ranked` holds at least one entry.
    // Its first iteration's catch always fires (`#store.cite` never throws anything but
    // `CitationError`, which is a real `Error` and so always has a `.message` string), and
    // that catch sets `firstFailure` on its first run since it starts `null`. So by the time
    // the loop falls through, `firstFailure` is already a string — there is no public path
    // that reaches this line with it still `null`.
    return { ok: false, reason: firstFailure ?? `quote not present in ${url}` }
  }

  /** found page > found snippet > anything else; newer beats older within a rank. */
  #strength(handle: string): number {
    const rec = this.#store.get(handle)
    // `!rec`: dead by construction. The only handles `#strength` is ever called with come
    // from `handlesFor()` (`#byUrl`), and `record()` is `#byUrl`'s only writer — it pushes
    // `rec.handle` to `#byUrl` in the same call that hands that identical `rec` to `#store`.
    // `EvidenceStore` has no delete, so a handle drawn from `#byUrl` is always still there.
    if (!rec) return 0
    const idx = this.#all.indexOf(rec)
    const base = rec.status !== "found" ? 0 : rec.tier === "page" ? 2_000_000 : 1_000_000
    return base + idx
  }

  /**
   * A readable page fetched from the host's own site, for the admit() gate:
   * a commercial stance needs the host's own page behind it. Any found page
   * on the registrable host qualifies, not only the front page — a run that
   * read /pricing has read the company in its own words.
   */
  ownPage(key: string): { url: string; text: string; raw?: string } | null {
    for (const rec of this.#all) {
      if (rec.status !== "found" || rec.tier !== "page") continue
      if (originKey(rec.canonical) !== key) continue
      return { url: rec.url, text: rec.text, raw: this.#raw.get(rec.handle) }
    }
    return null
  }

  /**
   * Has this run already read a page AT THIS ADDRESS?
   *
   * The old question was `hasPage`, keyed on `canonicalUrl`, and it was a
   * question about a STRING: every spelling the tracking-key list does not
   * name is a fresh key for a place the run has already been. `addressKey`
   * folds the scheme, the doubled slash, the subdomain and the whole query, so
   * the answer is about the place. It subsumes the old question — same
   * canonical means same address — and closes the one thing the byte digest
   * cannot: a page whose bytes change on every read (a nonce, a build hash, a
   * rendered timestamp) served from an address the run has already paid for.
   */
  hasAddress(url: string): boolean {
    return this.#addresses.has(addressKey(url))
  }

  /**
   * Has this run already read this READING — these bytes under any url, or
   * these bytes once the address they were asked for is masked out of them?
   *
   * `hasAddress` is a question about a place. This is the question about the
   * content, and it is the one an alias cannot dodge: a URL is a spelling, and
   * `canonicalUrl` only folds the spellings its tracking list names, so `?q=1`,
   * `http://` for `https://` and a doubled slash all address one page under
   * three keys. The run does not even need anyone to try: the direct branch of
   * providers/src/brightdata.ts follows redirects and returns the REQUESTED
   * url (`res.url` is discarded), so an honest fetch of /pricing that lands on
   * a /plans page the run already read arrives under a url the store has never
   * seen. The digest is computed from the bytes, so all of that folds.
   *
   * The masked half closes the case where the HOST supplies the difference. A
   * soft 404, a site-search result, a "did you mean" page or any error template
   * that prints the address it was handed turns `https://host/<anything>` into
   * fresh bytes — and `sniff` calls a 200 with more than THIN_TEXT extracted
   * characters `found`, so those are page-tier. Masking the requested path and
   * query out of the reading before hashing folds ten spellings of one template
   * into one reading. It is asked BESIDE the raw digest, never instead of it:
   * the raw set is what makes an alias and a redirect fold, and it can do that
   * only because it is address-blind.
   *
   * WHAT IT STILL DOES NOT CATCH, stated so nobody has to discover it: a page
   * whose bytes change for a reason the address does not explain — a nonce, a
   * CSRF token, a build hash, a rendered timestamp, a rotating testimonial, a
   * visitor counter. Each read digests differently and each reads as new. The
   * whitespace collapse stops there deliberately: a normaliser aggressive
   * enough to fold a timestamp is one that folds two genuinely different
   * pricing pages. `hasAddress` is what bounds it — the same address cannot be
   * re-read for a second gain — so what survives is one such page per address,
   * which is the residue the finish gate's own docs record.
   */
  hasText(text: string, url: string): boolean {
    // The same slice `record` stores, or a page past the cap would digest one
    // way going in and another way being asked about, and every alias of a
    // 4MB page would read as new.
    const capped = text.slice(0, MAX_STORED_BYTES)
    return this.#texts.has(textDigest(capped)) || this.#echoFolded.has(echoFoldedDigest(capped, url))
  }

  /**
   * The newest found snippet-tier record from a registrable host, for the
   * harvest path's one hard case: an unreadable host still lands on the map
   * (downgraded, wearing its reason code), and the only citable bytes the run
   * holds for it are the search snippet that surfaced it. Newest first — the
   * engine's latest words about the host. Null when the run never saw the
   * host in a search, in which case the host cannot land at all: that is the
   * mint's rule working, not a gap.
   */
  snippetFor(hostKey: string): { url: string; text: string } | null {
    for (let i = this.#all.length - 1; i >= 0; i--) {
      const rec = this.#all[i]!
      if (rec.status !== "found" || rec.tier !== "snippet") continue
      if (originKey(rec.canonical) !== hostKey) continue
      return { url: rec.url, text: rec.text }
    }
    return null
  }

  /**
   * Every readable page this run bought, one row per URL, rawest bytes held —
   * the probe pool for answerKeyRecall, which applies its own namesHost and
   * min-vendors gates. Nothing extra is ever fetched to grade a map.
   */
  pages(): Array<{ url: string; html: string }> {
    const out: Array<{ url: string; html: string }> = []
    const taken = new Set<string>()
    for (const rec of this.#all) {
      if (rec.status !== "found" || rec.tier !== "page") continue
      if (taken.has(rec.canonical)) continue
      taken.add(rec.canonical)
      out.push({ url: rec.url, html: this.#raw.get(rec.handle) ?? rec.text })
    }
    return out
  }

  /**
   * Harvestable pages nobody has opened: URLs this run has only ever seen as
   * search snippets, with the snippet handle so the caller can still cite it.
   */
  unread(): Array<{ url: string; handle: string }> {
    const pageUrls = new Set<string>()
    for (const rec of this.#all) {
      if (rec.status === "found" && rec.tier === "page") pageUrls.add(rec.canonical)
    }
    const out: Array<{ url: string; handle: string }> = []
    const seen = new Set<string>()
    for (const rec of this.#all) {
      if (rec.tier !== "snippet" || rec.status !== "found") continue
      if (pageUrls.has(rec.canonical) || seen.has(rec.canonical)) continue
      seen.add(rec.canonical)
      out.push({ url: rec.url, handle: rec.handle })
    }
    return out
  }
}

/**
 * The recall probe pool: every readable page this run bought, minus the
 * anchor's own AND its structural aliases — they name the anchor by
 * definition and would let the map grade itself against the anchor's
 * marketing, in translation included. The alias set is computed from the
 * pages already in the store (the anchor's own pages are there — hreflang
 * out of them; a reciprocating alias page was stored when some mission
 * opened it), never fetched for: nothing extra is ever bought to grade a
 * map. Same rung-0 rule as the sweep's probe gate (rank.ts); registrable
 * host, not hostname, so www. and subdomains fold in. ONE function shared
 * by serialize.ts and the orchestrator's in-run scorecard, so the report's
 * recall and the number the lead saw mid-run cannot drift apart — and the
 * alias set rides out beside the pool so answerKeyRecall subtracts the SAME
 * hosts from every probe's vendor list. The recall rise the exclusion causes
 * is a bug fix in the instrument, not a coverage improvement; the recall
 * report says so itself (RecallReport.aliasExclusion).
 */
export function recallProbePool(
  evidence: RunEvidence,
  anchor: string,
): { pages: Array<{ url: string; html: string }>; anchorAliases: ReadonlySet<string> } {
  const all = evidence.pages()
  // Always contains the anchor's registrable key, so one set is both the old
  // anchor exclusion and the alias exclusion.
  const anchorAliases = anchorAliasSet(all, anchor)
  const pages = all.filter((p) => {
    try {
      return !anchorAliases.has(registrableHost(new URL(p.url).hostname))
    } catch {
      return false
    }
  })
  return { pages, anchorAliases }
}
