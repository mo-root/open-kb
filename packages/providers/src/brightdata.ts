import type { SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "@open-kb/core"

export interface BrightDataCredentials {
  token: string
  /**
   * One zone, or several separated by commas.
   *
   * A wave fires twenty searches at once and several hundred over a run, and a
   * single zone throttles under that: one measured run had 42 of 44 searches
   * refused with "response body was rejected", while the same queries succeeded
   * twenty seconds later. Spreading the calls across the zones an account
   * already has divides the load without asking anyone for anything.
   */
  serpZone: string
  unlockerZone: string
}

interface Opts {
  fetchImpl?: typeof fetch
  /** rough per-call prices, used for accounting only */
  serpUsd?: number
  unlockUsd?: number
  /** Result pages read per query. Each page is its own billable call. */
  pages?: number
  /**
   * How long one call may take before it is abandoned.
   *
   * Measured: with queries running in a pool rather than fixed chunks, thirty of
   * forty finished in 43 seconds and the last ten took 133. A few calls sit for
   * minutes. Chunking used to hide them inside an already-slow batch; a pool
   * exposes them as the tail, and the tail was most of the wave.
   *
   * A page that has not answered in this long is not about to answer with
   * anything the other pages did not already give us, and its nine siblings are
   * done. Abandoning it costs one page of one query and returns the worker to
   * the queue.
   */
  timeoutMs?: number
  /** Pause before the single retry of a retryable failure. */
  retryMs?: number
}

const API = "https://api.brightdata.com/request"

/**
 * Failures this provider recovers from on its own, given a moment.
 *
 * Measured: a run fired 44 searches and 42 came back "response body was
 * rejected" with an upstream 502. The same query twenty seconds later returned
 * eight results. The zone was throttling under the day's volume, not broken,
 * and the provider says so itself: "this query recently failed and cannot be
 * attempted at this time. Please try again later, after a minimum of 15
 * seconds."
 *
 * A refusal that names its own retry interval is not a result. Giving up on the
 * first one turned a working run into a 95% failure.
 */
const RETRYABLE = /rejected|recently failed|try again|temporarily|expect_body|\b(502|503|429)\b/i

export function brightDataSearch(creds: BrightDataCredentials, opts: Opts = {}): SearchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.serpUsd ?? 0.0015
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000))
  /** How long to wait before the one retry. The provider asks for 15 seconds. */
  const retryMs = Math.max(0, Math.floor(opts.retryMs ?? 16_000))

  const zones = creds.serpZone
    .split(",")
    .map((z) => z.trim())
    .filter(Boolean)
  // Round-robin rather than random: an even split is the point, and a random
  // pick over a small number of zones is lumpy.
  let cursor = 0
  const nextZone = () => zones[cursor++ % zones.length]!

  /**
   * How many result pages to read per query.
   *
   * Reading only the first page was leaving most of the market unread. Measured
   * on one query: page 1 returned 7 distinct hosts, and pages 2-5 added 9, 9, 5
   * and 7 more, **37 hosts across five pages against 7 from the first**, still
   * not saturating at the fifth. `num` cannot substitute for this; Google
   * deprecated it and returns roughly eight organic rows whatever you ask for.
   *
   * Pages cost exactly what queries cost, so depth here is strictly better value
   * than breadth for reaching the tail of a market: the second page of a good
   * query beats the first page of a worse one.
   */
  const pages = Math.max(1, Math.floor(opts.pages ?? 3))

  return {
    async search(queries) {
      // One request per query PER page, all in flight together. Results from the
      // pages of one query are merged and deduplicated by URL before returning,
      // so a caller still sees one result per query and cannot double-count a row
      // that appeared on two pages.
      const tasks = queries.flatMap((query) =>
        Array.from({ length: pages }, (_, page) => ({ query, page })),
      )

      const raw = await Promise.all(
        tasks.map(async ({ query, page }): Promise<SearchResult> => {
          const start = page * 10
          const target =
            `https://www.google.com/search?q=${encodeURIComponent(query)}` +
            `${start ? `&start=${start}` : ""}&brd_json=1`

          const once = async (zone: string): Promise<SearchResult> => {
            const started = Date.now()
            try {
              const res = await f(API, {
                method: "POST",
                headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ zone, url: target, format: "raw" }),
                signal: AbortSignal.timeout(timeoutMs),
              })
              const ms = Date.now() - started

              // The reason lives in a header, not in the status. Bright Data
              // answers 200 and puts the outcome in `x-brd-error` with the
              // upstream's own code in `x-brd-status-code`, so a 200 with an
              // empty body is this provider's shape for a refusal and the header
              // is the only place the cause exists.
              const brdError = res.headers.get("x-brd-error")
              const brdStatus = res.headers.get("x-brd-status-code")
              const reason = brdError
                ? `${brdError}${brdStatus ? ` (upstream ${brdStatus})` : ""}`
                : undefined

              if (!res.ok) {
                return { query, hits: [], ok: false, error: reason ?? `serp http ${res.status}`, usd: price, ms }
              }
              const text = await res.text()
              let parsed: { organic?: Array<{ link?: string; title?: string; description?: string }> }
              try {
                parsed = JSON.parse(text)
              } catch {
                return {
                  query,
                  hits: [],
                  ok: false,
                  error:
                    reason ?? (text.length === 0 ? "serp returned an empty body" : "serp returned unparseable body"),
                  usd: price,
                  ms,
                }
              }
              const hits = (parsed.organic ?? [])
                .filter((h) => typeof h.link === "string")
                .map((h) => ({ url: h.link!, title: h.title ?? "", description: h.description ?? "" }))
              return { query, hits, ok: true, usd: price, ms }
            } catch (e) {
              const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError"
              return {
                query,
                hits: [],
                ok: false,
                error: timedOut ? `serp gave up after ${timeoutMs}ms` : `serp failed: ${(e as Error).message}`,
                // Nothing came back, so Bright Data has nothing to bill.
                usd: 0,
                ms: Date.now() - started,
              }
            }
          }

          let out = await once(nextZone())
          // One retry, past the interval the provider names. Workers run
          // concurrently, so this costs one worker's time rather than the wave's.
          if (!out.ok && RETRYABLE.test(out.error ?? "")) {
            await new Promise((r) => setTimeout(r, retryMs))
            // A different zone on the retry where one exists: if the first is
            // throttling, waiting is only half the answer.
            const second = await once(nextZone())
            // Bill both: each was a request the provider serviced.
            out = second.ok ? { ...second, usd: second.usd + out.usd } : { ...second, usd: second.usd + out.usd }
          }
          return out
        }),
      )

      // Fold the pages back into one result per query, in the order asked.
      return queries.map((query) => {
        const mine = raw.filter((r) => r.query === query)
        const seen = new Set<string>()
        const hits: SearchResult["hits"] = []
        for (const r of mine) {
          for (const h of r.hits) {
            if (seen.has(h.url)) continue
            seen.add(h.url)
            hits.push(h)
          }
        }
        const failures = mine.filter((r) => !r.ok)
        return {
          query,
          hits,
          // A query whose first page worked has produced results, even if a later
          // page failed. Only a query where every page failed is a failed query —
          // calling it failed because page four timed out would discard the rows
          // pages one to three actually returned.
          ok: failures.length < mine.length,
          error: failures.length ? `${failures.length}/${mine.length} pages failed: ${failures[0]!.error}` : undefined,
          usd: mine.reduce((n, r) => n + r.usd, 0),
          ms: Math.max(...mine.map((r) => r.ms)),
        }
      })
    },
  }
}

export function brightDataFetch(creds: BrightDataCredentials, opts: Opts = {}): FetchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.unlockUsd ?? 0.008

  return {
    async get(url: string, mode: FetchMode): Promise<FetchResponse> {
      const started = Date.now()

      if (mode === "direct") {
        try {
          const res = await f(url, { redirect: "follow" })
          const body = await res.text()
          return { url, httpStatus: res.status, body, contentType: res.headers.get("content-type") ?? undefined, ms: Date.now() - started, usd: 0 }
        } catch (e) {
          return { url, httpStatus: 0, body: "", ms: Date.now() - started, usd: 0, contentType: undefined }
        }
      }

      try {
        const res = await f(API, {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ zone: creds.unlockerZone, url, format: "raw" }),
        })
        const body = await res.text()
        // Deliberately returned as-is. A 200 with an empty body is a real, measured outcome
        // and it is the sniffer's job to call it, not ours to hide.
        return { url, httpStatus: res.status, body, contentType: res.headers.get("content-type") ?? undefined, ms: Date.now() - started, usd: price }
      } catch (e) {
        // The request never completed (DNS failure, connection reset, timeout before any
        // response), Bright Data has nothing to bill, so this must not carry a price.
        // Compare the completed-but-error-status branch above, which keeps `usd: price`
        // because a response that came back (even a 500) was a request Bright Data serviced.
        return { url, httpStatus: 0, body: "", ms: Date.now() - started, usd: 0, contentType: undefined }
      }
    },
  }
}
