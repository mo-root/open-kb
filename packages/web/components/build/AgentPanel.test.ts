import { describe, expect, it } from "vitest"
import { buildEntries, summarise } from "./AgentPanel"

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
 *
 * `buildEntries` (module-private as `entries`'s `useMemo` body until this
 * commit, same move as `summarise`) is the rest of the file's untested surface:
 * `grep -rln "AgentPanel" packages/web --include=*.test.*` found only this file,
 * and it named nothing but `summarise`. The tool-call/tool-result branches carry
 * their own "Kept, deliberately" comment saying today's `generateObject` engine
 * never feeds them — true, and also why a regression there would ship silently:
 * nothing runs them, so nothing would notice one of the two chunk-type spellings
 * (`tool-input-available` vs `tool-call`, an SDK version difference this file
 * accepts either of) stop matching, or `toolName`/`input`/`output` being read
 * off the wrong field. The text-merge rule (THE SWARM CORRECTION) and the
 * `UNKNOWN` agent fallback were equally untested — a concurrency bug in exactly
 * the shape that comment describes fixing once already.
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

describe("buildEntries: text deltas merge only into the same agent's own last entry", () => {
  it("merges consecutive text-delta chunks from one agent into a single entry", () => {
    const out = buildEntries([
      { type: "text-delta", delta: "Hello, ", agent: "discover" },
      { type: "text-delta", delta: "world.", agent: "discover" },
    ])
    expect(out).toEqual([{ id: 0, kind: "text", body: "Hello, world.", agent: "discover" }])
  })

  it("does not merge across a different agent's frame in between", () => {
    const out = buildEntries([
      { type: "text-delta", delta: "one", agent: "discover" },
      { type: "text-delta", delta: "two", agent: "rank" },
      { type: "text-delta", delta: "three", agent: "discover" },
    ])
    expect(out.map((e) => ({ body: e.body, agent: e.agent }))).toEqual([
      { body: "one", agent: "discover" },
      { body: "two", agent: "rank" },
      { body: "three", agent: "discover" },
    ])
  })

  it("drops a text chunk with no delta and no text instead of pushing an empty entry", () => {
    expect(buildEntries([{ type: "text-delta", agent: "discover" }])).toEqual([])
  })

  it("falls back to the UNKNOWN agent when a chunk carries no agent field", () => {
    const out = buildEntries([{ type: "text", text: "hi" }])
    expect(out[0].agent).toBe("run")
  })
})

describe("buildEntries: tool-call chunks become a tool entry", () => {
  it("reads either SDK spelling of a tool call the same way", () => {
    const byNewName = buildEntries([
      { type: "tool-input-available", toolName: "fetch", input: { url: "https://example.com" }, agent: "discover" },
    ])
    const byOldName = buildEntries([
      { type: "tool-call", toolName: "fetch", input: { url: "https://example.com" }, agent: "discover" },
    ])
    const want = [
      {
        id: 0,
        kind: "tool",
        tool: "fetch",
        body: '{"url":"https://example.com"}',
        agent: "discover",
      },
    ]
    expect(byNewName).toEqual(want)
    expect(byOldName).toEqual(want)
  })

  it("names the tool 'tool' when toolName is absent", () => {
    const out = buildEntries([{ type: "tool-call", input: "x", agent: "discover" }])
    expect(out[0].tool).toBe("tool")
  })
})

describe("buildEntries: tool-result chunks become a result entry", () => {
  it("reads either SDK spelling of a tool result the same way", () => {
    const byNewName = buildEntries([
      { type: "tool-output-available", toolName: "fetch", output: { ok: true }, agent: "discover" },
    ])
    const byOldName = buildEntries([
      { type: "tool-result", toolName: "fetch", output: { ok: true }, agent: "discover" },
    ])
    const want = [{ id: 0, kind: "result", tool: "fetch", body: '{"ok":true}', agent: "discover" }]
    expect(byNewName).toEqual(want)
    expect(byOldName).toEqual(want)
  })
})

describe("buildEntries: everything else is protocol noise, dropped", () => {
  it("ignores a chunk type it does not recognise", () => {
    expect(buildEntries([{ type: "start-step", agent: "discover" }])).toEqual([])
  })

  it("ignores a chunk with no type at all", () => {
    expect(buildEntries([{ agent: "discover" }])).toEqual([])
  })
})
