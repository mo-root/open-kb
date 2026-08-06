import { canonicalUrl } from "./url.js"
import type { FetchStatus } from "./sniff.js"

/**
 * How the bytes behind a citation were obtained.
 *
 * `page`, the run fetched that URL and read its content.
 * `snippet`, the run ran a search and the engine returned this title and description for that
 *   URL. Weaker: it is somebody else's summary, and the page itself was never opened. But it is
 *   a real retrieval this run performed, and refusing to record it was measured throwing away
 *   85% of what a run found, 91 domains seen, 14 recorded, because only fetched pages were
 *   citable and the fetch budget was 13 pages.
 *
 * The tier travels with the evidence so a reader, and the confidence calculation, can tell a
 * claim backed by a page apart from one backed by a search result. It is never used to reject.
 */
export type EvidenceTier = "page" | "snippet"

export interface Evidence {
  url: string
  quote: string
  fetchedAt: string
  status: FetchStatus
  tier: EvidenceTier
}

export interface FetchRecord {
  handle: string
  url: string
  canonical: string
  text: string
  fetchedAt: string
  status: FetchStatus
  tier: EvidenceTier
  reason?: string
}

export class CitationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CitationError"
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * Below this, a "quote" proves nothing, it matches too much of the page to mean anything.
 * Matches the `quote: z.string().min(8)` the `remember` tool schema enforces one layer up,
 * so the two checks agree instead of drifting.
 */
const MIN_QUOTE_LENGTH = 8

export type QuoteCheck = "ok" | "too-short" | "absent"

/**
 * The mint's containment check on its own: is this quote long enough to prove
 * anything, and is it literally in the text, whitespace squashed and case
 * folded? Exported because the sweep's span verification asks the exact same
 * question of the page a classification was written from — one implementation,
 * so a span the kernel verifies is a quote the mint would also accept.
 * `cite` below stays the only way to turn a passing check into an Evidence.
 */
export function checkQuote(text: string, quote: string): QuoteCheck {
  const squashedQuote = squash(quote)
  if (squashedQuote.length < MIN_QUOTE_LENGTH) return "too-short"
  return squash(text).includes(squashedQuote) ? "ok" : "absent"
}

/**
 * Every byte the run fetched, and the only way to turn those bytes into a citation.
 *
 * `cite` is the single mint. It has no fallback branch on purpose: if a quote cannot be
 * proven against stored bytes, no Evidence exists. A previous generation of this system
 * synthesised the proving quote out of the value it was meant to prove, which made every
 * citation on screen meaningless.
 */
export class EvidenceStore {
  #records = new Map<string, FetchRecord>()
  #byUrl = new Map<string, string>()
  #n = 0
  #now: () => string

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now
  }

  record(input: {
    url: string
    text: string
    status: FetchStatus
    reason?: string
    /** Defaults to `page`: a record with no stated tier came from opening the URL. */
    tier?: EvidenceTier
  }): FetchRecord {
    const handle = `ev${++this.#n}`
    const canonical = canonicalUrl(input.url)
    const rec: FetchRecord = {
      handle,
      url: input.url,
      canonical,
      text: input.text,
      fetchedAt: this.#now(),
      status: input.status,
      tier: input.tier ?? "page",
      reason: input.reason,
    }
    Object.freeze(rec)
    this.#records.set(handle, rec)
    if (input.status === "found") this.#byUrl.set(canonical, handle)
    return rec
  }

  get(handle: string): FetchRecord | undefined {
    return this.#records.get(handle)
  }

  hasFetched(url: string): boolean {
    return this.#byUrl.has(canonicalUrl(url))
  }

  size(): number {
    return this.#records.size
  }

  cite(handle: string, quote: string): Evidence {
    const rec = this.#records.get(handle)
    if (!rec) throw new CitationError(`no such handle: ${handle}`)
    if (rec.status !== "found") {
      throw new CitationError(`cannot cite ${handle}: page was ${rec.status}${rec.reason ? ` (${rec.reason})` : ""}`)
    }
    const check = checkQuote(rec.text, quote)
    if (check === "too-short") {
      throw new CitationError(`quote too short to prove anything (minimum ${MIN_QUOTE_LENGTH} characters)`)
    }
    if (check === "absent") {
      throw new CitationError(`quote not present in ${rec.url}`)
    }
    return { url: rec.url, quote, fetchedAt: rec.fetchedAt, status: rec.status, tier: rec.tier }
  }
}
