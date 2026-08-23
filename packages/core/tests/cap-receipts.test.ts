import { describe, expect, it } from "vitest"
import { capReceipts } from "../src/judge.js"

/**
 * capReceipts had no test anywhere — judgeHosts calls it once (judge.ts:604)
 * and sweep.ts's second-look path calls it again (sweep.ts:4367, 4622), both
 * only ever exercised through full judgeHosts/sweep integration fixtures,
 * none of which happen to script a span list that crosses the 360-char
 * SPAN_BUDGET. The boundary arithmetic (`>` not `>=`, and the
 * receipts.length === 0 truncation branch) is exactly the kind of off-by-one
 * that survives integration fixtures silently, since a fixture crossing the
 * cap needs 360+ chars of scripted span text nobody happened to write.
 */

describe("capReceipts — under budget", () => {
  it("returns an empty list unchanged", () => {
    expect(capReceipts([])).toEqual([])
  })

  it("keeps every span, in order, when the total fits", () => {
    const spans = ["a".repeat(100), "b".repeat(100), "c".repeat(100)]
    expect(capReceipts(spans)).toEqual(spans)
  })

  it("keeps a span landing exactly on the budget — the check is strictly over, not at or over", () => {
    const span = "x".repeat(360)
    expect(capReceipts([span])).toEqual([span])
  })
})

describe("capReceipts — a later span would cross the budget", () => {
  it("drops the crossing span whole rather than truncating it, once a prior span already fits", () => {
    const first = "a".repeat(200)
    const second = "b".repeat(200) // 200 + 200 = 400 > 360
    expect(capReceipts([first, second])).toEqual([first])
  })

  it("stops at the first crossing span — a span fitting after it is never reached", () => {
    const first = "a".repeat(200)
    const second = "b".repeat(200) // crosses; loop breaks here
    const third = "c".repeat(10) // would fit alongside `first` alone, but is never considered
    expect(capReceipts([first, second, third])).toEqual([first])
  })
})

describe("capReceipts — the very first span alone exceeds the budget", () => {
  it("truncates it to a budget-length prefix rather than dropping it", () => {
    const span = "a".repeat(500)
    expect(capReceipts([span])).toEqual([span.slice(0, 360)])
  })

  it("ignores every span after the truncated first one", () => {
    const first = "a".repeat(500)
    const second = "b".repeat(10)
    expect(capReceipts([first, second])).toEqual([first.slice(0, 360)])
  })
})
