import { describe, expect, it } from "vitest"
import {
  MAX_SCOPED_WORDS,
  PLATFORMS,
  PLATFORM_SITES,
  scopeToPlatform,
} from "../src/sweep.js"

/**
 * `platform` was a seven-value enum the catalog agent filled in on every query
 * and nothing ever rendered: of the 1,999 query records in `runs/`, 1,522 carry
 * the hardcoded `"web"` the templates stamp, and not one of the other 477
 * changed the query that was bought. These are the tests that make it
 * load-bearing — and the ones that keep it from scoping a run to the very
 * company it is mapping.
 */

describe("scopeToPlatform", () => {
  it("leaves a web query exactly as written", () => {
    expect(scopeToPlatform("log search alternatives", "web")).toEqual({
      q: "log search alternatives",
      scoped: false,
      tooLong: false,
      anchorOwned: false,
    })
  })

  it("renders the site: prefix for a platform query", () => {
    expect(scopeToPlatform("log retention cost", "reddit").q).toBe(
      "site:reddit.com log retention cost",
    )
  })

  it("uses the host a search engine indexes, not the platform's nickname", () => {
    // `site:hackernews` matches nothing at all — a warning the catalog prompt
    // carried in prose for months while no code rendered either one.
    expect(scopeToPlatform("log search", "hackernews").q).toBe(
      "site:news.ycombinator.com log search",
    )
  })

  it("fires a sentence unscoped rather than truncating it, and says which it did", () => {
    const long = "how do i find one request across a hundred containers"
    expect(scopeToPlatform(long, "reddit")).toEqual({
      q: long,
      scoped: false,
      tooLong: true,
      anchorOwned: false,
    })
  })

  it("scopes a query of exactly the length that still fits", () => {
    const body = Array.from({ length: MAX_SCOPED_WORDS - 1 }, (_, i) => `w${i}`).join(" ")
    expect(scopeToPlatform(body, "reddit").scoped).toBe(true)
    expect(scopeToPlatform(`${body} more`, "reddit").scoped).toBe(false)
  })

  it("leaves a query that already scopes itself alone", () => {
    const q = "site:news.ycombinator.com log search"
    expect(scopeToPlatform(q, "reddit")).toEqual({
      q,
      scoped: false,
      tooLong: false,
      anchorOwned: false,
    })
  })

  it("is idempotent — a rendered query re-rendered is the same query", () => {
    const once = scopeToPlatform("log retention cost", "reddit").q
    expect(scopeToPlatform(once, "reddit").q).toBe(once)
  })

  it("ignores a platform it has no host for, rather than inventing one", () => {
    expect(scopeToPlatform("log search", "myspace").scoped).toBe(false)
    expect(scopeToPlatform("log search", "").scoped).toBe(false)
  })

  it("never scopes a query to the anchor's own site", () => {
    // The real case: `runs/sweep-github-com-*.json` tagged nine debranded
    // queries `platform: "github"`. Rendered blind, four of them go out as
    // `site:github.com …` — a non-branded query naming the anchor and bounded
    // to its own pages.
    const r = scopeToPlatform("git leak prevention tool free", "github", "github.com")
    expect(r.q).toBe("git leak prevention tool free")
    expect(r.scoped).toBe(false)
    expect(r.anchorOwned).toBe(true)
    // Not the length rule wearing another name — that would send the next
    // reader to the prompt to fix something that is not broken.
    expect(r.tooLong).toBe(false)
  })

  it("refuses on the registrable host, so www and a subdomain are the same anchor", () => {
    for (const anchor of ["github.com", "www.github.com", "GitHub.com", "gist.github.com"])
      expect(scopeToPlatform("secret scanning tool", "github", anchor).anchorOwned).toBe(true)
    // hackernews is the one whose host is not its own registrable name.
    expect(scopeToPlatform("show hn launch", "hackernews", "ycombinator.com").anchorOwned).toBe(true)
  })

  it("still scopes every OTHER platform for that same anchor", () => {
    // The guard is about one host, not a reason to stop scoping the run.
    expect(scopeToPlatform("secret scanning tool", "reddit", "github.com").q).toBe(
      "site:reddit.com secret scanning tool",
    )
    expect(scopeToPlatform("secret scanning tool", "github", "gitlab.com").q).toBe(
      "site:github.com secret scanning tool",
    )
  })

  it("is unchanged for every anchor that is not one of the seven", () => {
    for (const p of PLATFORMS)
      expect(scopeToPlatform("log retention cost", p, "shopify.com")).toEqual(
        scopeToPlatform("log retention cost", p),
      )
  })

  it("has a host for every platform the schema lets the model choose", () => {
    for (const p of PLATFORMS) expect(PLATFORM_SITES).toHaveProperty(p)
    // `web` is the absence of a scope, and the only one allowed to be empty.
    for (const p of PLATFORMS)
      expect(PLATFORM_SITES[p] === "").toBe(p === "web")
    for (const [p, host] of Object.entries(PLATFORM_SITES))
      if (host) expect(scopeToPlatform("log search", p).q).toBe(`site:${host} log search`)
  })
})
