import { describe, it, expect } from "vitest"
import {
  MEASURED_PHASE_COSTS,
  queriesThatFit,
  rankSeconds,
  runSeconds,
  secondsPerQuery,
  type PhaseCosts,
} from "../src/clock.js"

/**
 * THE ARITHMETIC A DEPLOYMENT SIZES ITS RUNS WITH.
 *
 * These four functions decide how much a web run is allowed to buy, so the
 * things worth pinning are the ones a wrong answer would cost money for: that
 * more clock buys more run, that the answer fits the clock it was derived from,
 * and that the shape of the model is rank-dominated — which is the whole reason
 * a query budget is the right lever at all.
 *
 * The coefficients themselves are measurements and will change when something
 * is measured again. So the assertions that name a number are about the
 * MEASURED table specifically and say what it currently is; the assertions
 * about behaviour are written against a table this file states itself, so they
 * keep holding after a re-measurement.
 */

/** A round table, so the expected values below are arithmetic a reader can do:
 *  100s fixed, 1s of search per query, 10 hosts each, 1s a host at the pool,
 *  100s of tail. One query costs 1 + 10 = 11s. */
const ROUND: PhaseCosts = {
  fixedSeconds: 100,
  sweepSecondsPerQuery: 1,
  hostsPerQuery: 10,
  rankSecondsPerHost: 1,
  tailSeconds: 100,
}

describe("what a run costs in wall time", () => {
  it("charges a query for its own search AND for the hosts it drags into rank", () => {
    expect(secondsPerQuery(ROUND)).toBe(11)
    expect(runSeconds(10, ROUND)).toBe(100 + 110 + 100)
    expect(rankSeconds(250, ROUND)).toBe(250)
  })

  it("is dominated by rank on the measured table, which is why the lever is queries", () => {
    // The claim the route's comment makes and the reason a query budget is a
    // host budget wearing a disguise. If a re-measurement ever makes search the
    // long pole, the budget should be spent differently and this goes red.
    const c = MEASURED_PHASE_COSTS
    const rankShare = (c.hostsPerQuery * c.rankSecondsPerHost) / secondsPerQuery(c)
    expect(rankShare).toBeGreaterThan(0.8)
  })

  it("a bigger clock buys a bigger run, strictly, all the way up", () => {
    // The property the web route depends on: raising `maxDuration` on a paid
    // plan has to raise the map, or the budget is a cap dressed as a
    // derivation. Every step, not just the endpoints.
    let last = 0
    for (const seconds of [210, 270, 400, 770, 1770]) {
      const n = queriesThatFit(seconds, ROUND)
      expect(n).toBeGreaterThan(last)
      last = n
    }
  })

  it("gives back a run that actually fits the clock it was handed", () => {
    // The one property that matters: the answer, run forwards, is inside the
    // budget — and one more query is not. That is the definition of "the
    // largest that fits", and a rounding error in either direction breaks it.
    for (const seconds of [300, 500, 770, 1770]) {
      const n = queriesThatFit(seconds, ROUND)
      expect(runSeconds(n, ROUND)).toBeLessThanOrEqual(seconds)
      expect(runSeconds(n + 1, ROUND)).toBeGreaterThan(seconds)
    }
  })

  it("never answers zero, however small the clock", () => {
    // A budget of zero is a sweep that buys nothing and returns an empty map,
    // which reads to a visitor as a quiet market rather than as a host too
    // small to map anything. A host this small fails either way; it should fail
    // having tried, not having silently bought nothing.
    expect(queriesThatFit(30, ROUND)).toBe(1)
    expect(queriesThatFit(0, ROUND)).toBe(1)
    expect(queriesThatFit(-100, ROUND)).toBe(1)
  })

  it("sizes the two plans this repo actually deploys on", () => {
    // The numbers in `app/api/map/route.ts`'s comment, kept honest from here:
    // Hobby is 300s and Pro is 800s, both less the watchdog's 30s margin.
    // These are the MEASURED table, so they move when a coefficient is
    // re-measured — which is the moment that comment needs rewriting too.
    expect(queriesThatFit(300 - 30)).toBe(18)
    expect(queriesThatFit(800 - 30)).toBe(70)
  })

  it("says the run that was guillotined never fit, by a factor of five", () => {
    // The measurement this whole module exists because of: clerk.com on Vercel,
    // 132 SERP searches bought, killed at 270s having just started rank. Run
    // the model backwards over what it bought and it needed the better part of
    // half an hour. That is the arithmetic nobody was doing.
    const needed = runSeconds(132)
    expect(needed).toBeGreaterThan(20 * 60)
    expect(needed / 270).toBeGreaterThan(4)
  })
})
