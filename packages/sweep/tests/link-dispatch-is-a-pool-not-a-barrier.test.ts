import { describe, expect, it } from "vitest"
import { runPool } from "../src/sweep.js"

/**
 * P0-2. The link phase's two dispatch sites (pair batches and orphan
 * batches) used to chunk into groups of LINK_CONC and `await Promise.all`
 * each group before starting the next — a barrier per group, costing that
 * group its slowest member while finished workers idled. Measured at 43% of
 * a real run's wall time (runs/sweep-cursor-com-20260821105321.json), the
 * largest single phase.
 *
 * `runPool` is the fix, extracted so it can be tested directly rather than
 * through the whole sweep fixture, which has no clean way to control one
 * batch's timing relative to the others. Full sweep()-level coverage stays
 * with the existing link/orphan fixture tests, which pin that both dispatch
 * sites still ask what they always asked and land the same edges — only the
 * scheduling shape changed, and this test is what proves that shape.
 */
describe("runPool", () => {
  it("keeps every item's fn call, in order, exactly once", async () => {
    const seen: number[] = []
    await runPool([10, 20, 30, 40, 50], 2, async (item) => {
      seen.push(item)
    })
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
  })

  it("a slow item does not block the pool from starting the next one", async () => {
    // Ten items, three workers. Item 0 is the slowest of all of them —
    // under the old chunked dispatch (groups of 3: [0,1,2], [3,4,5], [6,7,8],
    // [9]) item 0 alone would have held up items 3-9 until it finished,
    // since the second group cannot start before the first group's
    // Promise.all resolves. Under a continuous pool, the two workers that
    // land items 1 and 2 free up almost immediately and keep pulling fresh
    // items off the front, so item 0 — still running the whole time — ends
    // up finishing dead last rather than gating anything behind it.
    const finishOrder: number[] = []
    const items = Array.from({ length: 10 }, (_, i) => i)
    await runPool(items, 3, async (item) => {
      await new Promise((r) => setTimeout(r, item === 0 ? 50 : 1))
      finishOrder.push(item)
    })
    expect(finishOrder.at(-1)).toBe(0)
  })

  it("never runs more than `conc` at once", async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 12 }, (_, i) => i)
    await runPool(items, 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
    })
    expect(peak).toBe(4)
  })
})
