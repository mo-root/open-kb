import { describe, it, expect } from "vitest"
import { runFixture, HOSTS, type Harness, type LinkPair } from "./fixture.js"

/**
 * A SEARCH PROVIDER'S ROW IS NOT A URL UNTIL `new URL()` SAYS SO.
 *
 * `SearchHit.url` (core/src/ports.ts) is typed `string`, not a branded or
 * validated URL, and `FakeSearch` (and, on the wire, Bright Data) hands it
 * through untouched. Two separate places in `sweep()` re-derive a hostname
 * from that string and both guard the parse with `try { ... } catch { continue }`:
 * `byHost`'s fold (~sweep.ts:5139-5142, feeding the judge) and `coPairs`'
 * co-occurrence loop (~sweep.ts:6243-6248, feeding the free link pass) — the
 * SAME defence written twice because the two loops read `hits` independently
 * and a row that fails to parse in one still has to be skipped in the other.
 *
 * A scoped v8 coverage pass (`@vitest/coverage-v8@3.2.7`, installed, run,
 * reverted — the technique SELF-465 and SELF-473 used) named both `continue`
 * statements 0-hit across the full suite: nothing anywhere feeds either loop
 * a hit whose `url` fails `new URL()`. Every existing malformed-URL test
 * (`url.test.ts`'s `ipv4Value`/`ipv6Groups`, `alias.ts`'s href guards) covers
 * a URL string once it is already inside a page's markup — none put one on
 * the wire as a SEARCH RESULT, which is the one shape that reaches these two
 * lines before anything else has looked at it.
 *
 * The market: the same grepstack/tailwatch pair `the-pair-cap...` and
 * `a-folded-subdomain...` already use, corroborated across two queries so it
 * clears the co-occurrence floor, plus one garbage row on the first query
 * that no `new URL()` in the world accepts.
 */

const hit = (host: string, title: string, description: string) => ({
  url: `https://${host}/`,
  title,
  description,
})

/** No scheme, no authority — `new URL()` throws `TypeError: Invalid URL` on
 *  this in every Node version the engine supports. */
const GARBAGE_HIT = { url: "not a url", title: "Garbage", description: "" }

const serp = {
  "log search": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search for platform teams."),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
    GARBAGE_HIT,
  ],
  "log search alternatives": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search for platform teams."),
    hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks from nine regions."),
  ],
}

const isPair = (p: LinkPair, a: string, b: string) =>
  (p.a === a && p.b === b) || (p.a === b && p.b === a)

describe("a search hit whose url does not parse", () => {
  it("is dropped from the host fold and the run does not throw", async () => {
    const h: Harness = await runFixture({
      serp,
      script: { link: () => ({ edges: [] }) },
    })
    // 5 hits went to the port (3 + 2); the garbage row parses to no host, so
    // the fold sees only the 2 real ones. If either `catch` block above lost
    // its guard, this line is where the run would have thrown instead of
    // narrating a count.
    expect(
      h.says.some((s) => /^5 results, 2 distinct hosts/.test(s)),
      "the garbage row either crashed the fold or was miscounted as a host",
    ).toBe(true)
  }, 30_000)

  it("does not stop the co-occurrence pass from pairing the hosts that DID parse", async () => {
    const seen: LinkPair[] = []
    const h = await runFixture({
      serp,
      script: { link: (pairs) => (seen.push(...pairs), { edges: [] }) },
    })
    expect(h.calls.some((c) => c.phase === "link")).toBe(true)
    expect(
      seen.some((p) => isPair(p, HOSTS.grepstack, HOSTS.tailwatch)),
      "a garbage row ahead of it in the same query's hits should not have kept the real pair from being selected",
    ).toBe(true)
  }, 30_000)
})
