import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SkipLink } from "./SkipLink"

/**
 * SkipLink.tsx had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md is gone from
 * this checkout — untracked by 481fa6d; scope recovered via
 * `git show 481fa6d^:docs/overnight-backlog.md`, the same recovery prior
 * SELF-<n> commits used). git log a7bbc57..HEAD names SELF-180 as the last
 * used, so this is SELF-181.
 *
 * The component's own header comment states two claims neither tsc nor any
 * existing test enforces: the link is "invisible until focused" (the
 * `sr-only` / `focus:not-sr-only` pair) and "first in the tab order" ahead of
 * the header's logo link and `HeaderNav`. Its whole purpose depends on a third
 * thing the comment doesn't even need to state because it looks obviously
 * true: `href="#main"` has to name a real id. `layout.tsx` is the only
 * caller and the only place `id="main"` is declared — nothing cross-checks
 * the two literals, so renaming either one silently turns the skip link into
 * a dead anchor for exactly the keyboard user it exists to serve, with no
 * compile error and no visual sign on a mouse-driven review.
 */

const LAYOUT = readFileSync(
  fileURLToPath(new URL("../app/layout.tsx", import.meta.url)),
  "utf8",
)

function renderedHref(): string {
  const html = renderToStaticMarkup(<SkipLink />)
  const m = /<a[^>]*\shref="([^"]+)"/.exec(html)
  if (!m) throw new Error("SkipLink did not render an <a href> at all")
  return m[1]
}

describe("SkipLink: renders the escape hatch its own comment promises", () => {
  it("is a single anchor with the visible label", () => {
    const html = renderToStaticMarkup(<SkipLink />)
    expect(html).toMatch(/^<a\b/)
    expect(html).toContain("Skip to content")
  })

  it("is invisible until focused: sr-only, and focus:not-sr-only to reverse it", () => {
    const html = renderToStaticMarkup(<SkipLink />)
    expect(html).toMatch(/class="[^"]*\bsr-only\b[^"]*"/)
    expect(html).toContain("focus:not-sr-only")
  })

  it("targets #main, not some other fragment", () => {
    expect(renderedHref()).toBe("#main")
  })
})

describe("SkipLink's #main target actually exists in layout.tsx", () => {
  it("layout.tsx declares exactly one id=\"main\", and it's on <main>", () => {
    const mainIds = [...LAYOUT.matchAll(/\sid="main"/g)]
    expect(mainIds).toHaveLength(1)
    expect(LAYOUT).toMatch(/<main\s+[^>]*id="main"/)
  })

  it("SkipLink's rendered href names that same id", () => {
    const idMatch = /<main\s+[^>]*id="([^"]+)"/.exec(LAYOUT)
    if (!idMatch) throw new Error("no <main id=\"...\"> found in layout.tsx")
    expect(renderedHref()).toBe(`#${idMatch[1]}`)
  })
})

describe("SkipLink renders before every other focusable element in layout.tsx", () => {
  it("comes before the header's logo link, HeaderNav and <main> in source order", () => {
    const skipLinkAt = LAYOUT.indexOf("<SkipLink")
    const logoLinkAt = LAYOUT.indexOf('<Link\n')
    const headerNavAt = LAYOUT.indexOf("<HeaderNav")
    const mainAt = LAYOUT.indexOf("<main ")

    expect(skipLinkAt).toBeGreaterThan(-1)
    expect(logoLinkAt).toBeGreaterThan(-1)
    expect(headerNavAt).toBeGreaterThan(-1)
    expect(mainAt).toBeGreaterThan(-1)

    expect(skipLinkAt).toBeLessThan(logoLinkAt)
    expect(skipLinkAt).toBeLessThan(headerNavAt)
    expect(skipLinkAt).toBeLessThan(mainAt)
  })
})
