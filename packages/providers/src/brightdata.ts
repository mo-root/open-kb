import type { SearchPort, SearchResult, FetchPort, FetchMode, FetchResponse } from "@open-kb/core"
import { BlockedHostError, publicOnlyFetch, type HostLookup } from "./safe-fetch.js"

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
  /**
   * How long one DIRECT fetch may take before it is abandoned as unreadable.
   *
   * Direct fetches hit arbitrary SERP-surfaced hosts, and a tar-pit or
   * firewalled host that never answers holds a pool worker for undici's
   * default ~300s header timeout — minutes of tail added by a handful of
   * hosts. The calibration script bounded this at 8 seconds; a front page
   * that has not answered in that long is the unreadable path anyway.
   *
   * Unlocked fetches are not bounded by this: they legitimately take 33-60s.
   * They get their own, far looser bound — see `unlockedTimeoutMs`.
   */
  directTimeoutMs?: number
  /**
   * How long one UNLOCKED fetch may take before it is abandoned.
   *
   * A BACKSTOP, not a deadline. An unlocked fetch is slow on purpose — the
   * provider is working through a challenge on the far side — so this has to
   * clear the slowest fetch that ever legitimately finished, not the typical
   * one. Bounding it like a direct fetch would kill the pages we pay for.
   *
   * Measured, two sources. The eight unlocker spans in
   * `runs/swarm-brightdata-com-202608060833.spans.jsonl` run 0.5s to 21.4s with
   * a 16.9s median, which is the ordinary case core/ports.ts records as 13-16s.
   * The slowest COMPLETED unlocked fetch on record is the stripe.com hard block
   * that comes back 200 with zero bytes after 33-60s — twice, on two different
   * zones (core/tests/sniff.test.ts). The default here is twice that worst
   * case: a fetch slower than anything ever measured against this account still
   * comes back, and a socket silent for two minutes is not being serviced.
   *
   * Something has to be here. The caller's signal was the whole bound, and half
   * the callers pass none, so an unlocked fetch from those paths was bounded by
   * nothing at all — Node's fetch applies no request timeout of its own and the
   * connection sits until undici's ~300s header timeout, or past it once
   * headers have arrived.
   */
  unlockedTimeoutMs?: number
  /** Pause before the single retry of a retryable failure. */
  retryMs?: number
  /**
   * How the DIRECT branch turns a name into addresses before it connects.
   *
   * Defaults to the system resolver. A test that replaces `fetchImpl` must
   * replace this too, and that is deliberate rather than an inconvenience: the
   * guard is not a layer the transport seam can switch off, so a fake socket
   * with a real resolver is a test that either goes to the network or fails
   * closed on a name nobody registered. Saying what the host resolves to is now
   * part of standing up a fake network.
   */
  lookup?: HostLookup
  /** Redirect hops the direct branch will follow, each one re-checked. */
  maxRedirects?: number
}

/**
 * The unlocked backstop's default, exported so it can be pinned against the
 * measurement it came from rather than quietly tuned. See
 * `Opts.unlockedTimeoutMs`: it must stay clear of a 60s fetch, because a 60s
 * unlocked fetch is a measured success and not a hang.
 */
export const DEFAULT_UNLOCKED_TIMEOUT_MS = 120_000

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

/**
 * The provider states its own limit; obey it rather than retry into the wall.
 *
 * Measured: the account was auto-throttled with "The request was auto-throttled
 * due to low success rate. Please decrease your request rate to 10/min." Firing
 * eighty concurrent requests into that keeps the success rate on the floor,
 * which keeps the throttle on — a penalty that renews itself for as long as the
 * client ignores the sentence explaining it.
 *
 * A throttle is ACCOUNT-wide, so spreading across more zones does not raise the
 * ceiling. The only thing that lifts it is slowing down until the success rate
 * recovers.
 */
const THROTTLED = /auto-throttled|rate limit|decrease your request rate|sr_rate_limit/i

/** Read the rate the provider asked for, in requests per minute. */
function statedRate(msg: string): number | null {
  const m = /([\d.]+)\s*\/\s*min/i.exec(msg) ?? /rate\s+to\s+([\d.]+)/i.exec(msg)
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export function brightDataSearch(creds: BrightDataCredentials, opts: Opts = {}): SearchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.serpUsd ?? 0.0015
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000))
  /** How long to wait before the one retry. The provider asks for 15 seconds. */
  const retryMs = Math.max(0, Math.floor(opts.retryMs ?? 16_000))

  /**
   * Shared across every call this port makes, because the limit is the
   * account's and not one request's. The first response that reports a throttle
   * sets the pace; everything already in flight starts queueing behind it.
   */
  let minGapMs = 0
  let nextSlotAt = 0
  const pace = async () => {
    if (minGapMs <= 0) return
    const now = Date.now()
    const slot = Math.max(now, nextSlotAt)
    nextSlotAt = slot + minGapMs
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now))
  }
  const noteThrottle = (msg: string) => {
    const perMin = statedRate(msg)
    // Ninety percent of the stated rate: sitting exactly on a limit is how you
    // discover it was measured differently at the other end.
    const gap = perMin ? Math.ceil(60_000 / (perMin * 0.9)) : 6_000
    if (gap > minGapMs) minGapMs = gap
  }

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
      /**
       * The same query twice used to be paid for twice AND reported four times.
       *
       * Both halves were real. The task list below is built per ELEMENT, so k
       * copies of one query built k*p tasks and issued k*p requests: the money
       * was genuinely spent twice at k=2. Then the fold keyed by `r.query` and
       * matched with `raw.filter(r => r.query === query)`, which for every copy
       * of "x" matched every copy's pages — so it returned k rows each summing
       * all k*p of them. Actual spend k*p*price, reported k*k*p*price. At k=2,
       * p=3: 6 requests bought where 3 were wanted, and 18 pages' worth of cost
       * reported. The error is QUADRATIC in duplicates, not a factor of two, so
       * a query repeated four times bills like sixteen.
       *
       * Dedupe belongs here rather than in the callers. Four call sites reach
       * this port — core/tools.ts, swarm/tools-paid.ts, swarm/orchestrator.ts's
       * metering wrapper and sweep.ts — and not one of them dedupes; the port is
       * the only layer that knows a query is about to become `pages` billable
       * requests, and the fifth caller written next month inherits the fix
       * instead of the bug. A model asked for twelve queries repeating itself is
       * not exotic, it is the normal failure mode of asking.
       *
       * Same query means the same string, exactly: not case-folded, not
       * trimmed. Two queries are one request only when they build one URL, and
       * encodeURIComponent sends "x", "X" and "x " to three different URLs that
       * Bright Data bills three times — folding them would report a spend that
       * did not happen, which is this same bug pointing the other way. Google
       * may well treat them alike; that is Google's equivalence and not one this
       * port can verify. The risk is lopsided too: merging two queries the
       * caller meant to keep apart silently drops one and the caller cannot get
       * it back, while failing to merge only spends what the caller explicitly
       * asked to spend.
       */
      const unique = [...new Set(queries)]

      // A blank query is `pages` paid requests for `q=`, and no arrangement of
      // whitespace comes back with a market. It is refused here, for free, in a
      // row of its own — the caller still learns what became of it.
      const runnable = unique.filter((query) => query.trim().length > 0)

      // One request per query PER page, all in flight together. Results from the
      // pages of one query are merged and deduplicated by URL before returning,
      // so a caller still sees one result per query and cannot double-count a row
      // that appeared on two pages.
      const tasks = runnable.flatMap((query) =>
        Array.from({ length: pages }, (_, page) => ({ query, page })),
      )

      const raw = await Promise.all(
        tasks.map(async ({ query, page }): Promise<SearchResult> => {
          const start = page * 10
          const target =
            `https://www.google.com/search?q=${encodeURIComponent(query)}` +
            `${start ? `&start=${start}` : ""}&brd_json=1`

          const once = async (zone: string): Promise<SearchResult> => {
            await pace()
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
              if (brdError && THROTTLED.test(brdError)) noteThrottle(brdError)

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
          if (!out.ok && (RETRYABLE.test(out.error ?? "") || THROTTLED.test(out.error ?? ""))) {
            // A throttled call waits a full pacing slot; anything else waits the
            // interval the provider named for a transient failure.
            const wait = THROTTLED.test(out.error ?? "") ? Math.max(retryMs, minGapMs) : retryMs
            await new Promise((r) => setTimeout(r, wait))
            // A different zone on the retry where one exists: if the first is
            // throttling, waiting is only half the answer.
            const second = await once(nextZone())
            // Bill both: each was a request the provider serviced.
            out = second.ok ? { ...second, usd: second.usd + out.usd } : { ...second, usd: second.usd + out.usd }
          }
          return out
        }),
      )

      // Fold the pages back into one result per DISTINCT query, in the order
      // each was first asked.
      //
      // Bucketing PARTITIONS `raw`: every request that was issued lands in
      // exactly one returned row, so the usd summed across the rows this returns
      // is exactly the usd of the requests actually made. That is the property
      // the whole accounting rests on, because core/tools.ts spans once per
      // returned row and the run meter adds those spans up — a row carrying
      // another row's cost is a meter that lies. The filter this replaces could
      // hand one request to several rows, which is precisely how a k*p spend was
      // reported as k^2*p.
      const byQuery = new Map<string, SearchResult[]>()
      for (const r of raw) {
        const bucket = byQuery.get(r.query)
        if (bucket) bucket.push(r)
        else byQuery.set(r.query, [r])
      }

      return unique.map((query) => {
        const mine = byQuery.get(query)
        // Blank: never dispatched, so there is nothing to bill and nothing to
        // report but the refusal itself.
        if (!mine) {
          return { query, hits: [], ok: false, error: "blank query — nothing was searched", usd: 0, ms: 0 }
        }
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

/**
 * The provider's refusal, bounded before it leaves this function.
 *
 * This string is not ours and it does not stop here: it rides `span.error`
 * through lib/stream-adapter.ts into BuildWorkflow, which renders it verbatim
 * into the DOM, and it is persisted whole into Supabase. Queue items 3h and
 * 3h-bis exist because server-origin text reaching a browser unbounded is a
 * problem this repo already decided it has; minting a new source of it without
 * a bound would be shipping that bug rather than inheriting it.
 *
 * So: a length the real values fit inside — Bright Data's are short sentences
 * like `country_not_supported` or `Requested site is not supported` — and a
 * conservative shape. Anything longer or stranger than a refusal reason is not
 * one, and the sniffer's own verdict still stands on its own without it.
 */
const REFUSAL_MAX = 120
function providerSentence(brdError: string | null, brdStatus: string | null): string | undefined {
  if (!brdError) return undefined
  const clean = brdError.replace(/\s+/g, " ").trim()
  // Control characters and angle brackets. Written with \p{Cc} rather than a
  // literal range: the first draft of this line spelled it /[\x00-\x1f<>]/ and
  // the escape landed as an actual NUL byte in the file, which made every
  // grep treat this source as binary while TypeScript compiled it happily.
  if (!clean || clean.length > REFUSAL_MAX || /[\p{Cc}<>]/u.test(clean)) return undefined
  const upstream = brdStatus && /^\d{3}$/.test(brdStatus) ? ` (upstream ${brdStatus})` : ""
  return clean + upstream
}

/**
 * OUR OWN refusal, held to the same bound as the provider's.
 *
 * `providerError` rides `span.error` into the DOM and into storage, and this
 * sentence carries a hostname somebody else chose — 253 characters of it, if
 * they like. Held to `REFUSAL_MAX` for that reason. Truncated rather than
 * dropped, which is the one way it differs from `providerSentence` above: a
 * provider's sentence that fails its shape check is discarded because the
 * sniffer's verdict stands without it, but a refusal that vanishes for being
 * long is the SSRF probe nobody sees in the log.
 */
function refusalSentence(message: string): string {
  const clean = message.replace(/[\p{Cc}<>]/gu, "").replace(/\s+/g, " ").trim()
  return clean.length > REFUSAL_MAX ? `${clean.slice(0, REFUSAL_MAX - 1)}…` : clean
}

export function brightDataFetch(creds: BrightDataCredentials, opts: Opts = {}): FetchPort {
  const f = opts.fetchImpl ?? fetch
  const price = opts.unlockUsd ?? 0.008
  const directTimeoutMs = Math.max(1, Math.floor(opts.directTimeoutMs ?? 8_000))
  const unlockedTimeoutMs = Math.max(1, Math.floor(opts.unlockedTimeoutMs ?? DEFAULT_UNLOCKED_TIMEOUT_MS))

  /**
   * The direct branch's socket, and the only one an attacker can aim.
   *
   * `url` here comes from the domain someone typed into the web app, from a
   * `<loc>` in that host's own sitemap, from a link on its homepage, or in swarm
   * from the model — none of which this process has any reason to trust with a
   * connection out of its own network. So the transport is WRAPPED rather than
   * used raw, and it is wrapped here rather than at the four call sites, because
   * a guard a caller has to remember is a guard the fifth caller does not have.
   *
   * It wraps `f`, not the global `fetch`, so replacing the socket in a test
   * still leaves the check in front of it. The alternative — guarding only the
   * default transport — makes `fetchImpl` an off switch for the SSRF defence,
   * which is a switch this repo would eventually find flipped.
   *
   * The unlocked branch below is NOT wrapped, and does not need to be: its
   * socket goes to api.brightdata.com, and the attacker-controlled url is a
   * string in a JSON body that Bright Data fetches from Bright Data's network.
   * There is no path from it to anything on this host.
   */
  const directFetch = publicOnlyFetch({
    fetchImpl: f,
    lookup: opts.lookup,
    maxRedirects: opts.maxRedirects,
  })

  return {
    async get(url: string, mode: FetchMode, callOpts?: { signal?: AbortSignal }): Promise<FetchResponse> {
      const started = Date.now()

      if (mode === "direct") {
        // The timeout and the caller's own signal race; whichever fires first
        // lands this fetch in the catch below, which is the designed
        // unreadable path — httpStatus 0, no second error shape.
        const timeout = AbortSignal.timeout(directTimeoutMs)
        const signal = callOpts?.signal ? AbortSignal.any([timeout, callOpts.signal]) : timeout
        try {
          // `redirect: "follow"` is still what this asks for and still what it
          // gets — `directFetch` follows the chain itself so that it can check
          // each hop's address, and hands back the response the chain ended on.
          const res = await directFetch(url, { redirect: "follow", signal })
          const body = await res.text()
          return { url, httpStatus: res.status, body, contentType: res.headers.get("content-type") ?? undefined, ms: Date.now() - started, usd: 0 }
        } catch (e) {
          // An unreadable response either way — nothing came back and nothing is
          // billed — but WHICH unreadable is worth a sentence. A host refused by
          // the address guard and a host that timed out are the same
          // `httpStatus: 0` to every reader downstream, and one of them means
          // somebody is probing this deployment's own network. That belongs in
          // the span, not in a shrug.
          const refused = e instanceof BlockedHostError ? refusalSentence(e.message) : undefined
          const abandoned = callOpts?.signal?.aborted
            ? "the caller cancelled this fetch"
            : timeout.aborted
              ? `direct fetch gave up after ${directTimeoutMs}ms`
              : undefined
          return {
            url,
            httpStatus: 0,
            body: "",
            ms: Date.now() - started,
            usd: 0,
            contentType: undefined,
            providerError: refused ?? abandoned,
          }
        }
      }

      // Composed exactly like the direct branch above, and for the same reason:
      // whichever fires first ends the fetch, so a caller cancelling a run
      // still gets its money back from the socket immediately instead of
      // waiting out a backstop sized for the slowest page on the web.
      //
      // The number is the only difference, and it is the whole difference —
      // 8s is "a front page that has not answered is unreadable", 120s is
      // "nothing here is being serviced any more". See `unlockedTimeoutMs`.
      const timeout = AbortSignal.timeout(unlockedTimeoutMs)
      const signal = callOpts?.signal ? AbortSignal.any([timeout, callOpts.signal]) : timeout

      try {
        const res = await f(API, {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ zone: creds.unlockerZone, url, format: "raw" }),
          signal,
        })
        const body = await res.text()

        // The refusal lives in a header, not in the status or the body — the
        // same shape the SERP path already reads. A run reported "unreadable"
        // for pages whose response was carrying the provider's own sentence
        // about why, and the sniffer was left inferring `empty-body` from a
        // zero-byte body that had an explanation attached to it.
        const brdError = res.headers.get("x-brd-error")
        const brdStatus = res.headers.get("x-brd-status-code")

        // The body is still returned as-is. A 200 with an empty body is a real,
        // measured outcome and it is the sniffer's job to call it, not ours to
        // hide — the header rides alongside the verdict, it does not replace it.
        return {
          url,
          httpStatus: res.status,
          body,
          contentType: res.headers.get("content-type") ?? undefined,
          providerError: providerSentence(brdError, brdStatus),
          ms: Date.now() - started,
          usd: price,
        }
      } catch (e) {
        // The request never completed (DNS failure, connection reset, the
        // backstop, a cancelled run), Bright Data has nothing to bill, so this
        // must not carry a price. Compare the completed-response branch above,
        // which keeps `usd: price` because a response that came back (even a
        // 500) was a request Bright Data serviced. The backstop firing lands
        // here, on the $0 side, deliberately: we abandoned it, we did not read
        // it.
        //
        // Which of those it was, said rather than left to be inferred —
        // httpStatus 0 spells all four the same, and "the operator stopped this
        // run" reads very differently from "the host is a tar pit" in a span
        // log. The caller's signal is checked first: when both fired it is the
        // one that fired first, since the backstop would have taken two
        // minutes to get here on its own.
        const abandoned = callOpts?.signal?.aborted
          ? "the caller cancelled this fetch"
          : timeout.aborted
            ? `unlocked fetch gave up after ${unlockedTimeoutMs}ms`
            : undefined
        return { url, httpStatus: 0, body: "", ms: Date.now() - started, usd: 0, contentType: undefined, providerError: abandoned }
      }
    },
  }
}
