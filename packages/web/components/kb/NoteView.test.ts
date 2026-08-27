import { describe, expect, it } from "vitest"
import { hostOf } from "./NoteView"

/**
 * D-scope sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see 48c1eaa's
 * note on recovering section D's scope from git history).
 *
 * `hostOf` is the only piece of NoteView.tsx with a branch nothing exercises:
 * it renders every source's icon and label (`sources.map(...)`, lines
 * 325-326), and its `catch` fallback — return the raw string, untouched — had
 * never run under test. Checked `packages/web/lib/kb-from-run.ts:710,728`:
 * today every `sources[].url` this app ever builds is `https://${domain}`, so
 * the fallback is currently unreachable in production, but the function stays
 * defensive (a bare `string`, not a branded/validated URL type) and is the
 * one thing standing between a future malformed `url` and a crash rendering
 * the sources list.
 */
describe("hostOf strips a leading www. from a valid URL's host", () => {
  it("returns the bare host for a URL with no www.", () => {
    expect(hostOf("https://example.com")).toBe("example.com")
  })

  it("strips exactly one leading www.", () => {
    expect(hostOf("https://www.example.com")).toBe("example.com")
    expect(hostOf("https://www.www.example.com")).toBe("www.example.com")
  })

  it("lowercases the host, the URL parser's own normalization", () => {
    expect(hostOf("https://EXAMPLE.com")).toBe("example.com")
  })
})

describe("hostOf falls back to the raw input when it is not a parseable URL", () => {
  it("returns a schemeless domain unchanged rather than throwing", () => {
    // `new URL("example.com")` throws (no protocol) — this is the fallback,
    // not a lucky match: unlike the valid-URL path above, casing survives.
    expect(hostOf("EXAMPLE.com")).toBe("EXAMPLE.com")
  })

  it("returns the empty string unchanged", () => {
    expect(hostOf("")).toBe("")
  })

  it("returns free text unchanged, not a thrown error", () => {
    expect(hostOf("not a url")).toBe("not a url")
  })
})
