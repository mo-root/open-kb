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
