import { describe, it, expect } from "vitest"
import { runFixture } from "./fixture.js"

/**
 * `opts.queries` IS NOT `opts.maxQueries`, and until now nothing had ever set
 * it to a number. `maxQueries` bounds the whole run (opening hand plus every
 * widening round); `queries` is the older, narrower knob `scripts/sweep.ts`
 * passes on every CLI invocation (`queries: TARGET`, line 222, `TARGET` is
 * `undefined` unless a caller typed a positional argument) to clamp just the
 * OPENING catalog for a bounded probe. Every sweep test on disk either leaves
 * it unset or passes `queries: []`/`queries: [...]` as a catalog mock's own
 * field — grepping every test file for a numeric `sweepOptions: { queries:
 * N }` found none. Measured with a temporary `@vitest/coverage-v8@4.1.11`
 * devDependency (matched this repo's vitest, reverted before finishing, same
 * move as SELF-509/593/596/597): `sweep.ts`'s two `say()` branches that react
 * to a clamp (sweep.ts:3858-3867, "using the first N" / "wrote M of N asked
 * for") had zero invocations, part of a line-coverage drop from SELF-509's
 * measured 98.3% to 97.3% in the month since.
 *
 * The default fixture's two products write 16 queries total (pinned as
 * `OPENING_WRITTEN` in sweep-fits-the-clock-it-was-given.test.ts), so a
 * budget below and above that count exercises both arms.
 */
describe("a numeric opts.queries clamps the opening catalog and reports the clamp", () => {
  it("over budget: truncates to the budget and says the catalog ran long", async () => {
    const h = await runFixture({ sweepOptions: { queries: 10 } })
    expect(
      h.says.some((s) => s === "catalog: model wrote 16 for a budget of 10 — using the first 10"),
    ).toBe(true)
    const [plan] = h.ui("results", "planned")
    expect(plan!.written).toBe(16)
    expect(plan!.requested).toBe(10)
  })

  it("under budget: keeps the shorter catalog and says the model wrote less than asked", async () => {
    const h = await runFixture({ sweepOptions: { queries: 20 } })
    expect(
      h.says.some((s) => s === "catalog: model wrote 16 of the 20 asked for"),
    ).toBe(true)
    const [plan] = h.ui("results", "planned")
    expect(plan!.written).toBe(16)
    expect(plan!.requested).toBe(20)
    // Nothing clamped here — the model wrote fewer than the budget — so the
    // catalog's own natural ban-drop count survives untouched, the same 14
    // `sweep-buys-the-hand-it-was-dealt.test.ts` pins for the unset-queries case.
    expect((plan!.queries as unknown[]).length).toBe(14)
  })

  it("exactly on budget: neither message fires", async () => {
    const h = await runFixture({ sweepOptions: { queries: 16 } })
    expect(h.says.some((s) => s.startsWith("catalog: model wrote"))).toBe(false)
  })
})
