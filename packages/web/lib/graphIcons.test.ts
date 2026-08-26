import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IconCache } from "./graphIcons"

/**
 * `IconCache` had zero test coverage anywhere — only reachable through
 * `GraphCanvas.tsx`'s canvas paint loop, which nothing here drives. No jsdom
 * is installed in this repo (see vitest.config.ts / theme.test.ts), and the
 * class touches exactly one browser object, so a two-property fake stands in
 * for `Image` the same way theme.test.ts fakes `localStorage`: a constructor
 * that records itself, an assignable `onload`/`onerror`, and the two
 * dimensions `pump()`'s tracking-pixel check reads.
 */

class FakeImage {
  referrerPolicy = ""
  decoding = ""
  src = ""
  naturalWidth = 0
  naturalHeight = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    created.push(this)
  }
}

let created: FakeImage[] = []

/** Fires the image's own load/error handler, the way a real `<img>` would. */
function settle(img: FakeImage, opts: { ok: boolean; width?: number; height?: number }): void {
  img.naturalWidth = opts.width ?? (opts.ok ? 32 : 0)
  img.naturalHeight = opts.height ?? (opts.ok ? 32 : 0)
  if (opts.ok) img.onload?.()
  else img.onerror?.()
}

describe("IconCache", () => {
  beforeEach(() => {
    created = []
    vi.stubGlobal("Image", FakeImage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns null on the first ask and starts one fetch for the domain's favicon", () => {
    const onReady = vi.fn()
    const cache = new IconCache(onReady)
    expect(cache.get("example.com")).toBeNull()
    expect(created).toHaveLength(1)
    // Mirrors the private FAVICON_HOST constant in graphIcons.ts.
    expect(created[0]!.src).toBe("https://icons.duckduckgo.com/ip3/example.com.ico")
    expect(created[0]!.referrerPolicy).toBe("no-referrer")
    expect(created[0]!.decoding).toBe("async")
    expect(onReady).not.toHaveBeenCalled()
  })

  it("returns null for no domain, without starting a fetch", () => {
    const cache = new IconCache(vi.fn())
    expect(cache.get(undefined)).toBeNull()
    expect(cache.get(null)).toBeNull()
    expect(cache.get("")).toBeNull()
    expect(created).toHaveLength(0)
  })

  it("returns the bitmap once the fetch lands, and tells the painter to repaint", () => {
    const onReady = vi.fn()
    const cache = new IconCache(onReady)
    cache.get("example.com")
    settle(created[0]!, { ok: true })
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(cache.get("example.com")).toBe(created[0])
  })

  it("treats a load error as a miss, and never calls onReady for it", () => {
    const onReady = vi.fn()
    const cache = new IconCache(onReady)
    cache.get("example.com")
    settle(created[0]!, { ok: false })
    expect(onReady).not.toHaveBeenCalled()
    expect(cache.get("example.com")).toBeNull()
  })

  it("treats a 1x1 tracking pixel as a miss, not a real icon", () => {
    const onReady = vi.fn()
    const cache = new IconCache(onReady)
    cache.get("example.com")
    settle(created[0]!, { ok: true, width: 1, height: 1 })
    expect(onReady).not.toHaveBeenCalled()
    expect(cache.get("example.com")).toBeNull()
  })

  it("attempts a domain once — asking again while it is loading does not refetch", () => {
    const cache = new IconCache(vi.fn())
    cache.get("example.com")
    cache.get("example.com")
    cache.get("example.com")
    expect(created).toHaveLength(1)
  })

  it("remembers a miss and does not retry it on a later ask", () => {
    const cache = new IconCache(vi.fn())
    cache.get("example.com")
    settle(created[0]!, { ok: false })
    cache.get("example.com")
    expect(created).toHaveLength(1)
  })

  it("caps in-flight requests at six, queuing the rest", () => {
    const cache = new IconCache(vi.fn())
    for (let i = 0; i < 8; i++) cache.get(`host${i}.com`)
    expect(created).toHaveLength(6)
  })

  it("serves the newest queued request first once a slot frees up", () => {
    const cache = new IconCache(vi.fn())
    for (let i = 0; i < 7; i++) cache.get(`host${i}.com`)
    expect(created).toHaveLength(6) // host0..host5 fired immediately, host6 queued
    settle(created[0]!, { ok: true }) // frees one slot
    expect(created).toHaveLength(7)
    expect(created[6]!.src).toContain("host6.com")
  })

  it("dispose drops the queue and makes onReady a no-op for anything still in flight", () => {
    const onReady = vi.fn()
    const cache = new IconCache(onReady)
    for (let i = 0; i < 8; i++) cache.get(`host${i}.com`) // 6 in flight, 2 queued
    cache.dispose()
    settle(created[0]!, { ok: true }) // an in-flight fetch settling after unmount
    expect(onReady).not.toHaveBeenCalled()
    // The queued host6/host7 never fire because dispose cleared the queue.
    expect(created).toHaveLength(6)
  })
})
