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
   * The pool width `rankSecondsPerHost` was measured AT. The coefficient is a
   * wall-clock number, so it silently carries the width of the deployment it
   * was measured on — 8 — and a run ranking at a different width must rescale
   * or misprice the whole phase. Measured on two fresh runs at width 24:
   * pool-ms / width / hosts landed on 0.63 x 8 / 24 = 0.21 s/host exactly,
   * while the unscaled table told the same runs to reserve 3x the rank they
   * needed and told the hosted route to size maps at ~40% of what fit.
   */
  rankPoolWidth: number
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
  rankPoolWidth: 8,
  tailSeconds: 30,
  /*
   * RE-MEASURED 2026-08-24 against the first runs carrying `report.phases`,
   * and every term is off — in both directions, which is why the total is
   * closer than the parts:
   *
   *                          here   resend(59q)   cloudflare(165q)
   *   sweepSecondsPerQuery    1.4          2.36               4.35
   *   hostsPerQuery            13           7.6                7.4
   *   rankSecondsPerHost     0.63         0.244              0.277
   *
   * Sweep costs MORE than modelled (the provider's throttle: 28 of resend's
   * 59 queries waited, 1,063s of cumulative pacing). Rank costs less, and
   * fewer hosts arrive per query than assumed. Net, `secondsPerQuery` reads
   * 9.59 here against roughly 4.3-6.3 measured, so the budget is something
   * like 1.5-2x conservative — 18 queries on the web's 270s clock at the
   * default rank width where the measurements suggest 30-40 would fit.
   *
   * THAT ESTIMATE HELD. The first deadline-bound run, at the width this
   * repo's .env actually sets, fit 43 queries into that 270-second clock in
   * 214 seconds. The re-measured figures were the better guide and the
   * shipped model was the conservative one, exactly as this paragraph
   * guessed — which is a reason to trust the table above, not to retune on
   * one run.
   *
   * NOT RETUNED, and the reason is the asymmetry rather than the sample size.
   * Too small a budget costs map size, which degrades gracefully and is the
   * failure this branch measured extensively — top five rivals survive at 18.
   * Too large a budget costs the whole run: a serverless function killed at
   * `maxDuration` returns nothing at all, and the comment on QUERY_BUDGET
   * records that this route once had exactly that bug. Conservative is the
   * correct direction to be wrong in.
   *
   * AND ACROSS ALL 41 RUNS ON DISK IT IS NOT UNIFORMLY CONSERVATIVE, which
   * the three-run reading above missed. Comparing `runSeconds(fired)` against
   * what each run actually took:
   *
   *   over-predicted (safe)   29 of 41
   *   under-predicted         12 of 41
   *   ratio predicted/actual  min 0.42   median 1.44   max 2.36
   *
   * A median of 1.44 says "there is slack". A minimum of 0.42 says one run in
   * three-and-a-half took longer than predicted, and one took nearly two and
   * a half times longer. Raising the budget by the median would put roughly a
   * quarter of runs over their clock — and on a serverless deadline that is
   * not a smaller map, it is no map.
   *
   * So the model is conservative on the typical run and optimistic on the
   * slow tail, and a budget has to survive the tail. The honest conclusion is
   * narrower than "1.5-2x conservative": there is headroom in the middle of
   * the distribution and none at its edge, and the number that matters for a
   * deadline is the edge.
   *
   * `report.clock` on every run now records predicted against actual, so this
   * distribution keeps itself up to date instead of needing a script.
   *
   * THE DOMINANT ERROR IS `fixedSeconds`, and it is the one term that points
   * the dangerous way. Measured from `report.phases`:
   *
   *                understand + plan = fixed        here: 60
   *   cloudflare        184 + 42     = 226
   *   resend             96 +  6     = 102
   *
   * Two to nearly four times the modelled figure. `understand` alone is 96
   * seconds on a clean read and 184 when one of its three asks times out,
   * which e8b3157 capped — before that fix it reached 362.
   *
   * On a long CLI run that is noise against 25 minutes. On the web's 270-second
   * clock it is most of the budget: `270 - 60 - 30` leaves 180 variable seconds
   * and 18 queries, but `270 - 226 - 30` leaves FOURTEEN.
   *
   * WHAT FOLLOWS FROM THAT IS A PREDICTION, NOT A MEASUREMENT, and the
   * distinction is worth keeping because nothing here can currently check it.
   * A run that plans 18 queries from the optimistic figure and then spends 226
   * seconds understanding the company SHOULD seal its search almost at once on
   * the deadline backstop and ship a map built from a couple of queries. All
   * 41 runs on disk have `report.budget: null` — not one is deadline-bound,
   * because the CLI passes no deadline and only the web route does. So the
   * behaviour of a clock-constrained run has never been observed here at all.
   *
   * IT HAS NOW BEEN OBSERVED, AND THE PREDICTION IS REFUTED ON THE ANCHOR
   * TESTED. The first deadline-bound run in this repository — resend.com under
   * `OPENKB_DEADLINE_S=270`, the flag added to make this checkable:
   *
   *   report.budget   maxQueries 43, fired 43, hostsJudged 273, unjudged 0
   *   report.clock    predicted 502s, actual 214s
   *   phases          understand 57s · plan 157s · sweep 52s · rank 87s
   *
   * It did not seal early. It bought every query it was sized for, left no
   * host unjudged, and finished 56 seconds inside its clock. `understand` took
   * 57 seconds, so `fixedSeconds: 60` was accurate here — the 226 that
   * motivated the alarm is cloudflare's, a far larger anchor.
   *
   * So the hazard is real but ANCHOR-DEPENDENT, not general. A slow-understand
   * anchor can still eat a short clock and the failure would still be total;
   * "a web run ships a map built from a couple of queries" was the wrong
   * generalisation, drawn from the wrong anchor's number.
   *
   * TWO CORRECTIONS TRAVEL WITH IT.
   *
   * The 18 above is not what a deployment gets. It assumes the code's default
   * rank width of 8; this repo's own `.env` sets `OPENKB_RANK_CONCURRENCY=24`,
   * which yields 43 — the figure the run actually used. The web budget is a
   * function of a variable neither this file nor the route hardcodes, so any
   * statement of it has to name the width it assumed.
   *
   * And `report.clock` over-predicted by 2.3x on this run, which puts it in
   * the conservative middle of the spread above rather than the tail this
   * paragraph was worried about.
   *
   * That is also the likeliest source of the under-predicting tail above: the
   * runs where actual beat predicted are the runs whose fixed phase ran long.
   * Fixing the term would make the model honest and the WEB BUDGET SMALLER,
   * which is the opposite of the headroom the median suggested — and is why
   * the budget question wants this number, not the median, to decide it.
   */
}

/** Wall seconds to judge `hosts` at the rank pool's width. The engine's own
 *  mid-run question: can what I have already found still be turned into a map
 *  before the host stops me? */
export function rankSeconds(
  hosts: number,
  costs: PhaseCosts = MEASURED_PHASE_COSTS,
  poolWidth: number = costs.rankPoolWidth,
): number {
  const width = Math.max(1, poolWidth)
  return (Math.max(0, hosts) * costs.rankSecondsPerHost * costs.rankPoolWidth) / width
}

/** Wall seconds one more query costs end to end — its own search, plus the
 *  hosts it drags into rank. 1.4 + 13 × 0.63 = 9.6s, of which 85% is rank. */
export function secondsPerQuery(
  costs: PhaseCosts = MEASURED_PHASE_COSTS,
  poolWidth: number = costs.rankPoolWidth,
): number {
  return costs.sweepSecondsPerQuery + rankSeconds(costs.hostsPerQuery, costs, poolWidth)
}

/** Wall seconds a run of `queries` queries takes, fixed phases and tail
 *  included. The inverse of `queriesThatFit`, and the function that says a
 *  132-query run needed about 23 minutes of the 4.5 it was given. */
export function runSeconds(
  queries: number,
  costs: PhaseCosts = MEASURED_PHASE_COSTS,
  poolWidth: number = costs.rankPoolWidth,
): number {
  return costs.fixedSeconds + Math.max(0, queries) * secondsPerQuery(costs, poolWidth) + costs.tailSeconds
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
export function queriesThatFit(
  seconds: number,
  costs: PhaseCosts = MEASURED_PHASE_COSTS,
  poolWidth: number = costs.rankPoolWidth,
): number {
  const variable = seconds - costs.fixedSeconds - costs.tailSeconds
  return Math.max(1, Math.floor(variable / secondsPerQuery(costs, poolWidth)))
}
