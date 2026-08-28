import { describe, expect, it } from "vitest"
import { domainOf, sortedGallery } from "./KbGallery"
import type { KbSummary } from "@/lib/viewTypes"

/**
 * KbGallery.tsx had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md itself is gone
 * from this checkout — see 48c1eaa's note on recovering section D's scope from
 * git history). Continuing the existing SELF-<n> numbering: git log
 * a7bbc57..HEAD names SELF-117 as the last used, so this is SELF-118.
 *
 * `git grep -rln "KbGallery" packages/web` before this change: only the
 * component file, DemoHome.tsx (its caller) and app/kb/page.tsx (its other
 * caller) — nothing exercised `domainOf` or the filter/sort the gallery's own
 * comment calls its reason for existing ("the grid was a plain map... and that
 * held up until the deployment had thirty-six of them"). Both were pulled out
 * pure and exported, same shape CommandPalette.tsx's `score` was (that file's
 * own test comment explains why: the component itself needs no jsdom/RTL
 * harness to import, only the logic inside it needs exercising).
 *
 * `domainOf`'s fallback chain (`manifestStr(m, "brand", "root", "input") ??
 * kb.slug`) and the "recent" sort's tie-break (a missing `builtAt` sorts last,
 * via `("" ).localeCompare(...)` losing to every real timestamp) were the two
 * places this could come back wrong silently — a manifest with no brand
 * falling through to `undefined` rather than `root`/`input`/the slug, or a
 * timestamp-less run floating to the top of "Newest" instead of sinking to the
 * bottom.
 */

function kb(overrides: Partial<KbSummary> & { slug: string }): KbSummary {
  return {
    manifest: null,
    counts: { core: 1, product: 0, player: 0, community: 0 },
    notes: 0,
    unplaced: 0,
    companies: 0,
    noise: 0,
    relations: { competitors: 0, substitutes: 0, partners: 0, voices: 0 },
    edges: 0,
    segments: [],
    ...overrides,
  }
}

describe("domainOf: what a reader searches by", () => {
  it("prefers the manifest's brand", () => {
    expect(domainOf(kb({ slug: "s", manifest: { brand: "acme.com", root: "root.com", input: "in.com" } }))).toBe(
      "acme.com",
    )
  })

  it("falls back to root, then input, when brand is absent", () => {
    expect(domainOf(kb({ slug: "s", manifest: { root: "root.com", input: "in.com" } }))).toBe("root.com")
    expect(domainOf(kb({ slug: "s", manifest: { input: "in.com" } }))).toBe("in.com")
  })

  it("falls back to the slug when the manifest has none of the three, or is absent", () => {
    expect(domainOf(kb({ slug: "acme-com-202608070005", manifest: {} }))).toBe("acme-com-202608070005")
    expect(domainOf(kb({ slug: "acme-com-202608070005", manifest: null }))).toBe("acme-com-202608070005")
  })
})

describe("sortedGallery: the filter and the three sorts", () => {
  const rows = [
    kb({ slug: "a", manifest: { brand: "cursor.com", builtAt: "2026-08-20T00:00:00.000Z" }, notes: 50, edges: 200 }),
    kb({ slug: "b", manifest: { brand: "figma.com", builtAt: "2026-08-22T00:00:00.000Z" }, notes: 900, edges: 40 }),
    // No builtAt at all — the run this tie-break exists for.
    kb({ slug: "c", manifest: { brand: "grundfos.com" }, notes: 10, edges: 900 }),
  ]

  it("passes every row through unfiltered on an empty query", () => {
    expect(sortedGallery(rows, "", "recent").map((r) => r.slug).sort()).toEqual(["a", "b", "c"])
  })

  it("filters by a substring of the domain, case-insensitively", () => {
    expect(sortedGallery(rows, "CURSOR", "recent").map((r) => r.slug)).toEqual(["a"])
  })

  it("filters by a substring of the slug too, not only the domain", () => {
    expect(sortedGallery(rows, "b", "recent").map((r) => r.slug)).toEqual(["b"])
  })

  it("matches nothing when the query names no row", () => {
    expect(sortedGallery(rows, "shopify", "recent")).toEqual([])
  })

  it("'recent' sorts newest first and sinks a run with no recorded finish time to the bottom", () => {
    expect(sortedGallery(rows, "", "recent").map((r) => r.slug)).toEqual(["b", "a", "c"])
  })

  it("'size' sorts by notes placed, most first", () => {
    expect(sortedGallery(rows, "", "size").map((r) => r.slug)).toEqual(["b", "a", "c"])
  })

  it("'linked' sorts by recorded edges, densest first", () => {
    expect(sortedGallery(rows, "", "linked").map((r) => r.slug)).toEqual(["c", "a", "b"])
  })

  it("does not mutate the array it was handed", () => {
    const before = rows.map((r) => r.slug)
    sortedGallery(rows, "", "size")
    expect(rows.map((r) => r.slug)).toEqual(before)
  })
})
