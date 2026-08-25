import { describe, expect, it } from "vitest"
import { pct, suggestThreshold } from "../scripts/calibrate-kernel.js"

/**
 * `pct` and `suggestThreshold` are the whole arithmetic `pnpm run calibrate-
 * kernel` exists to run — the rest of the file is a live-fetch bulk reader.
 * Neither had a direct test: the file ran its whole body (argv-free, but
 * still live fetches) at import time, so nothing could import it in a test
 * process without dialing out. Coverage gap found sweeping `scripts/*.ts
 * beyond sweep.ts` (D-scope: "areas nobody has swept"). Fixed the same way
 * `parseRun` was pulled out of diff-runs.ts: extract the pure functions, gate
 * the fetch loop behind an `invokedDirectly` guard.
 */

describe("pct", () => {
  it("is NaN on an empty array — no data, not zero", () => {
    expect(pct([], 50)).toBeNaN()
  })

  it("floor-indexes into a sorted-ascending array, clamped to the last element at p=100", () => {
    expect(pct([1, 2, 3, 4, 5], 95)).toBe(5)
    expect(pct([1, 2, 3, 4, 5], 100)).toBe(5)
    expect(pct([10, 20, 30], 50)).toBe(20)
  })

  it("p=0 reads the first element", () => {
    expect(pct([1, 2, 3], 0)).toBe(1)
  })
})

describe("suggestThreshold", () => {
  it("suggests the midpoint when companies' p95 sits below directories' p50", () => {
    expect(suggestThreshold([1, 2, 3, 4, 5], [10, 20, 30])).toEqual({
      threshold: 13,
      note: "companies p95=5 < directories p50=20; midpoint 13",
    })
  })

  it("refuses (threshold null) when the two distributions do not separate", () => {
    const result = suggestThreshold([10, 20, 30], [1, 2, 3])
    expect(result.threshold).toBeNull()
    expect(result.note).toBe("no separation (companies p95=30, directories p50=2); ship the rule disabled")
  })

  it("refuses when either sample is empty — NaN fails the separation test rather than passing it", () => {
    expect(suggestThreshold([], []).threshold).toBeNull()
    expect(suggestThreshold([1, 2, 3], []).threshold).toBeNull()
    expect(suggestThreshold([], [1, 2, 3]).threshold).toBeNull()
  })
})
