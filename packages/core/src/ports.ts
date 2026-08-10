import type { RawResponse } from "./sniff.js"

export interface SearchHit {
  url: string
  title: string
  description: string
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  ok: boolean
  error?: string
  usd: number
  ms: number
}

/**
 * Search is batched: one call carries many queries, so one model turn can buy a whole
 * wave of searches. A per-query failure is reported inside that query's SearchResult
 * (ok: false, error set), it must never reject the batch.
 *
 * Results are keyed by `query`, never by position. An implementation returns ONE row per
 * DISTINCT query, in the order each was first asked, so a batch carrying the same query
 * twice comes back one row shorter than it went in. Read the results with
 * `for (const r of results)` and label each by `r.query`; never pair `results[i]` with
 * `queries[i]`.
 *
 * That is a billing rule before it is a shape. A model told to produce twelve queries
 * repeats itself, and a duplicate that reaches the wire is a duplicate that is paid for —
 * so the port dedupes, because it is the only layer that knows one query becomes several
 * billable requests. Two queries are the same query only when they are the same string:
 * an implementation must not case-fold or trim, because merging on a guess about the
 * engine's semantics silently drops a query the caller wanted.
 *
 * `usd` summed across the returned rows is what the batch actually cost. No row may carry
 * another row's spend — callers meter per row and add the rows up.
 */
export interface SearchPort {
  search(queries: string[]): Promise<SearchResult[]>
}

/** A direct fetch is free and fast; an unlocked fetch costs money and takes 13-16s. */
export type FetchMode = "direct" | "unlocked"

export interface FetchResponse extends RawResponse {
  ms: number
  usd: number
}

/**
 * `opts.signal` lets the caller cancel a fetch already in flight — a pool that
 * aborts between hosts still holds a socket open for minutes without it. The
 * shipped port answers an abort the way it answers any failure, with an
 * unreadable response; nothing here promises never-throw, so a caller must
 * still contain a port that throws instead.
 */
export interface FetchPort {
  get(url: string, mode: FetchMode, opts?: { signal?: AbortSignal }): Promise<FetchResponse>
}
