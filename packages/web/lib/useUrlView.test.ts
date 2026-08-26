import { afterEach, describe, expect, it, vi } from "vitest"
import { readUrl, writeUrl } from "./useUrlView"

/**
 * readUrl and writeUrl had zero direct test coverage anywhere. The hook that
 * wraps them, useUrlView, needs React's render lifecycle to exercise
 * (useState/useEffect/useCallback) and this repo has no jsdom/RTL harness to
 * drive that — the same gap GraphCanvas.tsx's zero-entity guard hit (see its
 * own commit, and B4 in the former docs/overnight-backlog.md). But the two
 * functions that actually decide what the URL says only touch `window`, so a
 * stub object reaches every branch without a renderer — the same pattern
 * lib/graph/layoutCache.test.ts already uses for `window.localStorage`.
 * Coverage gap found sweeping web/lib (D-scope: "areas nobody has swept").
 */

function fakeWindow(pathname: string, search: string) {
  return {
    location: { pathname, search },
    history: { pushState: vi.fn(), replaceState: vi.fn() },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe("readUrl", () => {
  it("falls back with no note when window is absent", () => {
    // No stub: vitest's node environment has no window at all.
    expect(readUrl("overview")).toEqual({ tab: "overview", note: null })
  })

  it("falls back to the given tab and a null note on an empty query", () => {
    vi.stubGlobal("window", fakeWindow("/kb/acme.com", ""))
    expect(readUrl("overview")).toEqual({ tab: "overview", note: null })
  })

  it("reads tab and note from the query string", () => {
    vi.stubGlobal("window", fakeWindow("/kb/acme.com", "?tab=graph&note=rival-co"))
    expect(readUrl("overview")).toEqual({ tab: "graph", note: "rival-co" })
  })

  it("reads a note beside the fallback tab when tab is absent", () => {
    vi.stubGlobal("window", fakeWindow("/kb/acme.com", "?note=rival-co"))
    expect(readUrl("overview")).toEqual({ tab: "overview", note: "rival-co" })
  })
})

describe("writeUrl", () => {
  it("omits tab from the URL when it is the default (overview)", () => {
    const w = fakeWindow("/kb/acme.com", "?tab=graph")
    vi.stubGlobal("window", w)
    writeUrl({ tab: "overview", note: null }, "replace")
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/kb/acme.com")
  })

  it("sets tab in the URL when it is not the default", () => {
    const w = fakeWindow("/kb/acme.com", "")
    vi.stubGlobal("window", w)
    writeUrl({ tab: "graph", note: null }, "replace")
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/kb/acme.com?tab=graph")
  })

  it("sets note when truthy and drops it when falsy", () => {
    const w = fakeWindow("/kb/acme.com", "")
    vi.stubGlobal("window", w)
    writeUrl({ tab: "overview", note: "rival-co" }, "push")
    expect(w.history.pushState).toHaveBeenCalledWith(null, "", "/kb/acme.com?note=rival-co")

    const w2 = fakeWindow("/kb/acme.com", "?note=rival-co")
    vi.stubGlobal("window", w2)
    writeUrl({ tab: "overview", note: null }, "push")
    expect(w2.history.pushState).toHaveBeenCalledWith(null, "", "/kb/acme.com")
  })

  it("preserves an unrelated query param it was never asked to touch", () => {
    const w = fakeWindow("/kb/acme.com", "?ref=email")
    vi.stubGlobal("window", w)
    writeUrl({ tab: "graph", note: "rival-co" }, "replace")
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/kb/acme.com?ref=email&tab=graph&note=rival-co")
  })

  it("writes nothing when the computed URL matches the current one", () => {
    const w = fakeWindow("/kb/acme.com", "?tab=graph")
    vi.stubGlobal("window", w)
    writeUrl({ tab: "graph", note: null }, "replace")
    expect(w.history.replaceState).not.toHaveBeenCalled()
    expect(w.history.pushState).not.toHaveBeenCalled()
  })

  it("calls pushState under push mode and replaceState under replace mode", () => {
    const wPush = fakeWindow("/kb/acme.com", "")
    vi.stubGlobal("window", wPush)
    writeUrl({ tab: "graph", note: null }, "push")
    expect(wPush.history.pushState).toHaveBeenCalledTimes(1)
    expect(wPush.history.replaceState).not.toHaveBeenCalled()

    const wReplace = fakeWindow("/kb/acme.com", "")
    vi.stubGlobal("window", wReplace)
    writeUrl({ tab: "graph", note: null }, "replace")
    expect(wReplace.history.replaceState).toHaveBeenCalledTimes(1)
    expect(wReplace.history.pushState).not.toHaveBeenCalled()
  })
})
