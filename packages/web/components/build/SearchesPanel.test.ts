import { describe, expect, it } from "vitest"
import { readSearched } from "./SearchesPanel"

/**
 * SearchesPanel.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history).
 *
 * `readSearched` is the boundary that turns one untrusted frame off the results
 * stream (BuildWorkflow.tsx:381, `readSearched(v)` on whatever `JSON.parse`
 * produced from the wire) into a `SearchView` the panel trusts enough to render
 * without a null check on every field. Nothing in the repo had ever exercised
 * its "wrong shape" branch, its hits-filtering `flatMap`, or the three fields
 * (`ok`, `family`, `usd`) whose "present but wrong type" case is not the same
 * as "absent" — the same class of gap `readSearched`'s own comment says this
 * file avoids ("an unrecognised frame is dropped, never rendered as an empty
 * search that looks like a failed one").
 */

/** Asserts a frame is accepted and returns the view, narrowing away the `null`
 *  every other case in this file returns — kept separate from the reject tests
 *  below, which check that `null` directly. */
function accepted(v: unknown) {
  const view = readSearched(v)
  expect(view).not.toBeNull()
  return view!
}

describe("readSearched: rejects anything that is not a searched frame", () => {
  it("rejects non-objects", () => {
    expect(readSearched(null)).toBeNull()
    expect(readSearched(undefined)).toBeNull()
    expect(readSearched("searched")).toBeNull()
    expect(readSearched(42)).toBeNull()
    expect(readSearched([])).toBeNull()
  })

  it("rejects an object with the wrong kind", () => {
    expect(readSearched({ kind: "classified", query: "x" })).toBeNull()
    expect(readSearched({ query: "x" })).toBeNull()
  })

  it("rejects a searched frame whose query is not a string", () => {
    expect(readSearched({ kind: "searched", query: 7 })).toBeNull()
    expect(readSearched({ kind: "searched" })).toBeNull()
  })
})

describe("readSearched: fields default rather than propagate undefined", () => {
  it("fills every optional field's default on the minimal valid frame", () => {
    expect(accepted({ kind: "searched", query: "vector database" })).toEqual({
      query: "vector database",
      intent: "",
      platform: "",
      why: "",
      family: undefined,
      ok: true,
      error: undefined,
      ms: 0,
      usd: 0,
      hits: [],
    })
  })

  it("only 'ok: false' turns a search into a failed one — any other value stays true", () => {
    expect(accepted({ kind: "searched", query: "q", ok: false }).ok).toBe(false)
    expect(accepted({ kind: "searched", query: "q", ok: true }).ok).toBe(true)
    expect(accepted({ kind: "searched", query: "q" }).ok).toBe(true)
    // A run recorded before `ok` existed, or a truthy-but-not-boolean value,
    // must not silently read as failed.
    expect(accepted({ kind: "searched", query: "q", ok: "false" }).ok).toBe(true)
    expect(accepted({ kind: "searched", query: "q", ok: 0 }).ok).toBe(true)
  })

  it("keeps error only when it is a string", () => {
    expect(accepted({ kind: "searched", query: "q", error: "timed out" }).error).toBe(
      "timed out",
    )
    expect(accepted({ kind: "searched", query: "q", error: 500 }).error).toBeUndefined()
  })
})

describe("readSearched: family is optional and empty-string is treated as absent", () => {
  it("keeps a non-empty string family", () => {
    expect(accepted({ kind: "searched", query: "q", family: "branded" }).family).toBe("branded")
  })

  it("a run recorded before families existed carries no frame with one — not a malformed run", () => {
    expect(accepted({ kind: "searched", query: "q" }).family).toBeUndefined()
  })

  it("treats an empty string and a non-string family the same as absent", () => {
    expect(accepted({ kind: "searched", query: "q", family: "" }).family).toBeUndefined()
    expect(accepted({ kind: "searched", query: "q", family: 3 }).family).toBeUndefined()
  })
})

describe("readSearched: ms and usd coerce, never propagate NaN", () => {
  it("reads a numeric ms and defaults an unreadable one to 0", () => {
    expect(accepted({ kind: "searched", query: "q", ms: 1234 }).ms).toBe(1234)
    expect(accepted({ kind: "searched", query: "q", ms: "not a number" }).ms).toBe(0)
    expect(accepted({ kind: "searched", query: "q" }).ms).toBe(0)
  })

  it("reads a numeric usd, including zero, and defaults an unreadable one to 0", () => {
    expect(accepted({ kind: "searched", query: "q", usd: 0.0086 }).usd).toBe(0.0086)
    expect(accepted({ kind: "searched", query: "q", usd: 0 }).usd).toBe(0)
    expect(accepted({ kind: "searched", query: "q", usd: "free" }).usd).toBe(0)
    expect(accepted({ kind: "searched", query: "q" }).usd).toBe(0)
  })
})

describe("readSearched: hits is filtered, not merely cast", () => {
  it("defaults to an empty array when hits is missing or not an array", () => {
    expect(accepted({ kind: "searched", query: "q" }).hits).toEqual([])
    expect(accepted({ kind: "searched", query: "q", hits: "not an array" }).hits).toEqual([])
  })

  it("drops a hit entry that is not an object, or whose url is not a string", () => {
    const view = accepted({
      kind: "searched",
      query: "q",
      hits: [null, "a url string", 7, { title: "no url here" }, { url: "https://a.example" }],
    })
    expect(view.hits).toEqual([{ url: "https://a.example", title: "", description: "" }])
  })

  it("defaults a kept hit's title and description to '' rather than leaving them undefined", () => {
    const view = accepted({
      kind: "searched",
      query: "q",
      hits: [{ url: "https://a.example" }, { url: "https://b.example", title: "B", description: "d" }],
    })
    expect(view.hits).toEqual([
      { url: "https://a.example", title: "", description: "" },
      { url: "https://b.example", title: "B", description: "d" },
    ])
  })
})
