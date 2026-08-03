import type { SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "@open-kb/core"

export interface BrightDataCredentials {
  token: string
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
}

const API = "https://api.brightdata.com/request"

export function brightDataSearch(creds: BrightDataCredentials, opts: Opts = {}): SearchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.serpUsd ?? 0.0015

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
          const started = Date.now()
          const start = page * 10
          const target =
            `https://www.google.com/search?q=${encodeURIComponent(query)}` +
            `${start ? `&start=${start}` : ""}&brd_json=1`
          try {
            const res = await f(API, {
              method: "POST",
              headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ zone: creds.serpZone, url: target, format: "raw" }),
            })
            const ms = Date.now() - started
            if (!res.ok) return { query, hits: [], ok: false, error: `serp http ${res.status}`, usd: price, ms }
            const text = await res.text()
            let parsed: { organic?: Array<{ link?: string; title?: string; description?: string }> }
            try {
              parsed = JSON.parse(text)
            } catch {
              return { query, hits: [], ok: false, error: "serp returned unparseable body", usd: price, ms }
            }
            const hits = (parsed.organic ?? [])
              .filter((h) => typeof h.link === "string")
              .map((h) => ({ url: h.link!, title: h.title ?? "", description: h.description ?? "" }))
            return { query, hits, ok: true, usd: price, ms }
          } catch (e) {
            return { query, hits: [], ok: false, error: `serp failed: ${(e as Error).message}`, usd: 0, ms: Date.now() - started }
          }
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
