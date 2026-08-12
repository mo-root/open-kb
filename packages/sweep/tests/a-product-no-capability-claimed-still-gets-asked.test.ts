import { describe, it, expect } from "vitest"
import { runFixture, ANCHOR, COINAGE, type Harness } from "./fixture.js"

/**
 * THE BIGGEST RECALL LEVER IN THE ENGINE, and it was a list comprehension.
 *
 * The opening hand is dealt from `capabilities[].covers` — the model's grouping
 * of the product list — and the grouping loses part of the list. A product
 * `understand` found, named and described, that no capability happened to
 * mention, drew no catalog call, no strip terms and not one query. It was not
 * reported either: the plan-coverage line counts queries per MARKET, so a
 * capability whose one remembered product got a hand reported itself covered
 * while its siblings were never asked about.
 *
 * MEASURED over the 25 runs on disk carrying a modern decomposition: 113 of 408
 * discovered products, 27.7%. cloudflare funded 1 of its 71 products, supabase
 * 7 of 29, github 12 of 24, linear.app 0 of 5.
 *
 * So every product `understand` returns is adopted by the capability it reads
 * closest to and dealt the same hand as any other product, and the run says how
 * many it had to adopt. These tests are that rule, and the last one is the
 * control: a decomposition whose grouping keeps the whole list must produce
 * exactly the run it produced before.
 */

/** In no `covers` list, and its own words overlap the ADJACENT capability —
 *  so a run that adopts it into `log search` has fallen back to the tie-break
 *  rather than read the sentences. */
const ORPHAN = "Heartbeat Checks"
const ORPHAN_TERM = "synthetic uptime checks"

/** Overlaps neither capability, which is what makes it the tie-break case. */
const STRANGER = "Cold Storage Vault"
const STRANGER_TERM = "frozen log archive"

const understand = (extra: { name: string; does: string }) => () => ({
  sells: "hosted log search and uptime alerts for small platform teams",
  buyer: "a platform team of five to fifty engineers who have just had an incident",
  brand: "Pellucid",
  products: [
    {
      name: "Log Search Cloud",
      does: "searches application logs",
      foundAt: `https://${ANCHOR}/products/log-search`,
    },
    {
      name: "Uptime Alerts",
      does: "pages the on-call engineer",
      foundAt: `https://${ANCHOR}/products/uptime-alerts`,
    },
    { name: extra.name, does: extra.does, foundAt: "" },
  ],
  // Two capabilities that between them remember two of the three products.
  capabilities: [
    {
      name: "log search",
      does: "answers a question about production",
      covers: ["Log Search Cloud"],
      centrality: "core",
    },
    {
      name: "uptime alerts",
      does: "notices an endpoint stopped answering",
      covers: ["Uptime Alerts"],
      centrality: "adjacent",
    },
  ],
  coinages: [COINAGE],
})

/** Terms only. The templates then write this product's opening hand, which is
 *  the thing being counted: a product with no strip terms buys nothing. */
const catalog = (product: string) => ({
  terms: [
    product === "Log Search Cloud"
      ? "log search"
      : product === "Uptime Alerts"
        ? "uptime monitoring"
        : product === ORPHAN
          ? ORPHAN_TERM
          : STRANGER_TERM,
  ],
  generic: true,
  queries: [],
})

const subjects = (h: Harness): string[] =>
  h.calls.filter((c) => c.phase === "catalog").map((c) => c.subject)

const promptFor = (h: Harness, product: string): string =>
  h.calls.find((c) => c.phase === "catalog" && c.subject === product)?.prompt ??
  ""

/** `    its market    uptime alerts  [adjacent]` — the catalog prompt's layout. */
const marketOf = (prompt: string): string =>
  /its market\s{2,}(.+?)\s{2,}\[/.exec(prompt)?.[1]?.trim() ?? ""

const unclaimed = (h: Harness): unknown => h.result.report.unclaimedProducts

describe("a product no capability claimed", () => {
  it("gets its own catalog call, and its terms reach the wire", async () => {
    const h = await runFixture({
      script: {
        understand: understand({
          name: ORPHAN,
          does: "notices when an endpoint stops answering from more than one region",
        }),
        catalog,
      },
    })
    expect(subjects(h)).toContain(ORPHAN)
    // The whole point of the call: a strip, a hand, and a bought search. The
    // 113 unfunded products got none of the three.
    expect(h.asked).toContain(ORPHAN_TERM)
    expect(h.asked).toContain(`${ORPHAN_TERM} alternatives`)
  }, 30_000)

  it("lands in the market its own sentences read closest to", async () => {
    // Word overlap against the capability's name, job and covers list. This
    // product shares `notices`, `endpoint` and `answering` with the adjacent
    // capability and nothing with the core one, so a run that placed it in the
    // core market placed it by position rather than by reading.
    const h = await runFixture({
      script: {
        understand: understand({
          name: ORPHAN,
          does: "notices when an endpoint stops answering from more than one region",
        }),
        catalog,
      },
    })
    expect(marketOf(promptFor(h, ORPHAN))).toBe("uptime alerts")
  }, 30_000)

  it("lands in a core market when it reads like nothing at all", async () => {
    // The tie-break, and it is not arbitrary: a product no capability's words
    // reach is still a product this company sells, and the market it is most
    // likely to be bought in is the one the company is bought for.
    const h = await runFixture({
      script: {
        understand: understand({
          name: STRANGER,
          does: "keeps frozen archives on tape",
        }),
        catalog,
      },
    })
    expect(subjects(h)).toContain(STRANGER)
    expect(marketOf(promptFor(h, STRANGER))).toBe("log search")
  }, 30_000)

  it("is counted out loud, because the market-level line cannot see it", async () => {
    const h = await runFixture({
      script: {
        understand: understand({
          name: ORPHAN,
          does: "notices when an endpoint stops answering from more than one region",
        }),
        catalog,
      },
    })
    // The old line, still true and still not enough on its own: both core
    // markets drew queries while a third of the product list drew nothing.
    expect(
      h.says.some((s) => /core markets got at least one query/.test(s)),
    ).toBe(true)
    const said = h.says.find((s) =>
      /in no capability's covers list/.test(s),
    )
    expect(said, "the run adopted a product and never said so").toBeDefined()
    expect(said).toContain("1 of 3 products")
    expect(said).toContain(ORPHAN)
    // And countable afterwards, from the file, which is how the 113 were found.
    expect(unclaimed(h)).toBe(1)
  }, 30_000)
})

describe("a decomposition whose grouping keeps the whole list", () => {
  it("adopts nothing, says nothing, and buys exactly what it bought before", async () => {
    // The control. Every product in the default fixture is named by a
    // capability, so this rule must be invisible: same catalog calls, same
    // queries, and a zero rather than a sentence.
    const h = await runFixture()
    expect(subjects(h).sort()).toEqual(["Log Search Cloud", "Uptime Alerts"])
    expect(unclaimed(h)).toBe(0)
    expect(h.says.some((s) => /in no capability's covers list/.test(s))).toBe(
      false,
    )
  }, 30_000)

  it("does not deal a product twice when a covers entry only differs in case", async () => {
    // `covers` is the model quoting its own product list back to itself, and
    // the quote comes back shouted often enough to matter. Matched case-folded,
    // so "LOG SEARCH CLOUD" is the product it names rather than a second
    // product nobody sells — which would be a catalog call bought twice.
    const h = await runFixture({
      script: {
        understand: () => ({
          ...understand({ name: ORPHAN, does: "notices an endpoint" })(),
          products: [
            {
              name: "Log Search Cloud",
              does: "searches application logs",
              foundAt: `https://${ANCHOR}/products/log-search`,
            },
          ],
          capabilities: [
            {
              name: "log search",
              does: "answers a question about production",
              covers: ["LOG SEARCH CLOUD"],
              centrality: "core",
            },
          ],
        }),
        catalog: () => ({ terms: ["log search"], generic: true, queries: [] }),
      },
    })
    expect(subjects(h)).toEqual(["LOG SEARCH CLOUD"])
    expect(unclaimed(h)).toBe(0)
  }, 30_000)
})
