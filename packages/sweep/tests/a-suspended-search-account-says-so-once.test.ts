import { describe, it, expect, beforeAll } from "vitest"
import { runFixture, type Harness } from "./fixture.js"

/**
 * `sweep.ts`'s `serpSuspendedSaid` branch (added in e2e7ba3, measured on
 * `runs/sweep-cursor-com-20260823064255.json`: 18 of the last 19 queries lost
 * to "Account is suspended" and the terminal never said so once) had never
 * run. `vitest run --coverage` puts it at 0%: `FakeSearch`'s `failing` option
 * always reports the same fixed "search provider refused this query" text,
 * which `/suspended/i` never matches, so every existing `failing`-query test
 * exercises the generic `serpFailures` tally and none reaches the announcement
 * three lines below it. `FakeSearch` gained a `failingErrors` override (and
 * the fixture harness a `failingWith` passthrough) so this test can put a
 * real suspension reason on the wire without touching what any other test
 * already asserts.
 */
describe("a search provider that reports a suspended account", () => {
  let h: Harness
  const REASON = "Account is suspended"

  beforeAll(async () => {
    h = await runFixture({
      failing: ["log search", "log search alternatives"],
      failingWith: { "log search": REASON, "log search alternatives": REASON },
    })
  }, 30_000)

  it("says so once, naming the reason, not once per failed query", () => {
    const said = h.says.filter((s) => s.includes("SEARCH PROVIDER REFUSED"))
    expect(said).toHaveLength(1)
    expect(said[0]).toBe(`SEARCH PROVIDER REFUSED: ${REASON} — every search from here will fail the same way`)
  })

  it("still tallies both failures under the one reason", () => {
    const failed = (h.result.report.serp as { failed: Record<string, number> }).failed
    expect(failed[REASON]).toBe(2)
  })

  it("survives the outage: the hosts findable through other queries still land", () => {
    // "log search" and "log search alternatives" are two of several routes to
    // grepstack.example and tailwatch.example — "log management" and
    // "log management alternatives" reach them too — so losing the first pair
    // to a suspended account costs nothing the rest of the run cannot recover.
    expect(h.result.entities.length).toBeGreaterThan(0)
  })
})
