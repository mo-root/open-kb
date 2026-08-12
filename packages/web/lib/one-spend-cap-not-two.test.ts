import { describe, expect, it } from "vitest"
import * as core from "@open-kb/core"
import { defaultRunCapUsd, reserveUsd, runUsd, tripAtUsd } from "@/lib/spend-limits"

/**
 * THE WEB ROUTE AND THE CLI STOP A RUN THE SAME WAY, and there is one piece of
 * code that does it.
 *
 * The watchdog was written here, for the one surface that meters what it spends,
 * and it worked — `app/api/map/limits.test.ts` drives the real engine through it
 * and is the proof that this surface still behaves exactly as it did. What
 * changed is that `scripts/sweep.ts`, `scripts/swarm.ts` and `scripts/batch.ts`
 * enforce it too, and the way that was done was by MOVING it rather than copying
 * it.
 *
 * The copy is the thing worth guarding against. The delicate part of this
 * watchdog is not the subscription, it is the order — abort first, record second,
 * in one synchronous block — and the reserve that lets a run end AT its cap
 * rather than past it. A second copy drifts on exactly those two points, in the
 * direction of whichever surface was edited last, and the symptom on the losing
 * side is money.
 */
describe("there is one spend cap, not one per surface", () => {
  it("this deployment's reserve arithmetic IS core's, not a second copy of it", () => {
    expect(reserveUsd).toBe(core.reserveUsd)
    expect(tripAtUsd).toBe(core.tripAtUsd)
  })

  it("keeps the numbers this deployment was tuned to", () => {
    // The default 300s host: an 18-query map, a $0.41 cap, a $0.31 trip. These
    // are the figures DEPLOY.md publishes and the ones limits.test.ts asserts
    // against a live run, so a move that changed them by a cent would be a
    // change to what a visitor is promised.
    expect(defaultRunCapUsd(18)).toBeCloseTo(0.41, 10)
    expect(tripAtUsd(0.41)).toBeCloseTo(0.3075, 10)
    expect(reserveUsd(0.41)).toBeCloseTo(0.1025, 10)
    // And the trip still clears the worst run of that size by half again.
    expect(tripAtUsd(defaultRunCapUsd(18))).toBeGreaterThan(runUsd(18) * 1.25)
  })

  it("still holds back the floor reserve on a cap small enough to need it", () => {
    // `max($0.05, 25%)` — below $0.20 the floor is what applies, and it is what
    // keeps `readLimits` able to refuse a cap too small to buy anything.
    expect(reserveUsd(0.1)).toBe(0.05)
    expect(reserveUsd(1)).toBe(0.25)
  })

  it("exports the watchdog the route imports", () => {
    // A named export the route depends on, checked here so that renaming it in
    // core fails a test rather than a build nobody runs until deploy.
    expect(typeof core.withSpendCap).toBe("function")
  })
})
