import { isIpLiteral, isReservedHost } from "@open-kb/core"

/**
 * A `fetch` that will not be steered onto this machine's own network.
 *
 * WHY IT IS HERE AND NOT IN THE ROUTE, which is the only interesting decision in
 * this file.
 *
 * `isReservedHost` in core refuses a host that is SPELLED as something reserved,
 * and `POST /api/map` calls it on the domain it is handed. That closes the door
 * an attacker types through and it is not enough, twice over:
 *
 *   1. `127.0.0.1.nip.io` is a public name. It has a public registrar, a public
 *      suffix, and an `A` record pointing at 127.0.0.1. Nothing about how it is
 *      written is reserved; only its DNS answer is. The same is true of any
 *      domain the attacker owns, which is the general case and costs $10.
 *   2. A public host that answers `302 Location: http://169.254.169.254/…` is
 *      followed by `redirect: "follow"` with no say from us, and the hop that
 *      lands inside is a hop the route never saw. The route validates ONE
 *      string, once, before a run exists; a run then fetches `/llms.txt`,
 *      `docs.<host>/llms.txt`, `/`, `/sitemap.xml`, every product page the nav
 *      names, and — in swarm — every url the model asks for. The route is not
 *      present for any of those.
 *
 * So the check has to sit where the socket is opened, and it has to run again on
 * every hop. That is this package: core declares the port and may not do HTTP or
 * read env, the web route is one of four callers and the only one that is a
 * request handler at all, and `brightDataFetch` is the single seam every fetch
 * in the product passes through — `packages/sweep` and `packages/swarm` both
 * take their `FetchPort` from it. Guarding here guards all of them; guarding in
 * the route would guard one string and zero redirects.
 *
 * WHAT IT DOES NOT COVER. The address is checked, then `fetch` resolves the name
 * again for itself, and between those two moments a record with a one-second TTL
 * can change — classic DNS rebinding. Closing that needs the socket to be
 * pinned to the address that was approved, and Node's `fetch` exposes no
 * `lookup` hook to pin it with (undici's `Agent` does, and undici is not a
 * dependency of this package). It is a materially harder attack than the two
 * above — it needs a race won against a resolver, where the decoy name and the
 * redirect each need one request — but it is not closed, and this paragraph is
 * here so nobody reads the rest of the file as if it were.
 */

/** Every address a name answers with, in the order the resolver gave them. */
export type HostLookup = (host: string) => Promise<string[]>

export interface SafeFetchOpts {
  /** The transport for ONE hop. Defaults to the global `fetch`. Redirects are
   *  never delegated to it — see `redirect: "manual"` below. */
  fetchImpl?: typeof fetch
  /** Defaults to the system resolver. Injected in tests, which must not depend
   *  on what a real name resolves to today. */
  lookup?: HostLookup
  /** Hops followed before giving up. `fetch`'s own limit is 20; five is past
   *  every legitimate chain this product has met (`example.com` → `www.` →
   *  https, at worst). */
  maxRedirects?: number
}

/**
 * A refusal by the guard, distinguishable from a network failure.
 *
 * The port turns both into the same unreadable response, because that is what a
 * caller can act on — but the SENTENCE differs, and it has to: "we would not
 * connect there" and "it did not answer" are different facts, and a span log
 * that spells them the same is a deployment where a live SSRF probe reads as a
 * flaky host.
 */
export class BlockedHostError extends Error {
  readonly host: string
  readonly address: string | null

  constructor(message: string, host: string, address: string | null = null) {
    super(message)
    this.name = "BlockedHostError"
    this.host = host
    this.address = address
  }
}

/** The system resolver, imported at call time. A static import would pull
 *  `node:dns` into every consumer of this package, including a bundle that has
 *  no business holding it. */
async function systemLookup(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises")
  // `all` because a name can answer with several addresses and `fetch` may use
  // any of them; `verbatim` because reordering them is the resolver's opinion
  // about which to prefer, and this code has an opinion about all of them.
  const answers = await lookup(host, { all: true, verbatim: true })
  return answers.map((a) => a.address)
}

/**
 * Run a promise under the caller's signal.
 *
 * The resolver has to be inside the deadline. `AbortSignal.timeout` only bounds
 * a `fetch`, and moving name resolution out of the fetch and in front of it
 * moved it out from under that bound too — a host whose nameserver tar-pits
 * would hold a pool worker for the system resolver's own timeout, which is the
 * exact tail the direct branch's 8s was measured and chosen to cut. `dns.lookup`
 * takes no signal, so the wait is what gets cancelled; the query itself finishes
 * in the background and is ignored.
 */
function underSignal<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

/**
 * Refuse this url, or return quietly.
 *
 * Fails CLOSED on everything: an unknown scheme, a name that does not resolve, a
 * name that resolves to nothing, and a name where ANY ONE of the answers is
 * private. That last one is not caution, it is the only correct reading — the
 * caller cannot choose which address `fetch` will use, so a name answering
 * `93.184.216.34, 127.0.0.1` is a name that reaches loopback whenever the
 * resolver feels like putting it first.
 */
async function assertPublic(url: URL, lookup: HostLookup, signal?: AbortSignal | null): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedHostError(`refused ${url.protocol}// — only http and https are fetched`, url.hostname)
  }

  const host = url.hostname
  if (isReservedHost(host)) {
    throw new BlockedHostError(`refused ${host} — not a public host`, host)
  }

  // A literal has no name behind it. `isReservedHost` just judged the address
  // itself, and a resolver would hand the same bytes back.
  if (isIpLiteral(host)) return

  let addresses: string[]
  try {
    addresses = await underSignal(lookup(host), signal)
  } catch (e) {
    // A cancelled or timed-out wait is not a verdict on the host, and must not
    // be reported as one — the port tells those apart by the error's type.
    if (signal?.aborted) throw e
    throw new BlockedHostError(`refused ${host} — it does not resolve`, host)
  }
  if (!addresses.length) throw new BlockedHostError(`refused ${host} — it resolves to no address`, host)

  for (const address of addresses) {
    if (isReservedHost(address)) {
      throw new BlockedHostError(`refused ${host} — it resolves to ${address}, which is not public`, host, address)
    }
  }
}

/** Let go of a hop's body. A 3xx usually carries a short one, and a stream left
 *  unread holds its socket until the pool reclaims it. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // Already consumed, or a stub with no stream. Nothing to reclaim.
  }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** Whatever the ambient `fetch` accepts as its first argument. Read off `fetch`
 *  itself rather than written as `RequestInfo | URL`, because this package
 *  compiles without the DOM lib and that name does not exist here. */
type FetchInput = Parameters<typeof fetch>[0]

/**
 * `fetch`, with the address check in front of every hop.
 *
 * Shaped as a `typeof fetch` so it drops in wherever the raw one was, and so
 * that the code below it cannot tell the difference — the point being that
 * nothing downstream has to remember to call a guard.
 *
 * Redirects are followed HERE rather than by the transport, because a transport
 * following them is a transport making connections this function never got to
 * judge. `redirect: "manual"` is forced on every hop for that reason, and it
 * overrides whatever the caller asked for: `redirect: "follow"` at a call site
 * is a request for the final response, which is exactly what this still returns.
 */
export function publicOnlyFetch(opts: SafeFetchOpts = {}): typeof fetch {
  const transport = opts.fetchImpl ?? fetch
  const lookup = opts.lookup ?? systemLookup
  const maxRedirects = Math.max(0, Math.floor(opts.maxRedirects ?? 5))

  return async function guarded(input: FetchInput, init?: RequestInit): Promise<Response> {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    let target = new URL(href)

    for (let hop = 0; ; hop++) {
      await assertPublic(target, lookup, init?.signal)

      // The FIRST hop is passed the caller's own argument, untouched. The url a
      // caller handed us and `new URL(...).href` differ over a trailing slash
      // and over case, and a request should go out spelled the way it was
      // asked for.
      const res = await transport(hop === 0 ? input : target.href, { ...init, redirect: "manual" })

      const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null
      if (!location) return res

      let next: URL
      try {
        next = new URL(location, target)
      } catch {
        // A redirect nobody can follow is not a redirect. Hand the 3xx back and
        // let the sniffer call it what it is.
        return res
      }

      if (hop >= maxRedirects) {
        await discard(res)
        throw new BlockedHostError(`refused ${target.hostname} — more than ${maxRedirects} redirects`, target.hostname)
      }

      await discard(res)
      target = next
    }
  } as typeof fetch
}
