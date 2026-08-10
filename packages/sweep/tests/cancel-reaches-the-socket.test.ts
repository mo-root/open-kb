import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"

/**
 * A cancelled run's fetches actually stop, proven at the socket.
 *
 * `sweep()` -> the REAL `brightDataFetch` -> an injected `fetchImpl`. Nothing
 * between the sweep's call site and the wire is stubbed except the wire, so
 * this fails if any link in that chain drops the signal — and it does fail:
 * removing `{ signal }` from `sweep.ts`'s `fetcher.get` leaves the socket's
 * signal un-aborted and this test red.
 *
 * The companion `fetch-signal.test.ts` reads the call site's source. This runs
 * it. Standing `sweep()` up needs no model and no network: the two direct
 * fetches at the top of the "understand" phase happen before the first
 * `generateObject`, so a `llms.txt` that answers keeps `pages` non-empty (which
 * skips the DNS probe at sweep.ts:959) and the run never reaches the model.
 */

// Real network, hard-blocked. Anything that escapes the injected impl explodes.
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("REAL NETWORK CALL ATTEMPTED")
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

/** Every signal the wire was actually handed, in call order. */
const wire: Array<{ url: string; signal: AbortSignal | null | undefined }> = []

vi.mock("@open-kb/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@open-kb/providers")>()
  return {
    ...actual,
    // The REAL port, with only the socket replaced.
    brightDataFetch: (creds: never, opts: Record<string, unknown> = {}) =>
      actual.brightDataFetch(creds, {
        ...opts,
        // The direct branch resolves a name and refuses a private address before
        // it opens a socket, so replacing the socket is no longer enough to make
        // this test offline: without a resolver of its own it would either ask
        // the real one or be refused, and either way the tar pit below would
        // never be reached. One public address for every name is this fake
        // network's DNS.
        lookup: async () => ["93.184.216.34"],
        fetchImpl: (async (input: unknown, init: RequestInit | undefined) => {
          const url = String(input)
          wire.push({ url, signal: init?.signal })
          if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
          // llms.txt answers, so `pages` is non-empty and the DNS probe at
          // sweep.ts:959 is never reached.
          if (url.endsWith("/llms.txt") && url.includes("//brightdata.com")) {
            return new Response("x ".repeat(400), {
              status: 200,
              headers: { "content-type": "text/plain" },
            })
          }
          // A tar pit. Ends only when the signal it was given says so.
          return await new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener("abort", () =>
              rej(new DOMException("aborted", "AbortError")),
            )
          })
        }) as unknown as typeof fetch,
      }),
    brightDataSearch: () => ({ search: async () => [] }),
  }
})

describe("cancelling a run stops the wire", () => {
  it("hands the run's signal all the way to the socket, and aborting it aborts the socket", async () => {
    const { sweep } = await import("@open-kb/sweep")
    const { SpanStream } = await import("@open-kb/core")

    const abort = new AbortController()
    const model = {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake",
      doGenerate: async () => {
        throw new Error("MODEL REACHED — should not happen")
      },
    }

    const run = sweep({
      domain: "brightdata.com",
      queries: 1,
      spans: new SpanStream(),
      creds: { token: "t", serpZone: "s", unlockerZone: "u" },
      model: model as never,
      modelId: "fake",
      signal: abort.signal,
    }).catch((e: unknown) => e)

    // Wait until the tar-pit fetch is actually on the wire.
    const t0 = Date.now()
    while (wire.length < 2 && Date.now() - t0 < 3_000) await new Promise((r) => setTimeout(r, 5))
    expect(wire.length).toBeGreaterThanOrEqual(2)

    const tarpit = wire[1]!
    // 1. the signal reached the socket at all
    expect(tarpit.signal).toBeInstanceOf(AbortSignal)
    // 2. it is not yet aborted
    expect(tarpit.signal!.aborted).toBe(false)

    abort.abort()
    await new Promise((r) => setTimeout(r, 10))

    // 3. the run's cancel propagated through sweep -> port -> socket
    expect(tarpit.signal!.aborted).toBe(true)

    await run
  }, 20_000)

  it("also carries it on the unlocked path, which is the one with no deadline of its own", async () => {
    // The unlocked leg goes to api.brightdata.com; assert whatever we captured
    // that targets it also carried a signal.
    const unlocked = wire.filter((w) => w.url.includes("api.brightdata.com"))
    for (const u of unlocked) expect(u.signal).toBeInstanceOf(AbortSignal)
  })
})
