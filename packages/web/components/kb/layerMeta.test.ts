import { describe, expect, it } from "vitest"
import { builtAtOf, manifestNum, manifestStr } from "./layerMeta"
import type { KbManifest } from "@/lib/viewTypes"

/** A manifest carrying a value the real schema forbids on that key — the exact
 *  shape a run written by a different engine version, or a bug, would send. */
function loose(obj: Record<string, unknown>): KbManifest {
  return obj as unknown as KbManifest
}

/**
 * `manifestNum`, `manifestStr` and `builtAtOf` had zero direct test coverage
 * anywhere, despite being the one place every KB surface (KbCard, KbGallery,
 * KbOverview, KbBrowser, DemoHome, app/kb/[id]/page.tsx) reads a manifest field
 * through — the whole point being that `KbManifest`'s `[key: string]: unknown`
 * looseness cannot leak into a render as "[object Object]" or a stringified
 * "44". Coverage gap found sweeping web/components (D-scope: "areas nobody has
 * swept").
 */
describe("manifestNum: a finite number, and only that", () => {
  it("reads the first key that holds a finite number", () => {
    expect(manifestNum({ usd: 1.5 }, "usd")).toBe(1.5)
    expect(manifestNum({ notes: 3, usd: 1.5 }, "usd", "notes")).toBe(1.5)
  })

  it("falls through to the next key when an earlier one is missing", () => {
    expect(manifestNum({ builtAt: "x", hosts: 4 }, "queries", "hosts")).toBe(4)
  })

  it("never coerces a string, even a numeric-looking one", () => {
    // A manifest that wrote `"44"` is a manifest bug worth seeing, not a
    // number worth rendering.
    expect(manifestNum(loose({ notes: "44" }), "notes")).toBeUndefined()
  })

  it("rejects NaN and Infinity, which are typeof number but not finite", () => {
    expect(manifestNum({ usd: NaN }, "usd")).toBeUndefined()
    expect(manifestNum({ usd: Infinity }, "usd")).toBeUndefined()
    expect(manifestNum({ usd: -Infinity }, "usd")).toBeUndefined()
  })

  it("returns undefined when no key matches, or the manifest is absent", () => {
    expect(manifestNum({ other: 1 }, "usd", "notes")).toBeUndefined()
    expect(manifestNum(null, "usd")).toBeUndefined()
    expect(manifestNum(undefined, "usd")).toBeUndefined()
  })

  it("0 is a real finite number, not an absent one", () => {
    expect(manifestNum({ unjudged: 0 }, "unjudged")).toBe(0)
  })
})

describe("manifestStr: the first non-empty string, trimmed", () => {
  it("reads the first key that holds a non-empty string", () => {
    expect(manifestStr({ brand: "Acme" }, "brand", "root")).toBe("Acme")
    expect(manifestStr({ root: "acme.com" }, "brand", "root")).toBe("acme.com")
  })

  it("trims the value it returns", () => {
    expect(manifestStr({ brand: "  Acme  " }, "brand")).toBe("Acme")
  })

  it("treats a whitespace-only string as absent and falls through", () => {
    expect(manifestStr({ brand: "   ", root: "acme.com" }, "brand", "root")).toBe("acme.com")
  })

  it("skips a non-string value even if the key is present", () => {
    expect(manifestStr(loose({ brand: 44 }), "brand", "input")).toBeUndefined()
    expect(manifestStr(loose({ brand: 44, input: "acme.com" }), "brand", "input")).toBe("acme.com")
  })

  it("returns undefined when no key matches, or the manifest is absent", () => {
    expect(manifestStr({ other: "x" }, "brand", "root")).toBeUndefined()
    expect(manifestStr(null, "brand")).toBeUndefined()
    expect(manifestStr(undefined, "brand")).toBeUndefined()
  })
})

describe("builtAtOf: snake_case and camelCase are the same fact", () => {
  it("reads built_at, the reference engine's spelling", () => {
    expect(builtAtOf({ built_at: "2026-08-01T00:00:00Z" })).toBe("2026-08-01T00:00:00Z")
  })

  it("falls back to builtAt when built_at is absent", () => {
    expect(builtAtOf({ builtAt: "2026-08-02T00:00:00Z" })).toBe("2026-08-02T00:00:00Z")
  })

  it("prefers built_at when both are present", () => {
    expect(builtAtOf({ built_at: "2026-08-01T00:00:00Z", builtAt: "2026-08-02T00:00:00Z" })).toBe(
      "2026-08-01T00:00:00Z",
    )
  })

  it("returns undefined when neither is present", () => {
    expect(builtAtOf({ brand: "Acme" })).toBeUndefined()
    expect(builtAtOf(null)).toBeUndefined()
  })
})
