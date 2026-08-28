import { describe, expect, it } from "vitest"
import { PRESETS } from "./GraphSettings"
import { RANGES, DEFAULT_SETTINGS, type GraphSettings } from "@/lib/graph/settings"

/**
 * GraphSettings.tsx's PRESETS table had zero test coverage anywhere. D-scope
 * sweep, self-discovered (A, B and C are all done or BLOCKED; docs/overnight-
 * backlog.md itself is gone from this checkout — see 48c1eaa's note on
 * recovering section D's scope from git history).
 *
 * Every slider in the panel is bounded by `RANGES` in lib/graph/settings.ts,
 * and the panel's own reset button and localStorage reader (`loadSettings`)
 * both clamp against that same table — RANGES is the one place a slider's
 * bounds are declared. PRESETS is typed `Partial<Settings>`, so a typo'd key
 * is a compile error, but nothing checks that a preset's numeric VALUES sit
 * inside the RANGES bounds for those keys: a preset edited to a value outside
 * its own slider's range compiles clean, and the only symptom is a `<input
 * type="range">` whose value falls outside [min, max] — the browser clamps
 * the drawn thumb to the nearest end without the panel's own state agreeing,
 * so the number printed beside the slider (read from state) and the thumb's
 * on-screen position (clamped by the DOM) disagree.
 *
 * GraphSettingsPanel itself is not exercised here — it takes live onChange/
 * onReheat callbacks and its interesting behaviour (which preset button is
 * active, the reset click) needs no more than PRESETS and RANGES already
 * cover; the render is plain JSX with no ref or effect, same shape as the
 * other panel-style components in this directory that were left unrendered
 * once their data tables were pinned.
 */

describe("every preset's numeric fields fall inside their slider's own range", () => {
  const numericKeys = Object.keys(RANGES) as (keyof typeof RANGES)[]

  for (const preset of PRESETS) {
    it(`${preset.key}: every numeric field it sets is within [min, max]`, () => {
      for (const [key, value] of Object.entries(preset.patch)) {
        if (typeof value !== "number") continue
        expect(numericKeys, `${key} is not a ranged field`).toContain(key)
        const range = RANGES[key as keyof typeof RANGES]
        expect(value, `${preset.key}.${key} = ${value}`).toBeGreaterThanOrEqual(range.min)
        expect(value, `${preset.key}.${key} = ${value}`).toBeLessThanOrEqual(range.max)
      }
    })
  }

  it("covers at least one field per preset, so an empty patch cannot pass silently", () => {
    for (const preset of PRESETS) {
      expect(Object.keys(preset.patch).length, preset.key).toBeGreaterThan(0)
    }
  })
})

describe("every preset patches only real GraphSettings fields", () => {
  const validKeys = new Set(Object.keys(DEFAULT_SETTINGS))

  for (const preset of PRESETS) {
    it(`${preset.key}: every key it sets is a real GraphSettings field`, () => {
      for (const key of Object.keys(preset.patch)) {
        expect(validKeys.has(key), key).toBe(true)
      }
    })
  }
})

/** Type-level proof that a preset can only ever name a real field — the
 *  runtime check above is what catches a value out of range, which this
 *  cannot: TypeScript checks keys and types, not magnitudes. */
describe("PRESETS is typed against the real settings shape", () => {
  it("assigns straight into a Partial<GraphSettings> with no cast", () => {
    const proof: Partial<GraphSettings> = PRESETS[0]!.patch
    expect(proof).toBe(PRESETS[0]!.patch)
  })
})
