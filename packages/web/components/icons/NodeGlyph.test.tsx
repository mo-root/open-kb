import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import NodeGlyph, { GLYPH_KINDS, glyphForNotePath } from "./NodeGlyph"

/**
 * NodeGlyph.tsx had zero test coverage anywhere: neither `glyphForNotePath`
 * (the path -> glyph mapping every KB tree walk uses to pick an icon) nor the
 * `NodeGlyph` component's own size-driven branches (the <=13px stroke/dot
 * bump, and the title-vs-decorative accessibility switch) had a test pinning
 * their behavior. Coverage gap found sweeping web/components (D-scope: "areas
 * nobody has swept").
 */

describe("glyphForNotePath: the five top-level folders win over the basename", () => {
  it.each([
    ["products/apify-com.md", "product"],
    ["players/apify-com.md", "player"],
    ["communities/discord.md", "community"],
    ["signals/launch.md", "signal"],
    ["docs/sources.md", "docs"],
    ["raw/scrape.md", "docs"],
  ] as const)("%s -> %s", (path, kind) => {
    expect(glyphForNotePath(path)).toBe(kind)
  })

  it("wins even when the basename would otherwise map somewhere else (people.md is normally 'person')", () => {
    expect(glyphForNotePath("players/people.md")).toBe("player")
  })

  it("matches a folder nested more than one level deep by its top segment", () => {
    expect(glyphForNotePath("products/sub/deep.md")).toBe("product")
  })
})

describe("glyphForNotePath: case and a leading './' or '/' don't change the answer", () => {
  it("lowercases the path before matching the top folder", () => {
    expect(glyphForNotePath("PLAYERS/Apify.MD")).toBe("player")
  })

  it("strips a leading './'", () => {
    expect(glyphForNotePath("./players/apify-com.md")).toBe("player")
  })

  it("strips a leading '/'", () => {
    expect(glyphForNotePath("/players/apify-com.md")).toBe("player")
  })
})

describe("glyphForNotePath: root notes fall back to a basename lookup", () => {
  it.each([
    ["people.md", "person"],
    ["hiring.md", "hiring"],
    ["company.md", "company"],
    ["home.md", "company"],
    ["channels.md", "channels"],
    ["presence.md", "presence"],
    ["socials.md", "presence"],
    ["competitors.md", "competitor"],
    ["opportunities.md", "opportunity"],
    ["topics.md", "topic"],
    ["ecosystem.md", "topic"],
    ["docs-map.md", "docs"],
    ["sources.md", "docs"],
  ] as const)("%s -> %s", (path, kind) => {
    expect(glyphForNotePath(path)).toBe(kind)
  })

  it("reads the basename lookup even under a folder that isn't one of the five special ones", () => {
    expect(glyphForNotePath("some-other-folder/people.md")).toBe("person")
  })

  it("falls back to 'docs' for a path matching neither a top folder nor a known root note", () => {
    expect(glyphForNotePath("mystery/unknown.md")).toBe("docs")
    expect(glyphForNotePath("unknown.md")).toBe("docs")
  })
})

describe("NodeGlyph: every declared glyph kind renders without throwing", () => {
  it.each(GLYPH_KINDS)("%s", (kind) => {
    expect(() => renderToStaticMarkup(<NodeGlyph kind={kind} />)).not.toThrow()
  })
})

describe("NodeGlyph: sizes at or under 13px thicken the stroke and grow the accent dots", () => {
  it("uses stroke-width 1.9 and a 1.5x dot at size=13 (the small boundary, inclusive)", () => {
    const html = renderToStaticMarkup(<NodeGlyph kind="hiring" size={13} />)
    expect(html).toContain('stroke-width="1.9"')
    // hiring's clasp dot is `r={1 * dot}`.
    expect(html).toContain('r="1.5"')
  })

  it("uses stroke-width 1.4 and a 1x dot at size=14, one pixel past the boundary", () => {
    const html = renderToStaticMarkup(<NodeGlyph kind="hiring" size={14} />)
    expect(html).toContain('stroke-width="1.4"')
    expect(html).toContain('r="1"')
    expect(html).not.toContain('r="1.5"')
  })

  it("defaults to size=16, which is not small", () => {
    const html = renderToStaticMarkup(<NodeGlyph kind="hiring" />)
    expect(html).toContain('width="16"')
    expect(html).toContain('height="16"')
    expect(html).toContain('stroke-width="1.4"')
  })

  it("an explicit strokeWidth overrides the size-derived default even when small", () => {
    const html = renderToStaticMarkup(<NodeGlyph kind="hiring" size={13} strokeWidth={3} />)
    expect(html).toContain('stroke-width="3"')
  })
})

describe("NodeGlyph: title makes the mark accessible instead of decorative", () => {
  it("is aria-hidden with no role and no <title> when no title is given", () => {
    const html = renderToStaticMarkup(<NodeGlyph kind="docs" />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain("<title")
    expect(html).not.toContain('role="img"')
  })

  it("gets role=img and a <title> element, and drops aria-hidden, when a title is given", () => {
    const html = renderToStaticMarkup(<NodeGlyph kind="docs" title="Documentation" />)
    expect(html).toContain('role="img"')
    expect(html).toContain("<title>Documentation</title>")
    expect(html).not.toContain("aria-hidden")
  })
})
