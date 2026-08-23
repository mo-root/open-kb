import type { RawResponse } from "./sniff.js"

export interface SearchHit {
  url: string
  title: string
  description: string
  /**
   * Where the engine ranked this row, 1-based and global across pages.
   *
   * The one signal of PROMINENCE a search result carries, and it was parsed
   * and dropped: a map built without it ranks a market's leader level with a
   * reseller nobody has heard of, because every other field says only what a
   * host IS. Optional — a port that cannot say leaves it unset and callers
   * fall back to how many queries surfaced the host. Ports construct it from
   * page offset + within-page position rather than trusting a provider field
   * that claims to be global — Bright Data's global_rank restarts every page.
   */
  rank?: number
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  ok: boolean
  error?: string
  usd: number
  ms: number
  /**
   * Billable requests this query actually cost, and how many of those were
   * retries of a refused one.
   *
   * A query is `pages` requests when nothing goes wrong, and a refusal bills
   * exactly like an answer — so a run whose pages are being throttled pays for
   * the throttling. MEASURED on one map: 192 queries at 5 pages should have
   * been 960 requests and were 1,230, a 28% retry overhead that appeared
   * nowhere except as a larger total. Optional so a port that cannot count
   * them stays a valid port; the sweep reports what it is given.
   */
  requests?: number
  retries?: number
  /** Refusals whose reason names a block or a throttle, as the provider
   *  worded it, so a run can say WHY it paid twice. */
  blocked?: string[]
  /**
   * Rows the engine paid for and cannot use: results whose link came back as
   * a relative redirect rather than a destination.
   *
   * The search engine sometimes answers with `/goto?url=CAES...` — an opaque
   * token, not an encoded url. It does not decode to anything: base64 of the
   * payload is protobuf with no url in it, readable only by the engine that
   * minted it. So these rows cannot be recovered, only counted — and counted
   * they must be, because every one was billed and then silently dropped much
   * later, where `new URL(...)` threw and the row vanished without a number
   * anywhere saying it had.
   *
   * THE RATE IS NOT STABLE, which is the reason to keep counting rather than
   * to assume a figure. Across the runs stored before this field existed it
   * was 990 of 67,375 hits, 1.5%; re-counted over the 32 runs on disk once
   * tonight's were added it is 999 of 82,978, 1.2%, and no single run has
   * gone past 9.3%. On the day
   * it was added the same measurement read 4.0% and 5.5% on two shopify.com
   * runs three hours apart, against 0.3-0.5% on runs from that morning, and a
   * direct probe of 236 live links came back 8%. A reader comparing this
   * comment to a fresh run should expect them to disagree.
   */
  redirects?: number
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
