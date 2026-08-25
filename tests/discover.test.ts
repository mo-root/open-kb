import { describe, expect, it } from "vitest"
import { costBreakdown } from "../scripts/discover.js"

/**
 * `costBreakdown` — the per-turn cost table behind `pnpm discover`'s footer —
 * had no direct test anywhere. The whole file ran at import time (a live
 * BrightData/OpenRouter call via top-level `await discover`), so nothing in
 * it was reachable from a test process. Coverage gap found sweeping
 * `scripts/*.ts beyond sweep.ts` for the same "zero test coverage" class
 * already fixed in audit.ts, diff-runs.ts, read.ts, recall.ts,
 * calibrate-kernel.ts, bakeoff.ts and export-kb.ts.
 *
 * A real bug came with it: `out._steps` is empty whenever discovery ends
 * before any step lands usage, so `ti`/`to` are both 0 and the old inline
 * `100*ti*IN/(ti*IN+to*OUT)` divided zero by zero — the same NaN-on-an-
 * empty-population class bench.ts's provenance footer and query-ratio
 * sentence were already fixed for (1bf6be5, e6742e2). Pulled the arithmetic
 * out the same way diff-runs.ts's parseRun/denoise were, gated the CLI body
 * behind the same `invokedDirectly` guard.
 */
const pricing = { inUsdPerM: 1, outUsdPerM: 2 }

describe("costBreakdown", () => {
  it("returns null percentages, not NaN, when there are no steps", () => {
    const out = costBreakdown(undefined, pricing)
    expect(out.ti).toBe(0)
    expect(out.to).toBe(0)
    expect(out.rows).toEqual([])
    expect(out.inPct).toBeNull()
    expect(out.outPct).toBeNull()
  })

  it("returns null percentages, not NaN, when steps is an empty array", () => {
    const out = costBreakdown([], pricing)
    expect(out.inPct).toBeNull()
    expect(out.outPct).toBeNull()
  })

  it("treats a missing usage field as zero tokens for that step", () => {
    const out = costBreakdown([{} as any], pricing)
    expect(out.rows).toEqual([{ turn: 1, inTok: 0, outTok: 0, usd: 0 }])
    expect(out.inPct).toBeNull()
  })

  it("sums tokens and prices across turns, numbering rows from 1", () => {
    const steps = [
      { usage: { inputTokens: 100, outputTokens: 50 } },
      { usage: { inputTokens: 200, outputTokens: 25 } },
    ] as any
    const out = costBreakdown(steps, pricing)
    expect(out.ti).toBe(300)
    expect(out.to).toBe(75)
    expect(out.rows).toEqual([
      { turn: 1, inTok: 100, outTok: 50, usd: 100 * (1 / 1e6) + 50 * (2 / 1e6) },
      { turn: 2, inTok: 200, outTok: 25, usd: 200 * (1 / 1e6) + 25 * (2 / 1e6) },
    ])
  })

  it("splits the spend share between input and output, rounded to a whole percent", () => {
    // 300 in @ $1/M = $0.0003, 75 out @ $2/M = $0.00015 — input is 2/3 of the $0.00045 total
    const steps = [{ usage: { inputTokens: 300, outputTokens: 75 } }] as any
    const out = costBreakdown(steps, pricing)
    expect(out.inPct).toBe(67)
    expect(out.outPct).toBe(33)
    expect(out.inPct! + out.outPct!).toBeCloseTo(100, 0)
  })

  it("is null, not NaN, when every step logged tokens but the model prices at $0", () => {
    const steps = [{ usage: { inputTokens: 100, outputTokens: 50 } }] as any
    const out = costBreakdown(steps, { inUsdPerM: 0, outUsdPerM: 0 })
    expect(out.inPct).toBeNull()
    expect(out.outPct).toBeNull()
  })
})
