import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { readSearched, SearchesPanel, withRowIds, type SearchView } from "./SearchesPanel"

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
 *
 * D-scope, self-discovered. git log names SELF-477 as the last used, so this
 * is SELF-478.
 *
 * The `SearchesPanel` component itself was still at zero: a scoped v8
 * coverage pass (`npx vitest run packages/web/components/build/SearchesPanel.test.ts
 * --coverage`, temporary `@vitest/coverage-v8@3.2.7` devDependency, added,
 * run, reverted) shows `f.f` — the per-function hit counts in
 * coverage-final.json — at `{ readSearched: 32, hostOf: 0, SearchesPanel: 0 }`.
 * The component function was never once called by any test in the repo.
 *
 * `hostOf`'s try/catch and every render branch gated on the per-row `isOpen`
 * state (the hit list `hostOf` itself feeds, `why`, `error`) only exist once a
 * click has run — the same "needs a live DOM this repo has no jsdom/RTL
 * harness for" limit `TabBar.test.tsx`, `ThemeToggle.test.tsx` and
 * `GraphSearch.test.tsx` already documented for their own interaction-gated
 * parts, confirmed by reading `open`'s only writer (`setOpen` inside the row's
 * own `onClick`) — nothing in `renderToStaticMarkup` runs an event handler.
 * That part stays untested here for the same reason.
 *
 * What IS reachable without any interaction: every branch that reads off the
 * `searches` prop rather than `open`/`onlyEmpty` state, since props are fixed
 * for the render `renderToStaticMarkup` performs. That covers the early
 * `searches.length === 0` return, the header's aggregate counts and its
 * failed/barren summary line, the per-row family badge (present, absent, and
 * an unrecognised family falling back to the default tone), and the
 * ok/failed/empty three-way styling on the hit count. `onlyEmpty` and `open`
 * both start at their declared initial values (`false` and `null`) on every
 * render this file performs, since nothing here can flip them.
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

function search(overrides: Partial<SearchView>): SearchView {
  return { query: "q", intent: "", platform: "", why: "", ok: true, ms: 0, usd: 0, hits: [], ...overrides }
}

describe("SearchesPanel: renders nothing for an empty run", () => {
  it("returns null rather than an empty section", () => {
    expect(renderToStaticMarkup(<SearchesPanel searches={[]} />)).toBe("")
  })
})

describe("SearchesPanel: the header aggregates every search, not just the ones later opened", () => {
  it("counts asked and results across all rows", () => {
    const html = renderToStaticMarkup(
      <SearchesPanel
        searches={[
          search({ query: "a", hits: [{ url: "https://a.example", title: "", description: "" }] }),
          search({ query: "b", hits: [] }),
        ]}
      />,
    )
    expect(html).toContain("2 asked")
    expect(html).toContain("1 results")
  })

  it("says nothing about failed/empty when every search succeeded with hits", () => {
    const html = renderToStaticMarkup(<SearchesPanel searches={[search({ hits: [{ url: "https://a.example", title: "", description: "" }] })]} />)
    expect(html).not.toContain("failed")
    expect(html).not.toContain("returned nothing")
  })

  it("reports failed alone, barren alone, and both joined by a middot", () => {
    const failedOnly = renderToStaticMarkup(<SearchesPanel searches={[search({ ok: false })]} />)
    expect(failedOnly).toContain("1 failed")
    expect(failedOnly).not.toContain("returned nothing")

    const barrenOnly = renderToStaticMarkup(<SearchesPanel searches={[search({ hits: [] })]} />)
    expect(barrenOnly).toContain("1 returned nothing")
    expect(barrenOnly).not.toContain("failed")

    const both = renderToStaticMarkup(<SearchesPanel searches={[search({ ok: false }), search({ query: "b", hits: [] })]} />)
    expect(both).toContain("1 failed")
    expect(both).toContain("1 returned nothing")
    expect(both).toMatch(/1 failed[^<]*·[^<]*1 returned nothing/)
  })

  it("starts with the 'only the empty' toggle off", () => {
    const html = renderToStaticMarkup(<SearchesPanel searches={[search({})]} />)
    expect(html).toMatch(/aria-pressed="false"[^>]*>\s*only the empty/)
  })
})

describe("SearchesPanel: each row's pre-click render reads its own search, not neighbours'", () => {
  it("shows the family badge only when the search carries one, in its sanctioned tone", () => {
    const withFamily = renderToStaticMarkup(<SearchesPanel searches={[search({ family: "rival" })]} />)
    expect(withFamily).toContain(">rival<")
    expect(withFamily).toContain("text-rose-300")
    expect(withFamily).toContain('title="asked as a rival query"')

    const withoutFamily = renderToStaticMarkup(<SearchesPanel searches={[search({})]} />)
    expect(withoutFamily).not.toContain("asked as a")
  })

  it("falls back to the default tone for a family the run never sanctioned", () => {
    const html = renderToStaticMarkup(<SearchesPanel searches={[search({ family: "mystery" })]} />)
    expect(html).toContain(">mystery<")
    expect(html).toContain("text-slate-400 border-slate-600/40 bg-slate-700/20")
  })

  it("reads 'failed' in rose for a failed search, regardless of any hits it carries", () => {
    const html = renderToStaticMarkup(<SearchesPanel searches={[search({ ok: false, hits: [{ url: "https://a.example", title: "", description: "" }] })]} />)
    expect(html).toMatch(/text-rose-400[^>]*>\s*failed/)
  })

  it("reads the hit count in amber when a search succeeded with nothing back", () => {
    const html = renderToStaticMarkup(<SearchesPanel searches={[search({ hits: [] })]} />)
    expect(html).toMatch(/text-amber-500[^>]*>\s*0/)
  })

  it("reads the hit count in the neutral tone when a search succeeded with results", () => {
    const html = renderToStaticMarkup(
      <SearchesPanel searches={[search({ hits: [{ url: "https://a.example", title: "", description: "" }] })]} />,
    )
    expect(html).toMatch(/text-slate-500[^>]*>\s*1/)
  })

  it("never renders the per-row detail (hostOf, why, error) before any row is opened", () => {
    // `open` starts at `null`, and nothing in a static render can run the
    // onClick that would change it — see this file's own top comment.
    const html = renderToStaticMarkup(
      <SearchesPanel
        searches={[
          search({
            why: "checking for a direct rival",
            error: "timed out",
            hits: [{ url: "https://a.example", title: "Example", description: "" }],
          }),
        ]}
      />,
    )
    expect(html).not.toContain("why it asked")
    expect(html).not.toContain("timed out")
    expect(html).not.toContain("a.example")
  })
})

describe("withRowIds: a row's id is its identity, not its slot in a filtered view", () => {
  it("keeps a row's id fixed no matter which other rows are dropped around it", () => {
    const all = [
      search({ query: "a", hits: [{ url: "https://a.example", title: "", description: "" }] }),
      search({ query: "b", hits: [] }),
      search({ query: "c", hits: [{ url: "https://c.example", title: "", description: "" }] }),
    ]
    const full = withRowIds(all)
    const bRow = full.find((r) => r.s.query === "b")!

    // The same filter SearchesPanel applies for "only the empty": drop every
    // row that isn't barren or failed. "b" is barren and survives it, and its
    // id must be the one from the id computed over the full list — otherwise
    // toggling the filter on would make an already-open "b" panel read as
    // closed even though it never left the list.
    const onlyEmpty = withRowIds(all).filter((r) => !r.s.ok || r.s.hits.length === 0)
    expect(onlyEmpty).toHaveLength(1)
    expect(onlyEmpty[0]!.id).toBe(bRow.id)
  })

  it("assigns each row its own id even when two searches share the same query text", () => {
    const all = [search({ query: "dup" }), search({ query: "dup" })]
    const [first, second] = withRowIds(all)
    expect(first!.id).not.toBe(second!.id)
  })
})
