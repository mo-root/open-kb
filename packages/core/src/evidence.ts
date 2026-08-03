import { canonicalUrl } from "./url.js"
import type { FetchStatus } from "./sniff.js"

export interface Evidence {
  url: string
  quote: string
  fetchedAt: string
  status: FetchStatus
}

export interface FetchRecord {
  handle: string
  url: string
  canonical: string
  text: string
  fetchedAt: string
  status: FetchStatus
  reason?: string
}

export class CitationError extends Error {}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * Every byte the run fetched, and the ONLY way to turn those bytes into a citation.
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

  record(input: { url: string; text: string; status: FetchStatus; reason?: string }): FetchRecord {
    const handle = `ev${++this.#n}`
    const canonical = canonicalUrl(input.url)
    const rec: FetchRecord = {
      handle,
      url: input.url,
      canonical,
      text: input.text,
      fetchedAt: this.#now(),
      status: input.status,
      reason: input.reason,
    }
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
    if (!squash(rec.text).includes(squash(quote))) {
      throw new CitationError(`quote not present in ${rec.url}`)
    }
    return { url: rec.url, quote, fetchedAt: rec.fetchedAt, status: rec.status }
  }
}
