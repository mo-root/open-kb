import { describe, it, expect } from "vitest"
import { runFixture, HOSTS, type Harness, type LinkPair } from "./fixture.js"

/**
 * A PAID SLOT SPENT ON A QUESTION A PAGE HAD ALREADY ANSWERED IS A SLOT SPENT
 * ON NOTHING.
 *
 * The selector ranked the co-occurring pairs, cut the list to `maxPairs`, and
 * only THEN subtracted the pairs the free naming pass had resolved for nothing.
 * The strongest pairs are exactly the ones a page is most likely to have named
 * outright, so the cap kept them, the subtraction dropped them, and the pairs
 * that qualified and would have fitted were never asked — nor counted, nor
 * reported, anywhere.
 *
 * MEASURED corpus-wide: 1,624 of 14,748 paid slots (11.0%) went that way, the
 * cap binds on 21 of 28 runs, and 51,919 of 66,667 qualifying pairs were
 * truncated with no counter to say so.
 *
 * The market below is three vendors and a cap of one. The strongest pair is the
 * one a page names, so under the old order the single paid slot bought nothing
 * at all.
 */

const hit = (host: string, title: string, description: string) => ({
  url: `https://${host}/`,
  title,
  description,
})

/** (grepstack, tailwatch) co-occurs three times and grepstack's own snippet
 *  names Tailwatch, so the free pass answers it. (grepstack, loglens) and
 *  (tailwatch, loglens) co-occur twice each — the floor — and no page names
 *  anyone, so they are what a paid slot is for. */
const serp = {
  "log search": [
    hit(HOSTS.grepstack, "Grepstack", "Buyers weigh us against Tailwatch on price per gigabyte."),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
    hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
  ],
  "log search alternatives": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search."),
    hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks."),
    hit(HOSTS.loglens, "Loglens", "A year of logs, priced on ingest."),
  ],
  "uptime monitoring": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search."),
    hit(HOSTS.tailwatch, "Tailwatch", "Checks from nine regions."),
  ],
}

/** A budget is only reported when something was clocking or capping the run,
 *  and `truncatedPairs` lives beside `unlinkedPairs` inside it. */
const budgetOf = (h: Harness) =>
  h.result.report.budget as { truncatedPairs: number; unlinkedPairs: number }

const run = async (maxPairs: number) => {
  const seen: LinkPair[] = []
  const h = await runFixture({
    serp,
    sweepOptions: { maxPairs, maxQueries: 40 },
    script: { link: (pairs) => (seen.push(...pairs), { edges: [] }) },
  })
  return { h, seen }
}

const isPair = (p: LinkPair, a: string, b: string) =>
  (p.a === a && p.b === b) || (p.a === b && p.b === a)

describe("one paid slot and three qualifying pairs", () => {
  it("buys the strongest pair no page had already answered", async () => {
    const { h, seen } = await run(1)
    expect(h.calls.filter((c) => c.phase === "link")).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(
      isPair(seen[0]!, HOSTS.grepstack, HOSTS.tailwatch),
      "the one paid slot was spent re-asking a pair the free naming pass had already resolved",
    ).toBe(false)
    // It is one of the two the free pass could not answer, and both of those
    // involve loglens.
    expect(seen[0]!.a === HOSTS.loglens || seen[0]!.b === HOSTS.loglens).toBe(true)
  }, 30_000)

  it("says what the cap cost, and reports it beside the pairs the clock cost", async () => {
    const { h } = await run(1)
    expect(h.says.some((s) => /1 of 3 pairs already answered by a page/.test(s))).toBe(true)
    const said = h.says.find((s) => /leaving 1 unasked/.test(s))
    expect(said, "the cap truncated a qualifying pair and the run never said so").toBeDefined()
    expect(budgetOf(h).truncatedPairs).toBe(1)
    // The other two facts about an incomplete linking pass are untouched: this
    // is neither the clock running out mid-flight nor the phase declined.
    expect(budgetOf(h).unlinkedPairs).toBe(0)
  }, 30_000)

  it("truncates nothing, and says nothing, when the cap is not the binding constraint", async () => {
    // The control. With room for every open pair the count is a zero rather
    // than a sentence — and the pair a page answered is still not bought,
    // which was true before this change and has to stay true.
    const { h, seen } = await run(600)
    expect(seen).toHaveLength(2)
    expect(seen.some((p) => isPair(p, HOSTS.grepstack, HOSTS.tailwatch))).toBe(false)
    expect(budgetOf(h).truncatedPairs).toBe(0)
    expect(h.says.some((s) => /unasked/.test(s))).toBe(false)
  }, 30_000)
})
