import { describe, it, expect } from "vitest"
import { SERP, runFixture } from "./fixture.js"

/**
 * THE MAP HAS A SIZE, NOT JUST A CLOCK.
 *
 * `maxHosts` (HOST_CEILING, sweep.ts:1700, `Math.max(50, Math.floor(opts.maxHosts ?? 900))`)
 * is its own doc comment's "A SIZE CHOICE, NOT AN EXHAUSTION POINT" — on a
 * large anchor it is the binding stop on the whole search (shopify.com
 * planned 373 queries and fired 147 before the ceiling ended it), and the
 * comment argues at length, with measured per-bucket yield, against ever
 * raising it casually. `grep -rn 'maxHosts\|HOST_CEILING' packages/sweep/tests/`
 * before this file matched nothing: the mechanism that comment defends had
 * zero coverage of its own, in either place it is read.
 *
 * IT IS READ IN TWO PLACES AND ONLY ONE IS REACHABLE. Every search worker
 * checks `hostsSeen.size >= HOST_CEILING` after each result lands
 * (sweep.ts:4266) and seals the run the instant it crosses; the widening
 * decision has its own, later recheck of the same ceiling before planning
 * another round (sweep.ts, just above that recheck). Below drives the worker
 * check, the one a real host stream reaches first. This file originally left
 * the widening-side recheck as "a narrower, likely-unreachable item for
 * whoever next has a reason to prove otherwise" — it is now proven, not just
 * observed dead: the comment sitting directly above that recheck in
 * sweep.ts walks the microtask/macrotask ordering that makes it structurally
 * unreachable, the same treatment this codebase already gives every other
 * proven-dead branch.
 */
describe("the map stops growing once it is the size it was sized for", () => {
  /** Distinct hosts nobody has seen, so a widening round clears the yield
   *  floor on its own and the ceiling is the only rule that can stop it. */
  const strangers = (round: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://w${round}-${i}.example/`,
      title: `stranger ${round}-${i}`,
      description: "a host this run had not seen",
    }))

  /** A planner that always wants five more, so nothing but the ceiling stops it. */
  const greedy = {
    assess: (round: number) => ({
      enough: false,
      missing: "the substitutes are thin",
      draw: [],
      queries: Array.from({ length: 5 }, (_, i) => ({
        q: `widening question ${round}-${i}`,
        intent: "pain",
        platform: "web",
        why: "aimed at the gap the last round named",
        market: "log search",
      })),
    }),
  }

  /** SERP rows for everything `greedy` can propose across two rounds, each
   *  returning ten unseen hosts so the yield floor never fires first. */
  const greedySerp = () => {
    const extra: Record<string, ReturnType<typeof strangers>> = {}
    for (let round = 1; round <= 2; round++) {
      for (let i = 0; i < 5; i++) extra[`widening question ${round}-${i}`] = strangers(round * 10 + i, 10)
    }
    return { ...SERP, ...extra }
  }

  it("seals mid-round the instant hostsSeen crosses the ceiling, and says so by name", async () => {
    // 50 is the floor (Math.max(50, ...)) — the smallest ceiling any caller
    // can ask for. The fixture's own opening lands 6 hosts; one round of the
    // greedy planner's five queries adds 50 more, crossing it at 56.
    const h = await runFixture({
      script: greedy,
      serp: greedySerp(),
      sweepOptions: { maxHosts: 50, minNewHosts: 1, maxWaves: 4, concurrency: 20 },
    })

    expect(h.result.report.hosts).toBe(56)
    expect(
      h.says.some((s) =>
        /stopping the search: 56 distinct hosts is past this run's sizing of ~50 — the rest of the clock belongs to judging them/.test(
          s,
        ),
      ),
    ).toBe(true)
    // Round 1's five queries were already taken from the queue before any
    // worker could observe the crossing, so all five fire; a second round is
    // never even planned.
    expect(h.asked.filter((q) => q.startsWith("widening question")).length).toBe(5)
  }, 30_000)

  it("the same greedy planner, uncapped, keeps widening past 56 — so the ceiling is what stopped it", async () => {
    // THE CONTROL, same shape as sweep-fits-the-clock-it-was-given's: without
    // it, everything above is satisfiable by a run that happened to stop for
    // one of the four ordinary reasons (sweep-stops-when-it-stops-paying)
    // and never saw a size ceiling at all.
    const h = await runFixture({
      script: greedy,
      serp: greedySerp(),
      sweepOptions: { minNewHosts: 1, maxWaves: 2, concurrency: 20 },
    })
    expect(h.result.report.hosts).toBe(106)
    expect(h.asked.filter((q) => q.startsWith("widening question")).length).toBe(10)
  }, 30_000)
})
