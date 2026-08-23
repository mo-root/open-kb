import { describe, it, expect } from "vitest"
import { SERP, HOSTS, runFixture } from "./fixture.js"

/**
 * VARIABLE PAGE DEPTH.
 *
 * Every query opens reading `SHALLOW_PAGES` (2) pages. `assess` is handed a
 * per-product page-2 yield table — computed from `rank`, which is genuinely
 * global across pages now (see `brightdata.ts`'s comment on `global_rank`) —
 * and may name a product whose second page kept finding hosts the first did
 * not. Only that product's queries read `DEEP_PAGES` (4) from then on; a
 * product nobody names, or whose second page only repeated the first, stays
 * shallow for the whole run.
 *
 * Ranked hits for two of the default fixture's own opening-hand queries:
 * "log search" (product "Log Search Cloud") gets a real page-2 yield — page 1
 * keeps one host, page 2 finds two more nothing on page 1 had. "uptime
 * monitoring" (product "Uptime Alerts") gets a flat one — both its hosts sit
 * on page 1, page 2 adds nothing.
 *
 * The FIRST assess call fires while the opening hand's own results are still
 * landing — the planner and the search workers are deliberately concurrent
 * (see the comment above `const queue` in sweep.ts), so round one's prompt
 * cannot be trusted to hold the opening hand's yield yet. Every assertion
 * here reads round TWO's prompt instead, forced by a round-one verdict that
 * widens on something unrelated to either product — the same shape the
 * existing "assess call is told how saturated" test uses for the same
 * reason.
 */
const ranked = (host: string, rank: number) => ({
  url: `https://${host}/`,
  title: host,
  description: "a ranked result",
  rank,
})

const strangers = Array.from({ length: 9 }, (_, i) => ({
  url: `https://widen-${i}.example/`,
  title: `stranger ${i}`,
  description: "a host nobody had seen",
}))

describe("assess deepens a product from its own measured page-2 yield", () => {
  it("reads the deepened product's next query at DEEP_PAGES, and no other product's", async () => {
    const h = await runFixture({
      serp: {
        ...SERP,
        "log search": [
          ranked(HOSTS.grepstack, 3),
          ranked(HOSTS.tailwatch, 15),
          ranked(HOSTS.loglens, 18),
        ],
        "uptime monitoring": [ranked(HOSTS.tailwatch, 2), ranked(HOSTS.forum, 5)],
        "widening query one": strangers,
        // No row for "best log search": the released reserve template is
        // free to fire and add nothing, so the yield floor ends the run
        // right after round two without a third assess call.
      },
      script: {
        assess: (round) =>
          round === 1
            ? {
                enough: false,
                missing: "not about either product — clears the yield floor so round two sees real data",
                draw: [],
                queries: [
                  {
                    q: "widening query one",
                    intent: "pain",
                    platform: "web",
                    why: "unrelated to both products on purpose",
                    market: "log search",
                  },
                ],
              }
            : {
                enough: false,
                missing: "log search's second page keeps paying",
                draw: [{ product: "Log Search Cloud", n: 1 }],
                queries: [],
                deepen: ["Log Search Cloud"],
              },
      },
    })

    const assesses = h.calls.filter((c) => c.phase === "assess")
    expect(assesses).toHaveLength(2)

    // The evidence round two's `deepen` acted on, carried into the prompt as
    // real counts — not asserted from the result, since the whole point is
    // that the model decided from this table rather than from a hunch.
    expect(assesses[1]!.prompt).toContain(
      "Log Search Cloud — page 1: 1 hosts, page 2 added 2 not already on page 1",
    )
    expect(assesses[1]!.prompt).toContain(
      "Uptime Alerts — page 1: 2 hosts, page 2 added 0 not already on page 1",
    )

    // Only the named product moved — `deepen` naming one product must never
    // touch the other's depth.
    const serp = h.result.report.serp as { deepenedProducts: string[] }
    expect(serp.deepenedProducts).toEqual(["Log Search Cloud"])

    // The reserve template `openingHand` holds first for "Log Search Cloud",
    // fired by round two's `draw` — proven fired at all, and the only query
    // that round bought.
    expect(h.asked.slice(14)).toEqual(["widening query one", "best log search"])

    // Every opening-hand query and round one's untagged widening query bill
    // at SHALLOW_PAGES (2); round two's released query, fired only after
    // `deepen` named its product, bills at DEEP_PAGES (4) instead — the
    // routing this feature exists for, proven in the bill rather than just
    // in the flag.
    expect(h.result.stats.serpCalls).toBe(15 * 2 + 1 * 4)
  }, 30_000)

  it("leaves every product shallow when assess never names one", async () => {
    const h = await runFixture()
    const serp = h.result.report.serp as { deepenedProducts: string[] }
    expect(serp.deepenedProducts).toEqual([])
    expect(h.result.stats.serpCalls).toBe(14 * 2)
  }, 30_000)
})
