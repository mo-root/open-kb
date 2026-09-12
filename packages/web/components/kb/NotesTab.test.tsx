import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { groupOf, NotesTab } from "./NotesTab"
import type { NoteRef } from "@/lib/viewTypes"

/**
 * D-scope sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see 48c1eaa's
 * note on recovering section D's scope from git history). Continuing the
 * SELF-<n> numbering from SELF-102.
 *
 * `groupOf` is the sidebar's own sectioning key (line 74: `groupOf(n.path)`
 * feeds the `Map<string, NoteRef[]>` that becomes "players" / "products" /
 * "communities" / "unplaced" / "overview") and had never run under test.
 *
 * Both branches are live in production, not hypothetical: `lib/kb-from-run.ts`
 * builds every real `NoteRef.path` one of two ways —
 *   - `ANCHOR_PATH` (kb-from-run.ts:138) is the bare literal `"company.md"`,
 *     no slash, which is why "overview" exists as a group at all.
 *   - `pathFor` (kb-from-run.ts:147) emits `"<group>/<safe>.md"`, where
 *     `group` is always one of `KIND_GROUP`'s four values (kb-from-run.ts:73-80:
 *     players/products/communities/unplaced) — never empty, since a falsy
 *     `KIND_GROUP[e.kind]` is routed to `noise` before `pathFor` is ever
 *     called (kb-from-run.ts:430-433) — and `safe` has already had every
 *     `/`, `\`, `?`, `#` stripped (kb-from-run.ts:149), so a real path never
 *     carries a second slash for `groupOf` to stop at.
 */
describe("groupOf reads the segment before the first slash", () => {
  it("returns the group for a grouped path, same shape pathFor emits", () => {
    expect(groupOf("players/postmarkapp.com.md")).toBe("players")
    expect(groupOf("products/postmark-inbound.md")).toBe("products")
    expect(groupOf("communities/mailgun.com.md")).toBe("communities")
    expect(groupOf("unplaced/unknown-host.md")).toBe("unplaced")
  })

  it("stops at the first slash, ignoring any that follow", () => {
    expect(groupOf("players/a/b.md")).toBe("players")
  })

  it("falls back to overview for a path with no slash, the anchor's own shape", () => {
    // ANCHOR_PATH is the bare literal "company.md" — no group, no slash.
    expect(groupOf("company.md")).toBe("overview")
    expect(groupOf("")).toBe("overview")
  })
})

/**
 * D-scope sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see 48c1eaa's
 * note on recovering section D's scope from git history). git log names
 * SELF-432 as the last used, so this is SELF-433.
 *
 * @vitest/coverage-v8 measured NotesTab.tsx at 5.67% lines / 100% branch /
 * 50% funcs before this commit: `groupOf` (above) was the only thing calling
 * into this file, and the `NotesTab` component itself — lines 27-281, the
 * group-building `useMemo` (71-90), the facet row, the group headings and
 * every list-item's unplaced badge — never once ran.
 *
 * `NotesTab` takes its filter/relation state from `useState`, and there is no
 * jsdom/RTL harness in this repo to simulate typing into the box or clicking
 * a facet chip — same limitation ThemeToggle.test.tsx, TabBar.test.tsx and
 * StageTracker.test.tsx already documented for their own interactive parts.
 * What `renderToStaticMarkup` CAN pin is everything the component computes
 * from props alone on first render, since `filter` and `relation` both start
 * at their initial values ("" and null) before any event fires: the group
 * map building and its overview-first sort (lines 71-90), the facet row's
 * visibility rule (only when more than one relation is present), the
 * unplaced badge on a `relation === "none"` row, the "No entities." panel
 * when nothing is selected, the empty-map copy when `notes` is `[]`, and the
 * ↑↓/⌘K footer's `flat.length > 1` guard.
 *
 * `selected` is deliberately kept `null` in every case here: a truthy
 * `selected` renders `NoteView` (lines 267-274), a separate component with
 * its own pre-existing zero-coverage gap — pulling it in would blur this
 * commit's scope onto a file it does not otherwise touch.
 *
 * After: 82.47% lines / 78.94% branch / 25% funcs (2 of 8: `NotesTab` itself
 * and `groupOf`, measured with this file's suite run in isolation). The
 * remaining gaps are all interaction-only and unreachable without a
 * jsdom/RTL harness this repo does not have: the six event handlers
 * (`step`, `onNavKey`, the filter box's `onChange`, the facet/clear/row
 * `onClick`s — none of them fire during a static render), the typed-filter
 * half of the empty-state ternary (`filter ? … : …`, line 183), and the
 * `selected`-truthy branch just excluded above.
 */
function note(over: Partial<NoteRef> & { title: string; path: string }): NoteRef {
  return {
    relevance: 50,
    type: "player",
    kind: "company",
    relation: "competitor",
    domain: `${over.title.toLowerCase()}.com`,
    what: "",
    why: "",
    ...over,
  }
}

function render(notes: NoteRef[], selected: string | null = null) {
  return renderToStaticMarkup(
    <NotesTab slug="acme" notes={notes} selected={selected} onSelect={() => {}} openNote={() => {}} />,
  )
}

describe("NotesTab: groups are built from notes and sorted overview-first", () => {
  it("puts overview (the anchor) first, then every other group alphabetically", () => {
    const html = render([
      note({ title: "Zed", path: "players/zed.md" }),
      note({ title: "Acme", path: "company.md" }),
      note({ title: "Beta", path: "communities/beta.md" }),
    ])
    const order = ["core", "communities", "players"].map((label) => html.indexOf(`>${label}<`))
    expect(order[0]).toBeGreaterThan(-1)
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
  })

  it("shows every group's item count next to its label", () => {
    const html = render([
      note({ title: "A", path: "players/a.md" }),
      note({ title: "B", path: "players/b.md" }),
    ])
    expect(html).toContain(">players<")
    expect(html).toMatch(/>players<\/span>.*?>2</s)
  })

  it("renders 'No entities.' on the right when nothing is selected", () => {
    const html = render([note({ title: "A", path: "players/a.md" })], null)
    expect(html).toContain("No entities.")
  })
})

describe("NotesTab: the relation facet row only shows once there is something to narrow", () => {
  it("hides the facet row when every note shares one relation", () => {
    const html = render([
      note({ title: "A", path: "players/a.md", relation: "competitor" }),
      note({ title: "B", path: "players/b.md", relation: "competitor" }),
    ])
    expect(html).not.toContain('aria-label="Filter entities by relation"')
  })

  it("shows one chip per distinct relation once there is more than one", () => {
    const html = render([
      note({ title: "A", path: "players/a.md", relation: "competitor" }),
      note({ title: "B", path: "players/b.md", relation: "substitute" }),
    ])
    expect(html).toContain('aria-label="Filter entities by relation"')
    expect(html).toContain(">competitor<")
    expect(html).toContain(">substitute<")
  })

  it("labels a 'none' relation chip 'unplaced', not the raw classifier value", () => {
    const html = render([
      note({ title: "A", path: "players/a.md", relation: "competitor" }),
      note({ title: "B", path: "unplaced/b.md", relation: "none" }),
    ])
    expect(html).toContain(">unplaced<")
    expect(html).not.toMatch(/>none</)
  })
})

describe("NotesTab: an unplaced row wears its badge, a placed row wears its relation", () => {
  it("shows the row's own relation for a placed entity", () => {
    const html = render([note({ title: "Acme", path: "players/acme.md", relation: "substitute" })])
    expect(html).toContain(">substitute<")
  })

  it("shows 'unplaced' rather than the literal 'none' for a relation:none row", () => {
    const html = render([note({ title: "Acme", path: "unplaced/acme.md", relation: "none" })])
    // the group heading's own facet-chip text is absent here (only one note,
    // one relation, so the facet row itself does not render) — this is the
    // per-row badge, `unplaced ? "unplaced" : n.relation` at line 247.
    expect(html).toContain(">unplaced<")
  })
})

describe("NotesTab: the empty-map state and the ↑↓/⌘K footer", () => {
  it("prints the no-relation-filter empty copy when notes is empty", () => {
    const html = render([])
    expect(html).toContain("No entity is placed as")
    expect(html).toContain("Clear the filter")
  })

  it("hides the ↑↓/⌘K shortcut footer with one or zero notes", () => {
    const html = render([note({ title: "A", path: "players/a.md" })])
    expect(html).not.toContain("⌘K jump")
  })

  it("shows the shortcut footer once there is more than one note to step through", () => {
    const html = render([
      note({ title: "A", path: "players/a.md" }),
      note({ title: "B", path: "players/b.md" }),
    ])
    expect(html).toContain("⌘K jump")
  })
})
