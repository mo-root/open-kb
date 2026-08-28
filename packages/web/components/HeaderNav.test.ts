import { describe, expect, it } from "vitest"
import { ITEMS } from "./HeaderNav"

/**
 * HeaderNav.tsx had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md itself is gone
 * from this checkout — see 48c1eaa's note on recovering section D's scope from
 * git history). Continuing the existing SELF-<n> numbering: git log
 * a7bbc57..HEAD names SELF-122 as the last used, so this is SELF-123.
 *
 * `git grep -rln "HeaderNav" packages/web` before this change found only the
 * component file and layout.tsx (its one caller) — nothing exercised the
 * per-item `active(p)` predicate that decides which nav item lights up, even
 * though it is the only logic in the file. No jsdom/RTL harness here (same
 * constraint KbGallery.tsx's and CommandPalette.tsx's own tests note), so
 * `ITEMS` was exported unchanged rather than rendering the component.
 *
 * The three predicates are not uniform: "/" uses exact equality (`p === "/"`)
 * so it does not also light up for every other route, while "/kb" and "/runs"
 * use `startsWith` so a nested page (`/kb/<id>`, `/runs/<id>`) still marks its
 * parent active. That asymmetry is the one thing worth pinning — an exact
 * match on "/" would be silently wrong for nothing else since there is only
 * one root route, but flipping either `startsWith` to `===` would break every
 * detail page's nav highlight without a single caller-visible error.
 */

function itemFor(href: string) {
  const item = ITEMS.find((i) => i.href === href)
  if (!item) throw new Error(`no ITEMS entry for ${href}`)
  return item
}

describe("HeaderNav ITEMS: the / item matches only the exact root", () => {
  const { active } = itemFor("/")

  it("is active for the root path", () => {
    expect(active("/")).toBe(true)
  })

  it("is inactive for every other route, including nested ones", () => {
    expect(active("/kb")).toBe(false)
    expect(active("/kb/acme-co")).toBe(false)
    expect(active("/runs")).toBe(false)
    expect(active("/runs/run-1")).toBe(false)
  })
})

describe("HeaderNav ITEMS: the /kb item matches its whole subtree", () => {
  const { active } = itemFor("/kb")

  it("is active on the index and on nested knowledge-base pages", () => {
    expect(active("/kb")).toBe(true)
    expect(active("/kb/acme-co")).toBe(true)
    expect(active("/kb/acme-co/notes")).toBe(true)
  })

  it("is inactive off its own subtree", () => {
    expect(active("/")).toBe(false)
    expect(active("/runs")).toBe(false)
    expect(active("/runs/run-1")).toBe(false)
  })
})

describe("HeaderNav ITEMS: the /runs item matches its whole subtree", () => {
  const { active } = itemFor("/runs")

  it("is active on the index and on nested run pages", () => {
    expect(active("/runs")).toBe(true)
    expect(active("/runs/run-1")).toBe(true)
  })

  it("is inactive off its own subtree", () => {
    expect(active("/")).toBe(false)
    expect(active("/kb")).toBe(false)
    expect(active("/kb/acme-co")).toBe(false)
  })
})

describe("HeaderNav ITEMS: exactly one item is active for every real route", () => {
  const realRoutes = ["/", "/kb", "/kb/acme-co", "/runs", "/runs/run-1"]

  it.each(realRoutes)("%s lights exactly one nav item", (path) => {
    const activeCount = ITEMS.filter((item) => item.active(path)).length
    expect(activeCount).toBe(1)
  })
})
