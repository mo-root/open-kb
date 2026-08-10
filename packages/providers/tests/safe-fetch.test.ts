import { describe, it, expect, vi } from "vitest"
import { publicOnlyFetch, BlockedHostError, type HostLookup } from "../src/safe-fetch.js"

/**
 * The second of the two SSRF layers, and the one that has to hold.
 *
 * `isReservedHost` refuses a host that is SPELLED as something private. This
 * refuses a host that RESOLVES to something private, on the first hop and on
 * every redirect after it — the two cases a validator on one input string
 * cannot reach, and the two the audit found open:
 *
 *   `127.0.0.1.nip.io` is a public name with an A record of 127.0.0.1.
 *   A public page answering `302 Location: http://169.254.169.254/…` was
 *   followed by `redirect: "follow"` with nothing in between.
 *
 * Every test here injects both halves of the network — the resolver and the
 * socket — so nothing below touches DNS or the wire.
 */

/** A resolver over a table. An unlisted name does not resolve, which is what an
 *  unregistered domain does, and the guard has to fail closed on it. */
const resolver = (table: Record<string, string[]>): HostLookup => {
  return async (host: string) => {
    const answer = table[host]
    if (!answer) throw new Error(`ENOTFOUND ${host}`)
    return answer
  }
}

const PUBLIC = "93.184.216.34"

/** A socket that answers 200 for anything, recording what it was asked for.
 *  Both parameters are declared because several assertions read `init` back
 *  through `mock.calls[0][1]`, which a one-argument `vi.fn` types out of
 *  existence. */
const okSocket = () =>
  vi.fn(async (input: unknown, _init?: RequestInit) => new Response("hello", { status: 200, headers: { "x-asked": String(input) } }))

/** A socket that redirects `from` onto `to` once, and answers 200 elsewhere. */
const redirectSocket = (from: string, to: string) =>
  vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url === from) return new Response("", { status: 302, headers: { location: to } })
    return new Response(`landed on ${url}`, { status: 200 })
  })

describe("publicOnlyFetch refuses the host that is written private", () => {
  it("never opens a socket for a literal, in any notation, or for an internal name", async () => {
    const socket = okSocket()
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup: resolver({}) })

    for (const url of [
      "http://127.0.0.1/llms.txt",
      "http://10.0.0.5/llms.txt",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://0177.0.0.1/llms.txt", // octal loopback
      "http://2130706433/llms.txt", // decimal loopback
      "http://0x7f000001/llms.txt", // hex loopback
      "http://127.1/llms.txt", // short form
      "http://[::1]/llms.txt",
      "http://[::ffff:127.0.0.1]/llms.txt",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://internal-jenkins.corp/",
      "http://localhost:8080/",
    ]) {
      await expect(f(url), url).rejects.toBeInstanceOf(BlockedHostError)
    }

    // The point of this assertion: not one of the twelve reached the wire. A
    // guard that refuses after connecting has already leaked whether the port
    // is open, and on a metadata endpoint it has already fetched the answer.
    expect(socket).not.toHaveBeenCalled()
  })

  it("refuses a scheme that is not http or https", async () => {
    const socket = okSocket()
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup: resolver({ "a.com": [PUBLIC] }) })
    await expect(f("file:///etc/passwd")).rejects.toBeInstanceOf(BlockedHostError)
    await expect(f("gopher://a.com/")).rejects.toBeInstanceOf(BlockedHostError)
    expect(socket).not.toHaveBeenCalled()
  })
})

describe("publicOnlyFetch refuses the host that only RESOLVES private", () => {
  it("refuses 127.0.0.1.nip.io — a public name whose A record is loopback", async () => {
    const socket = okSocket()
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "127.0.0.1.nip.io": ["127.0.0.1"] }),
    })

    const err = await f("https://127.0.0.1.nip.io/llms.txt").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlockedHostError)
    expect((err as BlockedHostError).address).toBe("127.0.0.1")
    // The sentence names the address, because "refused" without it is a bug
    // report nobody can act on.
    expect((err as BlockedHostError).message).toContain("127.0.0.1")
    expect(socket).not.toHaveBeenCalled()
  })

  it("refuses a domain that answers with one public address AND one private one", async () => {
    // The caller cannot pick which address `fetch` uses, so a name that can
    // reach loopback is a name that reaches loopback. Any private answer is
    // fatal, not outvoted.
    const socket = okSocket()
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "split-horizon.com": [PUBLIC, "10.0.0.5"] }),
    })
    await expect(f("https://split-horizon.com/")).rejects.toBeInstanceOf(BlockedHostError)
    expect(socket).not.toHaveBeenCalled()
  })

  it("fails closed when the name does not resolve, or resolves to nothing at all", async () => {
    const socket = okSocket()
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "empty.com": [] }),
    })
    await expect(f("https://never-registered.com/")).rejects.toBeInstanceOf(BlockedHostError)
    await expect(f("https://empty.com/")).rejects.toBeInstanceOf(BlockedHostError)
    expect(socket).not.toHaveBeenCalled()
  })

  it("does not ask the resolver about an address, because there is no name behind one", async () => {
    const socket = okSocket()
    const lookup = vi.fn(async () => [PUBLIC])
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup })
    const res = await f("https://8.8.8.8/llms.txt")
    expect(res.status).toBe(200)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("publicOnlyFetch checks every redirect hop, not just the first", () => {
  it("refuses a public page that 302s onto the metadata endpoint", async () => {
    const socket = redirectSocket("https://evil.com/", "http://169.254.169.254/latest/meta-data/")
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "evil.com": [PUBLIC] }),
    })

    const err = await f("https://evil.com/", { redirect: "follow" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlockedHostError)
    expect((err as BlockedHostError).host).toBe("169.254.169.254")
    // Hop one happened — evil.com is a real public site and we did read it.
    // Hop two did not, which is the whole assertion.
    expect(socket).toHaveBeenCalledTimes(1)
    expect(String(socket.mock.calls[0]![0])).toBe("https://evil.com/")
  })

  it("refuses a redirect onto a public NAME that resolves privately, two hops in", async () => {
    const socket = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === "https://evil.com/") return new Response("", { status: 301, headers: { location: "https://hop2.com/" } })
      if (url === "https://hop2.com/") return new Response("", { status: 302, headers: { location: "https://127.0.0.1.nip.io/" } })
      return new Response("reached the inside", { status: 200 })
    })
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "evil.com": [PUBLIC], "hop2.com": [PUBLIC], "127.0.0.1.nip.io": ["127.0.0.1"] }),
    })
    await expect(f("https://evil.com/")).rejects.toBeInstanceOf(BlockedHostError)
    expect(socket).toHaveBeenCalledTimes(2)
  })

  it("refuses a relative Location that lands on a private host via the hop's own base", async () => {
    // `Location: //169.254.169.254/` is scheme-relative: resolved against the
    // current hop it is a different HOST, and a guard that only re-checks
    // absolute urls walks straight into it.
    const socket = redirectSocket("https://evil.com/", "//169.254.169.254/latest/")
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "evil.com": [PUBLIC] }),
    })
    await expect(f("https://evil.com/")).rejects.toBeInstanceOf(BlockedHostError)
    expect(socket).toHaveBeenCalledTimes(1)
  })

  it("stops a redirect loop rather than following it forever", async () => {
    const socket = vi.fn(async () => new Response("", { status: 302, headers: { location: "https://a.com/next" } }))
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "a.com": [PUBLIC] }),
      maxRedirects: 3,
    })
    await expect(f("https://a.com/")).rejects.toBeInstanceOf(BlockedHostError)
    expect(socket).toHaveBeenCalledTimes(4) // the first request plus three followed hops
  })

  it("never delegates redirect following to the transport", async () => {
    // `redirect: "manual"` on every hop is what makes the per-hop check
    // possible at all. A transport left on "follow" would make the connection
    // this function exists to judge, and the judgement would be of a url that
    // was never fetched.
    const socket = okSocket()
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup: resolver({ "a.com": [PUBLIC] }) })
    await f("https://a.com/", { redirect: "follow" })
    expect((socket.mock.calls[0]![1] as RequestInit).redirect).toBe("manual")
  })
})

describe("publicOnlyFetch leaves the honest case alone", () => {
  it("fetches an ordinary public domain, passing the caller's url through unchanged", async () => {
    const socket = okSocket()
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup: resolver({ "resend.com": [PUBLIC] }) })
    const res = await f("https://resend.com/llms.txt")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello")
    // Not `new URL(...).href`: the url goes out spelled the way it was asked
    // for, so a caller reading its own request back still recognises it.
    expect(socket.mock.calls[0]![0]).toBe("https://resend.com/llms.txt")
  })

  it("follows the redirect every real site has — example.com to www.example.com", async () => {
    const socket = redirectSocket("https://example.com/", "https://www.example.com/")
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: resolver({ "example.com": [PUBLIC], "www.example.com": [PUBLIC] }),
    })
    const res = await f("https://example.com/", { redirect: "follow" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("landed on https://www.example.com/")
  })

  it("follows an http-to-https upgrade and a path-only Location", async () => {
    const socket = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === "http://resend.com/") return new Response("", { status: 301, headers: { location: "https://resend.com/" } })
      if (url === "https://resend.com/") return new Response("", { status: 302, headers: { location: "/home" } })
      return new Response(`landed on ${url}`, { status: 200 })
    })
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup: resolver({ "resend.com": [PUBLIC] }) })
    const res = await f("http://resend.com/")
    expect(await res.text()).toBe("landed on https://resend.com/home")
  })

  it("carries the caller's init through — a dropped signal here is a socket nothing can cancel", async () => {
    const socket = okSocket()
    const f = publicOnlyFetch({ fetchImpl: socket as unknown as typeof fetch, lookup: resolver({ "a.com": [PUBLIC] }) })
    const ctl = new AbortController()
    await f("https://a.com/", { signal: ctl.signal, headers: { "user-agent": "open-kb" } })
    const init = socket.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBe(ctl.signal)
    expect((init.headers as Record<string, string>)["user-agent"]).toBe("open-kb")
  })

  it("puts the resolver under the caller's deadline, not outside it", async () => {
    // Resolution moved out of `fetch` and in front of it, and it had to move
    // back under the bound as it went: `AbortSignal.timeout` only ever covered
    // the fetch, so a host whose nameserver tar-pits would hold a pool worker
    // for the system resolver's own timeout — the exact tail the direct
    // branch's 8s was measured to cut.
    const socket = okSocket()
    const ctl = new AbortController()
    const f = publicOnlyFetch({
      fetchImpl: socket as unknown as typeof fetch,
      lookup: () => new Promise<string[]>(() => {}), // never answers
    })
    const pending = f("https://tarpit-dns.com/", { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    await expect(pending).rejects.toBeTruthy()
    expect(socket).not.toHaveBeenCalled()
  }, 2_000)

  it("hands back a 3xx that carries no Location, and one whose Location is unparseable, instead of inventing a hop", async () => {
    const bare = vi.fn(async () => new Response("", { status: 302 }))
    const nonsense = vi.fn(async () => new Response("", { status: 302, headers: { location: "http://" } }))
    const lookup = resolver({ "a.com": [PUBLIC] })

    expect((await publicOnlyFetch({ fetchImpl: bare as unknown as typeof fetch, lookup })("https://a.com/")).status).toBe(302)
    expect((await publicOnlyFetch({ fetchImpl: nonsense as unknown as typeof fetch, lookup })("https://a.com/")).status).toBe(302)
    expect(bare).toHaveBeenCalledTimes(1)
    expect(nonsense).toHaveBeenCalledTimes(1)
  })
})
