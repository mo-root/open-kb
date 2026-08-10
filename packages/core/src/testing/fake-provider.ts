import type { SearchHit, SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "../ports.js"

/**
 * THE DOUBLES ARE NOT IN THE BARREL, and the address they do have says what
 * they are.
 *
 * `@open-kb/core` exports `./src/index.ts` and this file is not in it, so a
 * production module that writes `from "@open-kb/core"` cannot land here however
 * hard it tries. It is reachable only as `@open-kb/core/testing`, a second
 * subpath added to the package's `exports` the day `sweep()` grew a port seam
 * and the sweep's tests needed these two rather than a fourth hand-rolled pair
 * (packages/swarm already carries two, both labelled "in the sweep tests'
 * idiom"). A relative path across packages is not the alternative it looks
 * like: every package's tsconfig.tests.json sets `rootDir` to its own
 * directory, so `../../core/src/testing/fake-provider.js` fails `pnpm check`
 * with TS6059 before it ever runs.
 *
 * The subpath is deliberately unmissable in a diff and in a grep, and
 * `tests/testing-doubles-stay-out-of-src.test.ts` fails if any first-party
 * `src/` ever imports it — reaching a fake from production code has to be a
 * decision someone typed, not somewhere they ended up.
 */

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

  /**
   * Every batch, exactly as it was handed over — duplicates kept, order kept,
   * before this fake applies the port's own dedupe.
   *
   * Recorded for the same reason `FakeFetch.calls` is: what a caller ASKED for
   * is not recoverable from what it got back. A query the engine was supposed
   * to drop before buying it — one naming the anchor, one already asked in an
   * earlier wave — is invisible in the results, because a dropped query and a
   * query that found nothing produce the same empty hits array. It is only
   * visible here. Pre-dedupe on purpose: the port merging a repeat is a
   * different fact from the caller never sending it twice, and the whole
   * billing rule in `SearchPort` turns on telling those apart.
   */
  readonly calls: string[][] = []

  async search(queries: string[]): Promise<SearchResult[]> {
    this.calls.push([...queries])
    // One row per DISTINCT query, holding the port contract above: a duplicate is
    // not a second search. A fake that returned it as one would let a caller pass
    // its tests while double-billing against the real port, which is the exact
    // bug this contract exists to prevent.
    return [...new Set(queries)].map((query) => {
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
  constructor(
    private table: Record<
      string,
      { httpStatus: number; body: string; contentType?: string; providerError?: string }
    >,
  ) {}

  /**
   * Every call, with the options it was given.
   *
   * Recorded because the port delegates its whole bound to the caller: a caller
   * that quietly drops `opts.signal` leaves its fetches answering to nothing,
   * and that is invisible in the response. It is only visible here, in what the
   * caller handed over.
   */
  readonly calls: Array<{ url: string; mode: FetchMode; signal?: AbortSignal }> = []

  async get(url: string, mode: FetchMode, opts?: { signal?: AbortSignal }): Promise<FetchResponse> {
    this.calls.push({ url, mode, signal: opts?.signal })
    const row = this.table[url] ?? { httpStatus: 404, body: "" }
    return {
      url,
      httpStatus: row.httpStatus,
      body: row.body,
      contentType: row.contentType,
      providerError: row.providerError,
      ms: mode === "unlocked" ? 14_000 : 300,
      usd: mode === "unlocked" ? 0.008 : 0,
    }
  }
}
