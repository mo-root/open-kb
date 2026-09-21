import { describe, expect, it } from "vitest"
import { isAbortError } from "../src/agent.js"

/**
 * `isAbortError` had no direct test anywhere — every existing abort test in
 * agent.test.ts/orchestrator.test.ts exercises it only end to end, through a
 * real turn or mission that happens to abort. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED). Continuing the existing SELF-<n>
 * numbering.
 *
 * `grep -rn "const isAbortError"` found the exact same three-line predicate
 * — `err?.name === "AbortError" || /abort/i.test(String(err?.message ?? ""))`
 * — hand-copied byte-for-byte in agent.ts and orchestrator.ts, neither
 * exported nor pinned to the other, the same shape SELF-128 already fixed
 * once for isTypingTarget (CommandPalette.tsx/GraphSearch.tsx). Exported
 * agent.ts's copy and had orchestrator.ts import it instead of carrying its
 * own (no behaviour change) — so a widened check landing in one caller
 * cannot silently stay narrower in the other, where it decides whether a
 * failed turn is charged to the wall/caller or counted as a real fault.
 *
 * Covers each disjunct independently — name-only, message-only, both, and
 * the negative case — plus the two non-object shapes `err?.name` has to
 * survive without throwing: a plain string and undefined, since `e: unknown`
 * means callers are not guaranteed an Error instance.
 */
describe("isAbortError", () => {
  it("is true when the error's name is AbortError, whatever the message", () => {
    expect(isAbortError({ name: "AbortError", message: "The operation was terminated" })).toBe(true)
    expect(isAbortError(new DOMException("nope", "AbortError"))).toBe(true)
  })

  it("is true when the message mentions abort, case-insensitively, even under a different name", () => {
    expect(isAbortError({ name: "TimeoutError", message: "the wall aborted this call" })).toBe(true)
    expect(isAbortError({ name: "Error", message: "ABORTED by the caller" })).toBe(true)
  })

  it("is false for a real failure that is neither named nor described as an abort", () => {
    expect(isAbortError(new Error("connection reset"))).toBe(false)
    expect(isAbortError({ name: "TypeError", message: "cannot read property of undefined" })).toBe(false)
  })

  it("does not throw on a non-object thrown value, and reads false", () => {
    expect(isAbortError("some string")).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
