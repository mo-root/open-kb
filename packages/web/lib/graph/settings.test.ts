import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, RANGES, loadSettings, saveSettings } from "./settings"

/**
 * The settings blob is the one input to the canvas that this codebase does not
 * write. It lives in localStorage, so it survives deploys — a value read here
 * can have been written by a build from three weeks ago, by a hand editing
 * devtools, or by a field that no longer exists. Two failure modes matter:
 *
 *   1. A junk number reaching a d3 force. `NaN` in a velocity propagates to
 *      every node's position within one tick and the map is gone.
 *   2. A blob written BEFORE a switch existed silently choosing that switch's
 *      "off" state, so an old reader loses a shipped default they never
 *      touched — which looks like the app breaking, not like a setting.
 *
 * Both are handled by `loadSettings`, and neither is visible without a test.
 */

const KEY = "kb-graph-settings"

/** `loadSettings` reads exactly one thing off `window`. */
function stubWindow(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  }
  return store
}

let store: Map<string, string>
beforeEach(() => {
  store = stubWindow()
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe("loadSettings", () => {
  it("returns the defaults when nothing has been saved", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("survives a blob that is not JSON at all", () => {
    store.set(KEY, "{not json")
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("survives a blob that is valid JSON but not an object", () => {
    store.set(KEY, "42")
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("round-trips what saveSettings wrote", () => {
    const mine = { ...DEFAULT_SETTINGS, nodeSpacing: 2.4, hoverDims: true, linkCurve: 0.3 }
    saveSettings(mine)
    expect(loadSettings()).toEqual(mine)
  })

  it("defaults sizeBy to prominence", () => {
    expect(DEFAULT_SETTINGS.sizeBy).toBe("prominence")
  })

  it("round-trips an explicit placement choice", () => {
    saveSettings({ ...DEFAULT_SETTINGS, sizeBy: "placement" })
    expect(loadSettings().sizeBy).toBe("placement")
  })

  it("falls back to prominence for a blob with no sizeBy, or an unrecognised value", () => {
    store.set(KEY, JSON.stringify({ nodeScale: 1.2 }))
    expect(loadSettings().sizeBy).toBe("prominence")
    store.set(KEY, JSON.stringify({ sizeBy: "by-color" }))
    expect(loadSettings().sizeBy).toBe("prominence")
  })

  /* The reason every number is clamped rather than trusted. */
  it("clamps every numeric field into its own slider range", () => {
    const keys = Object.keys(RANGES) as (keyof typeof RANGES)[]
    store.set(KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, 1e9]))))
    const high = loadSettings() as unknown as Record<string, number>
    for (const k of keys) expect(high[k]).toBe(RANGES[k].max)

    store.set(KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, -1e9]))))
    const low = loadSettings() as unknown as Record<string, number>
    for (const k of keys) expect(low[k]).toBe(RANGES[k].min)
  })

  it("falls back to the default for NaN, null and non-numbers", () => {
    for (const junk of [null, "2", NaN, {}, []]) {
      store.set(KEY, JSON.stringify({ nodeSpacing: junk, repelForce: junk }))
      const s = loadSettings()
      expect(s.nodeSpacing).toBe(DEFAULT_SETTINGS.nodeSpacing)
      expect(s.repelForce).toBe(DEFAULT_SETTINGS.repelForce)
      expect(Number.isFinite(s.nodeSpacing)).toBe(true)
    }
  })

  /* An older blob is missing every field added since it was written. Which
     default it lands on is a judgement per switch, not a uniform rule — so it
     is asserted per switch. */
  it("keeps the shipped look for opt-OUT switches an old blob never mentioned", () => {
    store.set(KEY, JSON.stringify({ nodeScale: 1.5 }))
    const s = loadSettings()
    expect(s.nodeScale).toBe(1.5) // the one thing the old blob DID say
    expect(s.colorByType).toBe(true)
    expect(s.showIcons).toBe(true)
    expect(s.hoverCard).toBe(true)
    expect(s.nodeSpacing).toBe(DEFAULT_SETTINGS.nodeSpacing)
    expect(s.linkCurve).toBe(DEFAULT_SETTINGS.linkCurve)
  })

  it("leaves opt-IN switches off for a blob that never mentioned them", () => {
    store.set(KEY, JSON.stringify({ nodeScale: 1.5 }))
    const s = loadSettings()
    // Hover-dimming is the behaviour that was removed as a default; a stale
    // blob must not resurrect it.
    expect(s.hoverDims).toBe(false)
    expect(s.arrows).toBe(false)
    expect(s.typeRings).toBe(false)
    expect(s.glow).toBe(false)
  })

  it("reads a boolean switch that was explicitly turned off", () => {
    store.set(KEY, JSON.stringify({ colorByType: false, hoverCard: false }))
    const s = loadSettings()
    expect(s.colorByType).toBe(false)
    expect(s.hoverCard).toBe(false)
  })

  it("ignores a truthy non-boolean for a switch", () => {
    store.set(KEY, JSON.stringify({ hoverDims: "yes", showIcons: 1 }))
    const s = loadSettings()
    expect(s.hoverDims).toBe(false)
    expect(s.showIcons).toBe(DEFAULT_SETTINGS.showIcons)
  })
})

describe("saveSettings", () => {
  /* stubWindow's setItem never throws, so this catch (settings.ts:277) had
     never run: every existing test only exercises the write succeeding. A
     full or private-mode store throws QuotaExceededError from setItem, and
     the comment above the catch says this must not break the graph — that
     claim was never checked. */
  it("swallows a setItem that throws instead of breaking the caller", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new DOMException("", "QuotaExceededError")
        },
      },
    }
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow()
  })
})

describe("RANGES", () => {
  it("holds every default it governs", () => {
    for (const [k, r] of Object.entries(RANGES)) {
      const v = (DEFAULT_SETTINGS as unknown as Record<string, number>)[k]
      expect(v, `${k} default out of range`).toBeGreaterThanOrEqual(r.min)
      expect(v, `${k} default out of range`).toBeLessThanOrEqual(r.max)
    }
  })

  it("gives every range a positive step and real width", () => {
    for (const [k, r] of Object.entries(RANGES)) {
      expect(r.step, `${k} step`).toBeGreaterThan(0)
      expect(r.max, `${k} width`).toBeGreaterThan(r.min)
    }
  })

  /* The panel renders one slider per RANGES key and one toggle per boolean.
     If a numeric field is added to GraphSettings and not to RANGES it silently
     becomes unclampable AND unreachable, which is exactly how a setting turns
     into a constant again. */
  it("covers every numeric field on GraphSettings", () => {
    const numeric = Object.entries(DEFAULT_SETTINGS)
      .filter(([, v]) => typeof v === "number")
      .map(([k]) => k)
      .sort()
    expect(Object.keys(RANGES).sort()).toEqual(numeric)
  })
})
