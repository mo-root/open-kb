import { describe, expect, it } from "vitest"
import { summarise } from "./AgentPanel"

/**
 * AgentPanel.tsx had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md itself is gone
 * from this checkout — see 48c1eaa's note on recovering section D's scope from
 * git history).
 *
 * `summarise` is what a reader sees for every tool call and tool result line in
 * the panel — the full input/output is routinely a whole fetched document, and
 * this is the only place it gets cut down to one line. Get the truncation
 * boundary wrong and a line either grows past "one short line" or drops a
 * character it should have kept; get the catch branch wrong and a value
 * `JSON.stringify` cannot serialize (a circular tool result, a BigInt) throws
 * instead of rendering something. Nothing in the repo had ever imported this
 * function directly — it was module-private before this commit.
 */

describe("summarise: null and undefined render as nothing", () => {
  it("returns an empty string for null", () => {
    expect(summarise(null)).toBe("")
  })

  it("returns an empty string for undefined", () => {
    expect(summarise(undefined)).toBe("")
  })
})

describe("summarise: a string is returned verbatim under the limit", () => {
  it("passes a short string through unchanged", () => {
    expect(summarise("fetched https://example.com")).toBe("fetched https://example.com")
  })

  it("passes a string exactly at the max length through unchanged", () => {
    const s = "x".repeat(130)
    expect(summarise(s)).toBe(s)
  })

  it("truncates a string over the max length and appends an ellipsis", () => {
    const s = "x".repeat(131)
    const out = summarise(s)
    expect(out).toBe(`${"x".repeat(130)}…`)
    expect(out.length).toBe(131)
  })

  it("honours a caller-supplied max", () => {
    expect(summarise("hello world", 5)).toBe("hello…")
  })
})

describe("summarise: a non-string value is JSON-stringified first", () => {
  it("stringifies a plain object under the limit", () => {
    expect(summarise({ url: "https://example.com" })).toBe('{"url":"https://example.com"}')
  })

  it("truncates a stringified object over the limit", () => {
    const big = { text: "x".repeat(200) }
    const out = summarise(big)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBe(131)
  })

  it("stringifies an array and a number", () => {
    expect(summarise([1, 2, 3])).toBe("[1,2,3]")
    expect(summarise(42)).toBe("42")
  })
})

describe("summarise: falls back to String(v) when JSON.stringify throws", () => {
  it("does not throw on a circular object, and returns its String() form", () => {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular
    expect(() => summarise(circular)).not.toThrow()
    expect(summarise(circular)).toBe(String(circular))
  })

  it("does not throw on a BigInt, which JSON.stringify refuses to serialize", () => {
    expect(summarise(10n)).toBe("10")
  })
})
