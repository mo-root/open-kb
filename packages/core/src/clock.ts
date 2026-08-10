/**
 * WHAT A RUN COSTS IN WALL TIME, and therefore how big a run fits in a clock.
 *
 * A sweep has no idea how long it has. That is correct for the CLI, which has
 * no deadline and should keep dealing its own hand, and it was fatal on the
 * web, where the host stops the invocation at `maxDuration` whatever the run
 * thinks it is doing. One measured Vercel run (clerk.com, 481 spans) spent
 * $0.7099 buying 132 SERP searches and was stopped 30s before the ceiling
 * having just STARTED the phase that turns hosts into a map. It did not crash.
 * It bought a twenty-minute run with five minutes of clock, and the reader got
 * nothing at all for the money.
 *
 * So the caller that knows the clock has to be able to work out what fits, and
 * the engine has to be able to check the same arithmetic mid-run. That is one
 * table of coefficients and four functions over it, here, where both can reach
 * it — the web route sizes the run before it starts, the sweep's planner asks
 * whether another widening round can still be paid for. Two consumers, one set
 * of numbers, so they cannot drift into disagreeing about what a host costs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE EVERY NUMBER COMES FROM
 *
 * Two sources, and where they disagree the SLOWER one is used. Erring slow
 * costs a smaller map; erring fast costs the whole map, at full price.
 *
 *   THE DEPLOYMENT. The killed run's own phase table, which is the only
 *   measurement of this pipeline on the platform it has to fit:
 *
 *       0-30s     understand   read clerk.com          6 model calls
 *       30-60s    plan         the catalog             9 model calls
 *       60-240s   sweep        132 SERP searches
 *       240-270s  rank         48 fetches + 33 classify calls, then stopped
 *
 *   THE ARTIFACTS. The 13 sweeps in `runs/` that carry `report.kernel` — the
 *   per-host judging era, i.e. runs whose shape is the current one. Every
 *   coefficient below is a median over those 13 unless it says otherwise:
 *
 *       serp latency per query    cost.byKind.serp.ms / calls
 *                                 13.3 … 17.1 … 23.5s, median 17.1
 *       fetch per host            cost.byKind.fetch.ms / calls
 *                                 0.81 … 0.98 … 1.17s, median 0.98
 *       classify per residue host (byAgent.rank.ms − hosts × fetch) / modelJudged
 *                                 1.39 … 3.02 … 4.03s, median 3.02
 *       residue share             modelJudged / (modelJudged + settledFree)
 *                                 0.82 … 0.85 … 0.86
 *       hosts per query fired     report.hosts / report.queries
 *                                 7.1 … 13.2 … 17.3, median 13.2
 *       link, one batch           byAgent.link.ms / calls, median 19.0s
 *                                 (batches fire together, so the phase's wall
 *                                 clock is ONE batch, not their sum)
 *
 * The deployment is slower than a laptop at both of the things that scale, by
 * about the same factor, which is why the two sources are quoted per field
 * rather than averaged into one authority.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The five coefficients a run's wall clock is made of.
 *
 * Injectable so a test can state its own arithmetic instead of asserting
 * against whatever the measured table happens to say this month, and so a
 * future measurement is a value change rather than an edit to four functions.
 */
export interface PhaseCosts {
  /**
   * `understand` + the opening `plan`, which do not scale with the budget:
   * a handful of free fetches, one model call to read the company, and one
   * call per product to write its hand, six at a time.
   */
  fixedSeconds: number
  /**
   * One query's share of the sweep phase, at the search pool's width.
   *
   * 1.4 from the deployment: 132 searches across 60-240s. The artifacts say
   * 17.1s per query ÷ a 20-wide pool = 0.86s, which is the same quantity
   * measured on a laptop with the pool kept full. The larger is used.
   */
  sweepSecondsPerQuery: number
  /**
   * Distinct hosts one fired query drags into the rank phase — deduplicated
   * against every other query in the run, which is why it is 13 and not the
   * ~30 rows a four-page SERP returns.
   *
   * THE MULTIPLIER THAT MATTERS. Hosts are what rank is charged for, and rank
   * is 85% of a run's variable cost, so a query budget is a host budget
   * wearing a disguise. Median of the 13 artifacts; the spread is 7.1 to 17.3
   * and that spread is exactly why `deadlineAt` exists as a backstop below.
   */
  hostsPerQuery: number
  /**
   * One host, judged: a free front-page fetch, then a model call on the 85%
   * the predicates cannot settle for nothing — divided by the rank pool.
   *
   * 0.63 from the deployment: 48 fetches and 33 classify calls in the 30s
   * before it was killed, at pool 8. The artifacts' ingredients give
   * 1.0s + 0.85 × 3.0s = 3.55 pool-seconds ÷ 8 = 0.44. The larger is used —
   * and the gap is the honest reason `runSeconds()` is a median with a tail,
   * not a promise.
   */
  rankSecondsPerHost: number
  /**
   * Everything after the last host is judged: the free naming pass, the paid
   * link batches (~19s, all in flight together), the report, the final frame,
   * and the caller's own durable write.
   */
  tailSeconds: number
}

/** The table above, as the numbers this repo has actually measured. */
export const MEASURED_PHASE_COSTS: PhaseCosts = {
  fixedSeconds: 60,
  sweepSecondsPerQuery: 1.4,
  hostsPerQuery: 13,
  rankSecondsPerHost: 0.63,
  tailSeconds: 30,
}

/** Wall seconds to judge `hosts` at the rank pool's width. The engine's own
 *  mid-run question: can what I have already found still be turned into a map
 *  before the host stops me? */
export function rankSeconds(hosts: number, costs: PhaseCosts = MEASURED_PHASE_COSTS): number {
  return Math.max(0, hosts) * costs.rankSecondsPerHost
}

/** Wall seconds one more query costs end to end — its own search, plus the
 *  hosts it drags into rank. 1.4 + 13 × 0.63 = 9.6s, of which 85% is rank. */
export function secondsPerQuery(costs: PhaseCosts = MEASURED_PHASE_COSTS): number {
  return costs.sweepSecondsPerQuery + costs.hostsPerQuery * costs.rankSecondsPerHost
}

/** Wall seconds a run of `queries` queries takes, fixed phases and tail
 *  included. The inverse of `queriesThatFit`, and the function that says a
 *  132-query run needed about 23 minutes of the 4.5 it was given. */
export function runSeconds(queries: number, costs: PhaseCosts = MEASURED_PHASE_COSTS): number {
  return costs.fixedSeconds + Math.max(0, queries) * secondsPerQuery(costs) + costs.tailSeconds
}

/**
 * The largest query budget whose run finishes inside `seconds`.
 *
 * FLOORED AT ONE, NEVER ZERO. A budget of zero is a sweep that buys nothing
 * and returns an empty map, which reads to a visitor as a quiet market rather
 * than as a host too small to map anything — the same confusion this whole
 * module exists to end. A host whose clock cannot pay for the fixed phases
 * will fail whatever this returns; it should fail loudly, having bought one
 * query, not silently having bought none.
 *
 * Not rounded up. Every coefficient above is a median and half the runs are
 * slower than their median, so the last query that "just fits" is the one that
 * does not.
 */
export function queriesThatFit(seconds: number, costs: PhaseCosts = MEASURED_PHASE_COSTS): number {
  const variable = seconds - costs.fixedSeconds - costs.tailSeconds
  return Math.max(1, Math.floor(variable / secondsPerQuery(costs)))
}
