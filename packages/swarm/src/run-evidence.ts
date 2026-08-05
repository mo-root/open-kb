import {
  EvidenceStore,
  canonicalUrl,
  registrableHost,
  type Evidence,
  type EvidenceTier,
  type FetchRecord,
  type FetchStatus,
} from "@open-kb/core"

/**
 * The swarm's view of the evidence store: the kernel's mint, plus the three
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
 */

/** Full body kept per page. Pages run to 900KB; 4MB is the ceiling on hostile ones. */
export const MAX_STORED_BYTES = 4 * 1024 * 1024

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
    return { ok: false, reason: firstFailure ?? `quote not present in ${url}` }
  }

  /** found page > found snippet > anything else; newer beats older within a rank. */
  #strength(handle: string): number {
    const rec = this.#store.get(handle)
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

  /** Does any found, page-tier record exist for this URL? */
  hasPage(url: string): boolean {
    return this.handlesFor(url).some((h) => {
      const rec = this.#store.get(h)
      return !!rec && rec.status === "found" && rec.tier === "page"
    })
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
