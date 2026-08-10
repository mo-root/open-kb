import { describe, it, expect, beforeAll } from "vitest"
import {
  PRICING,
  USD_PER_MODEL_CALL,
  USD_PER_SEARCH,
  costOf,
  lineOf,
  runFixture,
  type CostLine,
  type Harness,
} from "./fixture.js"

/**
 * THE BILL, checked against an oracle that is not the bill.
 *
 * `report.cost` is the number a reader trusts and the number a deployment's
 * ceiling is enforced against, and it is accumulated as the run spends rather
 * than reconstructed afterwards — deliberately, because the trace is capped for
 * display and a reconstruction from it would under-report a wide sweep. That
 * design has one hazard: an accumulator can only ever be wrong quietly, because
 * nothing downstream knows what the run should have cost.
 *
 * So the arithmetic here comes from somewhere else entirely. The mock model
 * counts its own calls and prices every one identically ($2 at the fixture's
 * rates); `FakeSearch` charges a flat tenth of a cent per query it answered and
 * nothing for one it refused; a direct fetch is free. Multiply, add, compare. A
 * test that recomputed `usdFor()` would agree with the engine about a shared
 * mistake — this one cannot.
 *
 * The second check is that the run's two independent accumulations agree. The
 * SPAN LOG (what a viewer is shown) and the BILL (`byKind`/`byAgent`) are
 * filled side by side at each call site but by different code, and a phase that
 * emits a span without billing, or bills without emitting, is invisible in
 * either one alone.
 */
describe("what the run says it spent", () => {
  let h: Harness
  const modelCalls = () => h.calls.length
  /** Queries the port answered. Equal to `asked` here because nothing in this
   *  run is refused; the refusal case lives in the ports suite. */
  const okSearches = () => h.asked.length

  beforeAll(async () => {
    h = await runFixture({ sweepOptions: { ceilingUsd: 12.5 } })
  }, 30_000)

  it("charges exactly the model calls it made and the searches it bought, and nothing for a free fetch", () => {
    const expected = modelCalls() * USD_PER_MODEL_CALL + okSearches() * USD_PER_SEARCH
    expect(h.result.stats.usd).toBeCloseTo(expected, 9)
    expect(h.result.report.usd).toBeCloseTo(expected, 9)
    expect(costOf(h.result).usd).toBeCloseTo(expected, 9)

    const byKind = costOf(h.result).byKind
    expect(lineOf(byKind, "llm").calls).toBe(modelCalls())
    expect(lineOf(byKind, "llm").usd).toBeCloseTo(modelCalls() * USD_PER_MODEL_CALL, 9)
    expect(lineOf(byKind, "serp").calls).toBe(okSearches())
    expect(lineOf(byKind, "serp").usd).toBeCloseTo(okSearches() * USD_PER_SEARCH, 9)
    // Free, and still counted. A phase that costs nothing but takes wall clock
    // is exactly the phase a reader wants to find on the bill.
    expect(lineOf(byKind, "fetch").usd).toBe(0)
    expect(lineOf(byKind, "fetch").calls).toBeGreaterThan(0)
  })

  it("counts the tokens it was told about, at the price it was given", () => {
    expect(h.result.stats.tokIn).toBe(modelCalls() * 1_000)
    expect(h.result.stats.tokOut).toBe(modelCalls() * 250)
    expect(costOf(h.result).tokens).toBe(modelCalls() * 1_250)
    // The same total reached through the price table rather than the per-call
    // constant. This is what catches an input/output rate swap, which a flat
    // per-call figure cannot see: output is priced four times input here, as it
    // is roughly six times input in the real table.
    const priced =
      (h.result.stats.tokIn / 1e6) * PRICING.inUsdPerM + (h.result.stats.tokOut / 1e6) * PRICING.outUsdPerM
    expect(priced).toBeCloseTo(modelCalls() * USD_PER_MODEL_CALL, 9)
  })

  it("takes the total AFTER the linking phase, which is real spend", () => {
    // The snapshot used to be taken before linking and under-reported every
    // run's cost by 14-24%. The oracle above already includes the link call's
    // $2, because the mock served it — so moving `const usd = ...` back above
    // the link block puts this suite $2 out. That is the only way the
    // regression is visible from outside the engine.
    const byAgent = costOf(h.result).byAgent
    expect(lineOf(byAgent, "link").calls).toBe(1)
    expect(lineOf(byAgent, "link").usd).toBeCloseTo(USD_PER_MODEL_CALL, 9)
    expect(h.calls.filter((c) => c.phase === "link")).toHaveLength(1)
  })

  it("groups the same spend two ways without the two disagreeing", () => {
    const cost = costOf(h.result)
    const sum = (rows: CostLine[]) => ({
      usd: rows.reduce((n, l) => n + l.usd, 0),
      calls: rows.reduce((n, l) => n + l.calls, 0),
      failures: rows.reduce((n, l) => n + l.failures, 0),
    })
    const kind = sum(cost.byKind)
    const agent = sum(cost.byAgent)
    // `bill()` writes both maps from one call site, so a drift means some path
    // fills only one of them — and the cost readout on screen reads `byKind`
    // while the per-agent breakdown beside it reads the other.
    expect(agent.usd).toBeCloseTo(kind.usd, 12)
    expect(agent.calls).toBe(kind.calls)
    expect(agent.failures).toBe(kind.failures)
    expect(cost.calls).toBe(kind.calls)
  })

  it("emits a span for every billed call, priced the same on both", () => {
    // `ui:` spans are narration and carry no cost, which is what keeps the
    // counts on screen equal to the calls actually bought.
    const work = h.spans.filter((s) => !s.name.startsWith("ui:"))
    const billed = costOf(h.result).byKind.reduce((n, l) => n + l.calls, 0)
    expect(work).toHaveLength(billed)
    expect(work.reduce((n, s) => n + s.usd, 0)).toBeCloseTo(h.result.stats.usd, 9)
    expect(work.filter((s) => s.kind === "model")).toHaveLength(modelCalls())
    expect(work.filter((s) => s.kind === "search")).toHaveLength(okSearches())
  })

  it("counts a SERP request per page, and reports the ceiling it was given", () => {
    // The counter has to multiply by `pages`: a run reading three pages per
    // query buys three requests and gets back one `SearchResult`. The fixture
    // runs at two, so a counter that forgot the multiplier halves this.
    expect(h.result.stats.serpCalls).toBe(okSearches() * 2)
    expect(h.result.stats.unlockerCalls).toBe(0)
    // Null on the CLI, a real number from the web route. A hardcoded null here
    // used to claim the engine has no ceiling while the deployment enforced one.
    expect(costOf(h.result).ceilingUsd).toBe(12.5)
  })
})
