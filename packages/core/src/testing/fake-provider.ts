import type { SearchHit, SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "../ports.js"

/**
 * Deterministic, network-free stand-in for a real search provider. Results are looked
 * up from a table keyed by exact query string; an unlisted query is a successful search
 * that simply found nothing (ok: true, hits: []), not a failure. A configured `failing`
 * query reports its failure inside that query's own SearchResult so a single bad query
 * never rejects the whole batch.
 */
export class FakeSearch implements SearchPort {
  constructor(
    private table: Record<string, SearchHit[]>,
    private opts: { failing?: string[] } = {},
  ) {}

  async search(queries: string[]): Promise<SearchResult[]> {
    return queries.map((query) => {
      if (this.opts.failing?.includes(query)) {
        return { query, hits: [], ok: false, error: "search provider refused this query", usd: 0, ms: 1 }
      }
      return { query, hits: this.table[query] ?? [], ok: true, usd: 0.001, ms: 5 }
    })
  }
}

/**
 * Deterministic, network-free stand-in for a real fetch provider. Results are looked up
 * from a table keyed by exact URL; an unlisted URL reports a 404 with an empty body, which
 * also lets tests exercise the measured "200 with a zero-byte body" hostile-site behaviour
 * by configuring that row explicitly. Cost and latency differ by mode: direct is free and
 * fast, unlocked costs money and is slow, mirroring the real providers Task 8 will write.
 */
export class FakeFetch implements FetchPort {
  constructor(private table: Record<string, { httpStatus: number; body: string; contentType?: string }>) {}

  async get(url: string, mode: FetchMode): Promise<FetchResponse> {
    const row = this.table[url] ?? { httpStatus: 404, body: "" }
    return {
      url,
      httpStatus: row.httpStatus,
      body: row.body,
      contentType: row.contentType,
      ms: mode === "unlocked" ? 14_000 : 300,
      usd: mode === "unlocked" ? 0.008 : 0,
    }
  }
}
