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
}

const API = "https://api.brightdata.com/request"

export function brightDataSearch(creds: BrightDataCredentials, opts: Opts = {}): SearchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.serpUsd ?? 0.0015

  return {
    async search(queries) {
      return Promise.all(
        queries.map(async (query): Promise<SearchResult> => {
          const started = Date.now()
          const target = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&brd_json=1`
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
        // and it is the sniffer's job to call it — not ours to hide.
        return { url, httpStatus: res.status, body, contentType: res.headers.get("content-type") ?? undefined, ms: Date.now() - started, usd: price }
      } catch (e) {
        return { url, httpStatus: 0, body: "", ms: Date.now() - started, usd: price, contentType: undefined }
      }
    },
  }
}
