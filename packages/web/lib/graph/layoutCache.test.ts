import { afterEach, describe, expect, it, vi } from "vitest"
import { importLayout, layoutKey, loadLayout, saveLayout, MIN_COVERAGE } from "./layoutCache"

/** The smallest localStorage that behaves like one, including the ability to
 *  refuse — the quota path is half of what this module promises to survive. */
function fakeStorage(opts: { failNextSet?: boolean } = {}) {
  const rows = new Map<string, string>()
  let failNext = opts.failNextSet ?? false
  return {
    rows,
    armQuotaFailure() {
      failNext = true
    },
    api: {
      getItem: (k: string) => rows.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failNext) {
          failNext = false
          throw new Error("QuotaExceededError")
        }
        rows.set(k, v)
      },
      removeItem: (k: string) => void rows.delete(k),
      key: (i: number) => [...rows.keys()][i] ?? null,
      get length() {
        return rows.size
      },
    },
  }
}

function withStorage(store: ReturnType<typeof fakeStorage>) {
  vi.stubGlobal("window", { localStorage: store.api })
}

afterEach(() => vi.unstubAllGlobals())

describe("layoutKey", () => {
  it("separates the map, its census and the unplaced toggle", () => {
    const a = layoutKey("sweep-a", 100, true)
    expect(a).not.toBe(layoutKey("sweep-b", 100, true))
    expect(a).not.toBe(layoutKey("sweep-a", 101, true))
    expect(a).not.toBe(layoutKey("sweep-a", 100, false))
  })
})

describe("save and load", () => {
  it("round-trips positions, rounded to a tenth of a unit", () => {
    const store = fakeStorage()
    withStorage(store)
    const key = layoutKey("m", 2, true)
    saveLayout(key, [
      { id: "a", x: 1.234, y: -5.678 },
      { id: "b", x: 0, y: 0 },
    ])
    const back = loadLayout(key)
    expect(back?.get("a")).toEqual({ x: 1.2, y: -5.7 })
    expect(back?.get("b")).toEqual({ x: 0, y: 0 })
  })

  it("skips nodes without live coordinates rather than storing garbage", () => {
    const store = fakeStorage()
    withStorage(store)
    const key = layoutKey("m", 3, true)
    saveLayout(key, [{ id: "a", x: 1, y: 2 }, { id: "ghost" }, { id: "nan", x: NaN, y: 1 }])
    const back = loadLayout(key)
    expect(back?.size).toBe(1)
    expect(back?.has("ghost")).toBe(false)
  })

  it("answers null for a corrupt row instead of throwing at the canvas", () => {
    const store = fakeStorage()
    withStorage(store)
    const key = layoutKey("m", 1, true)
    store.rows.set(key, "{not json")
    expect(loadLayout(key)).toBeNull()
    store.rows.set(key, JSON.stringify({ n: { a: [1, "x"] } }))
    expect(loadLayout(key)).toBeNull()
  })

  it("evicts other maps' layouts when the quota refuses, then lands the write", () => {
    const store = fakeStorage()
    withStorage(store)
    const other = layoutKey("elder", 5, true)
    saveLayout(other, [{ id: "z", x: 1, y: 1 }])
    store.armQuotaFailure()
    const key = layoutKey("young", 2, true)
    saveLayout(key, [{ id: "a", x: 3, y: 4 }])
    expect(loadLayout(key)?.get("a")).toEqual({ x: 3, y: 4 })
    expect(loadLayout(other)).toBeNull()
  })

  it("gives up quietly when storage is unavailable even after eviction", () => {
    // Every setItem throws, so the post-eviction retry fails too — the
    // innermost catch (never exercised by the single-failure quota test
    // above) has to swallow that second throw without the caller noticing.
    const store = fakeStorage()
    withStorage(store)
    store.api.setItem = () => {
      throw new Error("SecurityError")
    }
    const key = layoutKey("m", 1, true)
    expect(() => saveLayout(key, [{ id: "a", x: 1, y: 2 }])).not.toThrow()
    expect(store.rows.size).toBe(0)
  })
})

describe("importLayout", () => {
  it("stores a baked row the loader accepts unchanged", () => {
    const store = fakeStorage()
    withStorage(store)
    const key = layoutKey("baked", 2, false)
    importLayout(key, { a: [10, 20], b: [-3.5, 7] })
    const back = loadLayout(key)
    expect(back?.get("b")).toEqual({ x: -3.5, y: 7 })
  })

  it("degrades to a no-op when storage refuses the write", () => {
    // Unlike saveLayout, importLayout has no eviction retry — one throw is
    // the whole story, and it had never been driven through this catch.
    const store = fakeStorage({ failNextSet: true })
    withStorage(store)
    const key = layoutKey("baked", 1, false)
    expect(() => importLayout(key, { a: [1, 2] })).not.toThrow()
    expect(loadLayout(key)).toBeNull()
  })
})

describe("without a window", () => {
  it("every entry point degrades to a no-op", () => {
    // No stub: vitest's node environment has no window at all.
    const key = layoutKey("m", 1, true)
    expect(loadLayout(key)).toBeNull()
    expect(() => saveLayout(key, [{ id: "a", x: 1, y: 2 }])).not.toThrow()
    expect(() => importLayout(key, { a: [1, 2] })).not.toThrow()
  })
})

describe("MIN_COVERAGE", () => {
  it("demands near-total coverage, because a half-remembered map tears itself apart", () => {
    expect(MIN_COVERAGE).toBeGreaterThanOrEqual(0.9)
  })
})
