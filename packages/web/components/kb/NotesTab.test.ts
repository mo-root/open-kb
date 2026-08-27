import { describe, expect, it } from "vitest"
import { groupOf } from "./NotesTab"

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
