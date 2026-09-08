import { describe, it, expect } from "vitest"
import { runFixture, type Harness } from "./fixture.js"

/**
 * sweep.ts:6779-6791 documents the fix this pins: a link batch that fails for
 * ANY reason other than an aborted signal — "a call the deadline stopped
 * after its retry, a provider 500, a schema the model would not fill" — used
 * to throw out of `runPairBatch` and fail the whole sweep. Measured there:
 * figma.com died at batch 412 of 492 having already produced 1,444 entities
 * and 411 batches of edges, and wrote none of it. The catch block at
 * sweep.ts:6810-6817 is the fix — count the batch as `unlinked` and move on —
 * and it is the one this file drives.
 *
 * It had never run. `vitest run --coverage` puts sweep.ts:6811-6817 at 0%: the
 * fixture's default `script.link` always resolves, and the only existing test
 * anywhere near this code (sweep-fits-the-clock-it-was-given.test.ts, "the
 * link loop skips on an aborted signal rather than throwing") pins the OTHER
 * guard — the `signal?.aborted` branch just above it, at sweep.ts:6775-6778 —
 * and does so by reading the guard's own source text rather than by forcing a
 * batch to fail, for a reason that test states directly: an abort fires on a
 * timer racing the run's own phases, so which phase is mid-flight when it
 * lands is not controllable, and checking `unlinkedPairs` there would be `??
 * 0 >= 0`, true of everything. A batch failure has no such race — `script.link`
 * throwing is deterministic — so this drives the actual behavior end to end
 * instead of pinning source text.
 */
describe("a link batch that fails for a reason other than abort", () => {
  const run = () =>
    runFixture({
      // maxQueries is set only because `report.budget` — and the `unlinkedPairs`
      // counter inside it — is null on an unclocked, uncapped run (sweep.ts:7571).
      sweepOptions: { maxQueries: 40 },
      script: {
        link: () => {
          throw new Error("simulated link provider failure")
        },
      },
    })

  const budgetOf = (h: Harness) => h.result.report.budget as { unlinkedPairs: number } | null

  it("does not throw, and counts the whole batch as unlinked rather than losing the run", async () => {
    const h = await run()
    expect(budgetOf(h)?.unlinkedPairs).toBeGreaterThan(0)
  }, 30_000)

  it("says which batch failed and why, the same sentence a human reads off the log", async () => {
    const h = await run()
    expect(h.says.some((s) => s.includes("batch 1 of 1 produced no edges: simulated link provider failure"))).toBe(true)
  }, 30_000)

  it("still ships the entities and the edges the free naming pass already found", async () => {
    const h = await run()
    // The paid link phase is the ONLY source of a failure here — the fixture's
    // default script still has a page name a rival outright, and that edge is
    // found by the free pass before the paid one ever runs (sweep.ts's own
    // "edges from pages that name another player outright"), so it survives a
    // paid batch that failed entirely.
    expect(h.result.entities.length).toBeGreaterThan(0)
    expect(h.result.edges?.length).toBeGreaterThan(0)
  }, 30_000)
})
