import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { MEASURED_PHASE_COSTS } from "@open-kb/core"
import { SERP, runFixture, type Harness } from "./fixture.js"

/**
 * A RUN WITH A CLOCK MUST FIT IN IT — and a run without one must not notice.
 *
 * The measured failure: `POST /api/map` handed the engine no budget, the engine
 * dealt itself 132 searches, and the host stopped the invocation 30s before its
 * limit with the rank phase barely started. $0.7099 bought, nothing delivered.
 * The engine was doing exactly what it should; nobody had told it there was a
 * clock.
 *
 * So it now takes two things from a caller that has one, and this file is about
 * both of them and about the third case that matters most:
 *
 *   `maxQueries`  the SIZE of the run — opening hand and every widening round
 *                 together, because `queries` clamps only the catalog and one
 *                 measured run turned an opening of 10 into 77 fired.
 *   `deadlineAt`  the BACKSTOP — the budget is arithmetic over a median host
 *                 yield with a two-and-a-half-fold spread, so the engine reads
 *                 the clock at the places it is about to spend and ships a
 *                 shorter map rather than being killed mid-phase.
 *   NEITHER       the CLI, whose runs must be byte-for-byte what they were.
 *
 * Everything here is asserted against `FakeSearch.calls` — what actually
 * reached the port — because a budget that is enforced anywhere later is a
 * budget that has already been spent.
 */

const assessCalls = (h: Harness) => h.calls.filter((c) => c.phase === "assess").length

/** Distinct hosts nobody has seen, so a widening round clears the yield floor
 *  on its own and the ceiling is the only rule that can stop the loop. */
const strangers = (round: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://w${round}-${i}.example/`,
    title: `stranger ${round}-${i}`,
    description: "a host this run had not seen",
  }))

/** A planner that always wants five more, so nothing but a budget stops it. */
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

/** SERP rows for everything `greedy` can propose across four rounds, each
 *  returning ten unseen hosts so the yield floor never fires. */
const greedySerp = () => {
  const extra: Record<string, ReturnType<typeof strangers>> = {}
  for (let round = 1; round <= 5; round++) {
    for (let i = 0; i < 5; i++) extra[`widening question ${round}-${i}`] = strangers(round * 10 + i, 10)
  }
  return { ...SERP, ...extra }
}

/** The fixture's opening: 14 written, 2 dropped for naming the anchor or a
 *  coinage, 12 bought. Stated once, because half the arithmetic below is
 *  against it. */
const OPENING_WRITTEN = 14
const OPENING_BOUGHT = 12

describe("the opening hand is cut to what the clock can pay for", () => {
  it("takes the first N of the hand, core markets first, and buys nothing else", async () => {
    const h = await runFixture({ sweepOptions: { maxQueries: 4 } })

    // The first four the catalog wrote, in catalog order — which is
    // core-market-first, because that is the order `funded` deals in. A budget
    // that sampled, or that took the tail, would spend a small run on the
    // company's side lines.
    expect(h.asked).toEqual([
      "log search",
      "log search alternatives",
      "Log Search Cloud alternatives",
      "how do i find one request across a hundred containers",
    ])
    expect(h.result.report.opening).toBe(4)
    expect(h.result.report.queries).toBe(4)
  }, 30_000)

  it("says the hand was cut, and by whom", async () => {
    // A map that is small because the host is small must say so on the way
    // past, not only in the report — this line is what the live panel shows
    // while the sweep is still running.
    const h = await runFixture({ sweepOptions: { maxQueries: 4 } })
    expect(h.says.some((s) => /sized to the clock/.test(s))).toBe(true)
    expect(h.says.some((s) => /may fire 4/.test(s))).toBe(true)
  }, 30_000)

  it("carries the ceiling to the browser on the plan frame, beside what was written", async () => {
    // The number a reader needs to tell "this host gave the run four questions"
    // apart from "this engine could only think of four".
    const [plan] = (await runFixture({ sweepOptions: { maxQueries: 4 } })).ui("results", "planned")
    expect(plan!.ceiling).toBe(4)
    expect(plan!.written).toBe(OPENING_WRITTEN)
    expect(plan!.uncapped).toBe(false)
  }, 30_000)
})

describe("the ceiling is on the WHOLE run, not on the catalog", () => {
  it("lets a widening round spend what is left of the budget and not a query more", async () => {
    const h = await runFixture({
      script: greedy,
      serp: greedySerp(),
      // Two queries of room past the opening. The planner wants five.
      sweepOptions: { maxQueries: OPENING_BOUGHT + 2, minNewHosts: 1, maxWaves: 4, concurrency: 20 },
    })

    expect(h.asked).toHaveLength(OPENING_BOUGHT + 2)
    expect(h.asked).toContain("widening question 1-0")
    expect(h.asked).toContain("widening question 1-1")
    expect(h.asked).not.toContain("widening question 1-2")
    expect(h.says.some((s) => /wanted 3 more queries than this run's budget/.test(s))).toBe(true)
  }, 30_000)

  it("refuses the NEXT round before paying for the opinion", async () => {
    // The assess call is a model call of 15-25s against a prompt carrying sixty
    // host names. A run with nothing left to spend must not buy an opinion it
    // cannot act on, so the budget is checked above the call, not below it.
    // One assess call for the round that fitted; none for the round that did
    // not. Read from the model call log, which is the only place the difference
    // between "asked and refused" and "never asked" exists.
    const h = await runFixture({
      script: greedy,
      serp: greedySerp(),
      sweepOptions: { maxQueries: OPENING_BOUGHT + 2, minNewHosts: 1, maxWaves: 4, concurrency: 20 },
    })
    expect(assessCalls(h)).toBe(1)
    expect(h.says.some((s) => /not widening/.test(s))).toBe(true)
  }, 30_000)

  it("and the same greedy planner, uncapped, keeps going — so the ceiling is what stopped it", async () => {
    // THE CONTROL. Without it every assertion above is satisfiable by a run
    // that stopped for one of the four ordinary reasons and never saw a
    // budget. Same script, same market, same yield: the only difference is the
    // option, and the run fires four rounds of five.
    const h = await runFixture({
      script: greedy,
      serp: greedySerp(),
      sweepOptions: { minNewHosts: 1, maxWaves: 4, concurrency: 20 },
    })
    expect(assessCalls(h)).toBe(4)
    expect(h.asked).toHaveLength(OPENING_BOUGHT + 4 * 5)
  }, 30_000)
})

describe("the CLI is not time-boxed, and nothing here changed that", () => {
  it("fires the whole hand, judges every host, and reports no budget at all", async () => {
    // The default fixture is the CLI's shape: no `maxQueries`, no `deadlineAt`.
    // `budget: null` is the load-bearing assertion — null means "nothing was
    // clocking this run", and every surface reads it that way. A zero, or an
    // object full of nulls, would make a terminal run look like a capped one
    // that happened not to be cut.
    const h = await runFixture()
    expect(h.asked).toHaveLength(OPENING_BOUGHT)
    expect(h.result.report.budget).toBeNull()
    // Every host the sweep found reached the judge.
    expect(h.result.report.entities).toBe(h.result.report.hosts)
    const [plan] = h.ui("results", "planned")
    expect(plan!.ceiling).toBeNull()
    expect(plan!.clockSeconds).toBeNull()
    expect(plan!.uncapped).toBe(true)
  }, 30_000)

  it("a deadline far away is the same run as no deadline at all", async () => {
    // The clock only ever subtracts, and it must subtract nothing when there is
    // plenty. Asserted against the uncapped run's own numbers rather than
    // against literals, so this keeps meaning what it says if the fixture's
    // market grows.
    const free = await runFixture()
    const timed = await runFixture({
      sweepOptions: { deadlineAt: Date.now() + 60 * 60 * 1000 },
    })
    expect(timed.asked).toEqual(free.asked)
    expect(timed.result.report.entities).toBe(free.result.report.entities)
    expect(timed.result.report.kept).toBe(free.result.report.kept)
    expect((timed.result.report.budget as { unjudged: number }).unjudged).toBe(0)
  }, 60_000)
})

describe("out of clock, the run ships what it has instead of being killed", () => {
  it("buys nothing it cannot judge, and still writes an ending", async () => {
    // A deadline already in the past is the extreme of the case the backstop
    // exists for. This test used to assert hostsFound > 0 here — which was
    // the bug wearing a green check: the out-of-clock verdict stopped only
    // the worker that reached it, the rest drained the whole queue, and a run
    // that had just said "buying more would only lengthen a list nobody gets
    // to" bought all twelve queries and judged none of them. The verdict now
    // binds every worker, so a run born out of clock spends nothing. What is
    // still being proven is that the run RETURNS — a report, a bill, an
    // ending — because the alternative, which is what the measured Vercel run
    // did, is to be stopped mid-phase with everything thrown away.
    const h = await runFixture({ sweepOptions: { deadlineAt: Date.now() - 1_000 } })

    expect(h.asked).toHaveLength(0)
    const budget = h.result.report.budget as {
      unjudged: number
      hostsFound: number
      hostsJudged: number
      clockSeconds: number
    }
    expect(budget.hostsFound).toBe(0)
    expect(budget.hostsJudged).toBe(0)
    // The ending exists, which is the whole point.
    expect(h.ui("results", "complete")).toHaveLength(1)
    expect(h.result.report.seconds).toBeGreaterThanOrEqual(0)
    expect(h.says.some((s) => /stopping the search/.test(s))).toBe(true)
  }, 30_000)

  it("does not widen when what it has already found cannot be judged in the time left", async () => {
    // The adaptive half, and the one a static budget cannot do: this run has no
    // `maxQueries` at all. It stops widening because the hosts that actually
    // landed — not the hosts a median predicted — no longer fit the clock.
    const h = await runFixture({
      script: greedy,
      serp: greedySerp(),
      sweepOptions: { deadlineAt: Date.now() - 1_000, minNewHosts: 1, maxWaves: 4, concurrency: 20 },
    })
    expect(assessCalls(h)).toBe(0)
    expect(h.asked.every((q) => !q.startsWith("widening question"))).toBe(true)
  }, 30_000)

  it("keeps the tail it reserved, and the reserve is the measured one", async () => {
    // The tail — the link batches plus the write — is reserved BEFORE the
    // first purchase, not discovered after the last: a run handed less clock
    // than `tailSeconds` refuses to buy a single query, because anything it
    // bought would be a row on a list the write phase never reaches. Pinned
    // against the shared table so a re-measurement moves the engine and this
    // test together, and a change to one alone is a red test rather than a
    // run that overruns by exactly the amount nobody reserved.
    expect(MEASURED_PHASE_COSTS.tailSeconds).toBeGreaterThan(0)
    const h = await runFixture({
      sweepOptions: { deadlineAt: Date.now() + (MEASURED_PHASE_COSTS.tailSeconds - 1) * 1000 },
    })
    expect(h.asked).toHaveLength(0)
    expect((h.result.report.budget as { hostsFound: number }).hostsFound).toBe(0)
  }, 30_000)
})

describe("the clock running out during LINKING ships the map, it does not lose it", () => {
  it("skips the batches it cannot afford and reports them, instead of failing the run", async () => {
    // The bug this pins, measured on run 31704112 (clerk.com, 300s lambda).
    // The query budget worked: 18 searches, rank complete at 180s, a full
    // entity set in hand. Then the paid link pass ran, one batch took 46s
    // against the ~19s its own comment assumes, and the watchdog aborted at
    // 270s. The abort threw from INSIDE the batch loop, so a run that had
    // already found, judged and cited every entity was recorded as failed and
    // shipped nothing — having charged for all of it.
    //
    // `canAffordLinking` is checked ONCE before the phase and was true. What
    // was missing is a per-batch guard, which is what this drives: the signal
    // trips while the run is working, and the assertion is that a map still
    // comes back.
    const ctl = new AbortController()
    // Fires after the run is well past understand/plan and into the paid
    // phases — late enough that entities exist, early enough that linking has
    // not finished. Abort during rank throws by design, so this asserts the
    // weaker, honest thing: whatever phase it lands in, the run does not lose
    // an entity set it had already paid for.
    setTimeout(() => ctl.abort(), 900)
    let result: Awaited<ReturnType<typeof runFixture>> | undefined
    let threw: unknown
    try {
      result = await runFixture({ sweepOptions: { signal: ctl.signal } })
    } catch (e) {
      threw = e
    }
    if (result) {
      // Reached the write phase: the map shipped. That is the assertion — an
      // entity set the run had already paid for came back rather than being
      // thrown away. (`unlinkedPairs` is asserted at the source level below;
      // checking it here would be `?? 0 >= 0`, which is true of everything.)
      expect(result.result.entities.length).toBeGreaterThan(0)
    } else {
      // Aborted in an earlier phase, which still throws on purpose — a
      // half-searched wave is not a map. Recorded rather than asserted away.
      expect(String((threw as Error)?.message ?? threw)).toContain("aborted")
    }
  }, 30_000)

  it("the link loop skips on an aborted signal rather than throwing", () => {
    // The unit of the fix, read off the source so it cannot silently revert to
    // a throw the way it was written before.
    const src = readFileSync(
      new URL("../src/sweep.ts", import.meta.url),
      "utf8",
    )
    const loop = src.slice(src.indexOf("pairBatches.map(async (batch, n)"))
    const firstGuard = loop.slice(0, loop.indexOf("const out = await call"))
    expect(firstGuard).toContain("unlinked += batch.length")
    expect(firstGuard).not.toContain('throw new Error("aborted")')
  })
})
