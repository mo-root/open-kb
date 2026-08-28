import { describe, expect, it } from "vitest"
import { isTypingTarget } from "./typingGuard"

/**
 * `isTypingTarget` had no direct test anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md itself is gone
 * from this checkout — see 48c1eaa's note on recovering section D's scope from
 * git history). Continuing the existing SELF-<n> numbering: git log
 * a7bbc57..HEAD names SELF-127 as the last used, so this is SELF-128.
 *
 * `grep -rn "isContentEditable" packages/web/components` found the same
 * three-condition check — `tagName === "INPUT" || tagName === "TEXTAREA" ||
 * isContentEditable` — hand-copied byte-for-byte in CommandPalette.tsx and
 * GraphSearch.tsx, neither exported nor pinned to the other, same shape as
 * the judge/classify vocabulary gaps (c38e8a3, 0257cd1). Pulled the check
 * into this file (no behaviour change) so both components share one
 * definition and it has one test instead of zero.
 *
 * Covers each disjunct independently — an INPUT with contentEditable false,
 * a TEXTAREA with contentEditable false, a non-input tag with
 * contentEditable true (the rich-text-editor case neither tagName check
 * catches) — plus the negative case a regression is most likely to produce:
 * a lowercase tag name, since `element.tagName` is always uppercase in the
 * DOM but a hand-built test double or a future caller could pass either.
 */

describe("isTypingTarget", () => {
  it("is true for an INPUT", () => {
    expect(isTypingTarget("INPUT", false)).toBe(true)
  })

  it("is true for a TEXTAREA", () => {
    expect(isTypingTarget("TEXTAREA", false)).toBe(true)
  })

  it("is true for any tag with isContentEditable, independent of tagName", () => {
    expect(isTypingTarget("DIV", true)).toBe(true)
    expect(isTypingTarget("SPAN", true)).toBe(true)
  })

  it("is false for an ordinary element that is not editable", () => {
    expect(isTypingTarget("BUTTON", false)).toBe(false)
    expect(isTypingTarget("DIV", false)).toBe(false)
  })

  it("does not match a lowercase tag name — DOM tagName is always uppercase", () => {
    expect(isTypingTarget("input", false)).toBe(false)
    expect(isTypingTarget("textarea", false)).toBe(false)
  })
})
