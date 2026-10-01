import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
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

  it("drops an explicit port rather than carrying it into the display host", () => {
    // `.host` (the earlier implementation) keeps `:8080` here; `.hostname`
    // does not. This feeds `SiteIcon`'s `domain` prop (line 325), which
    // documents itself as "Bare domain" and builds a favicon URL from it
    // verbatim — a port would both mislabel the source and break the icon.
    expect(hostOf("https://example.com:8080/path")).toBe("example.com")
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

describe("the import of receiptSource stays off the package root", () => {
  // Real regression, not a hypothetical: this file ("use client") imported
  // `receiptSource` from bare `@open-kb/core`, whose barrel (`core/src/
  // index.ts`) `export *`s `prompts.ts` — a module that touches `node:fs`/
  // `node:path` at module scope. Webpack has to resolve every module an
  // `export *` names before it can tree-shake any of them away, so the
  // client bundle pulled in `node:fs` and `next build --webpack` refused to
  // read it: `UnhandledSchemeError: Reading from "node:fs" is not handled by
  // plugins`, on a clean clone, before this fix. `pnpm check`/`pnpm test`
  // never ran `next build`, so this sat broken with every other check green.
  // `@open-kb/core/export-kb` is the fix: `export-kb.ts` and everything it
  // imports (`url.ts`, `judge.ts` and that closure) touch no Node builtin.
  it("imports from the ./export-kb subpath, not the bare package", () => {
    const src = readFileSync(fileURLToPath(new URL("./NoteView.tsx", import.meta.url)), "utf8")
    expect(src).toContain('from "@open-kb/core/export-kb"')
    expect(src).not.toMatch(/from "@open-kb\/core"/)
  })
})
