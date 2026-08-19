import { readFileSync } from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { KbCard } from "./KbCard"
import { summaryOf } from "@/lib/kb-from-run"
import type { CompletedRun } from "@/lib/runs"
import type { SweepResult } from "@open-kb/sweep"
import type { KbSummary } from "@/lib/viewTypes"

/**
 * ONE CARD, TWO SURFACES.
 *
 * `showcase` exists because /kb and the demo home ask different questions of
 * the same component: a grid of three dozen runs wants to be scannable, and six
 * chosen specimens want to argue for themselves. That is a defensible split
 * only while it stays a split — the moment the extra rows leak into the default
 * they are on every card of a page that has thirty-six of them, which is the
 * outcome the prop was added to avoid.
 *
 * So both directions are pinned. The default may not grow the two rows, and the
 * showcase spelling may not lose them.
 *
 * AND ONE HEADLINE, WHICH IS THE REST OF THIS FILE. The card's only kind count
 * is "companies in this market", and it is a union of two classifier kinds that
 * were merged on 2026-08-10 (CLASSIFY_KINDS in packages/sweep/src/sweep.ts).
 * Every map in the gallery today was recorded BEFORE that merge, so the naive
 * spelling — `counts.player` — prints 1 for a payments market with 1,273
 * companies in it. The last describe block holds the card to the real file.
 */

const kb: KbSummary = {
  slug: "acme-com-202608070005",
  relations: { competitors: 3, substitutes: 1, partners: 0, voices: 2 },
  manifest: { brand: "acme.com", builtAt: "2026-08-07T00:05:00.000Z", usd: 1.5, seconds: 120 },
  counts: { core: 1, product: 4, player: 9, community: 2 },
  notes: 16,
  unplaced: 3,
  // 13 company-like rows (4 product + 9 player), 3 of them `relation: "none"`.
  companies: 10,
  noise: 1,
  edges: 41,
  segments: [
    { name: "widget hosting", size: 9, straddlers: 2 },
    { name: "widget analytics", size: 4, straddlers: 0 },
    { name: "widget billing", size: 2, straddlers: 0 },
    { name: "widget support", size: 1, straddlers: 0 },
    // The run's honest remainder, which is not a market and must never wear a
    // market's chip. See the filter in KbCard.
    { name: "unattributed", size: 1, straddlers: 0 },
  ],
}

describe("the gallery card — the default", () => {
  it("carries no link count and no market chips", () => {
    const html = renderToStaticMarkup(<KbCard kb={kb} />)

    expect(html).not.toContain("links")
    expect(html).not.toContain("widget hosting")
    // Still the card it always was: title, run stamp, and now one headline.
    // The unplaced badge is gone on purpose — a gallery is for choosing what to
    // open, and an amber warning in the corner of every card is not that.
    expect(html).toContain("acme.com")
    expect(html).not.toContain("unplaced")
    expect(html).toContain('href="/kb/acme-com-202608070005"')
  })

  it("still leads with the headline and the entity count", () => {
    // The two fields that must be on EVERY card, on both surfaces. The old
    // glyph row hid a kind count under fifty, which is why stripe.com showed
    // three numbers and brightdata.com four; nothing on this card may be
    // conditional on how large its number happens to be.
    const html = renderToStaticMarkup(<KbCard kb={kb} />)
    expect(html).toContain("companies in this market")
    expect(html).toContain("16</span> entities")
  })
})

describe("the showcase card", () => {
  it("adds the link count and the markets, and drops the remainder bucket", () => {
    const html = renderToStaticMarkup(<KbCard kb={kb} showcase />)

    expect(html).toContain("41</span> links")
    expect(html).toContain("widget hosting")
    expect(html).toContain("widget analytics")
    expect(html).toContain("widget billing")
    // Three named, the fourth counted. A card that listed every market of a
    // nine-market map would be a card nobody reads.
    expect(html).not.toContain("widget support")
    expect(html).toContain("+1")
    expect(html).not.toContain("unattributed")
  })

  it("says nothing about links on a run that recorded none", () => {
    // Not "0 links". `SweepResult.edges` is optional, so zero here can mean the
    // run measured no relations OR that it predates the field, and a card
    // asserting a flat market it never looked for is the more expensive of the
    // two readings to be wrong about.
    const html = renderToStaticMarkup(<KbCard kb={{ ...kb, edges: 0 }} showcase />)
    expect(html).not.toContain("links")
  })
})

describe("the headline count", () => {
  /**
   * THE TRAP THE HEADLINE EXISTS TO WALK PAST.
   *
   * `company` and `product` were one decision the classifier made twice with
   * different answers, so both are companies and the card counts both. These
   * are the two failing shapes, hand-built, either side of the merge.
   */
  it("reads the reader's placed count, NOT the sum of the kind counts", () => {
    // The headline says "in this market", and `counts.player + counts.product`
    // cannot say that: `place()` keeps `relation: "none"` rows, which are the
    // classifier stating the host sells into a DIFFERENT market. 20.1% of every
    // company-like row across the stored corpus, 38.5% on figma.
    //
    // The union of the two merged kinds now happens in `summaryOf`, so what the
    // card must be held to is that it prints THAT number and never re-derives
    // one from the counts beside it.
    const html = renderToStaticMarkup(
      <KbCard kb={{ ...kb, counts: { core: 477, product: 1272, player: 1, community: 772 }, notes: 2522, companies: 1008 }} showcase />,
    )
    expect(html).toContain("1,008</span>")
    expect(html).toContain("companies in this market")
    // The naive union, which is the number this card used to print.
    expect(html).not.toContain("1,273</span>")
  })

  it("leaves out the hosts the run left unsettled, and the venues", () => {
    // `unknown` folds into the `unplaced` group, which falls through
    // `nodeTypeOf` to `core` — 476 of stripe.com's 2,522 entities.
    //
    // WHAT THOSE 476 ACTUALLY ARE, because the first version of this comment
    // said "every one of them nameless and descriptionless" and none of that
    // survives the file: all 476 carry a name, and 74 of them were READ and
    // described (taleo-consulting.com, "A management and delivery advisory
    // group serving banking and insurance"). 402 were unreadable. `unknown` is
    // the kernel declining to settle a kind, not a failed fetch, and excluding
    // them is a policy choice — a host whose kind was never settled is not
    // evidence of a player — rather than a fact about empty rows.
    //
    // Publishers, directories and communities are channels this market is
    // discussed in, not players in it. A card counting either would print
    // 2,521 companies for stripe.com.
    const html = renderToStaticMarkup(
      <KbCard kb={{ ...kb, counts: { core: 477, product: 0, player: 10, community: 772 }, notes: 1259, companies: 10 }} />,
    )
    expect(html).toContain(">10</span>")
    expect(html).not.toContain("1,258")
    expect(html).not.toContain("782")
  })

  it("prints a zero rather than dropping the line", () => {
    // Five of the 85 stored runs found no company at all (four early
    // resend.com sweeps and one two-entity vercel.com run). A reader can argue
    // with a zero; they cannot argue with a field that is not there.
    const html = renderToStaticMarkup(
      <KbCard kb={{ ...kb, counts: { core: 1, product: 0, player: 0, community: 3 }, notes: 4, companies: 0 }} />,
    )
    expect(html).toContain(">0</span>")
    expect(html).toContain("companies in this market")
  })

  it("says `company` when there is one of them", () => {
    const html = renderToStaticMarkup(
      <KbCard kb={{ ...kb, counts: { core: 1, product: 1, player: 0, community: 3 }, companies: 1 }} />,
    )
    expect(html).toContain("company in this market")
    expect(html).not.toContain("companies in this market")
  })
})

/**
 * AND THE SAME THING AGAINST THE FILE, because the fixtures above are shapes
 * this author chose and the gallery is six files this author did not.
 *
 * lib/demo-maps.test.ts makes the same argument for the reader; this makes it
 * for the card. Reading the committed map through `summaryOf` is the only way
 * to catch a headline that is correct about a hand-built `TypeCounts` and wrong
 * about the run that is actually on the front page.
 */
describe("stripe.com, as it is committed", () => {
  const MAP = path.resolve(
    import.meta.dirname,
    "../../../demo/maps/sweep-stripe-com-20260818214527.json",
  )

  const run: CompletedRun = {
    id: "stripe-com-202608070005",
    domain: "stripe.com",
    queries: 0,
    startedAt: 0,
    endedAt: Date.parse("2026-08-07T00:05:00Z"),
    status: "complete",
    result: JSON.parse(readFileSync(MAP, "utf8")) as SweepResult,
  }

  it("shows 769 companies — the union minus what the run placed outside this market", () => {
    const summary = summaryOf(run)
    // The reading layer's own numbers, pinned so a change to `place` or
    // `KIND_GROUP` has to come past this test rather than quietly re-scoring
    // the front page. The 2026-08-18 rebuild replaced the map behind this
    // test: one engine generation, the company/product coin flip gone at the
    // classifier (product: 0 — the merge is now upstream of the store), the
    // orphan ask and integration edges live.
    expect(summary.counts).toEqual({ core: 19, product: 0, player: 1065, community: 343 })
    expect(summary.notes).toBe(1427)
    expect(summary.edges).toBe(3067)
    //   1,065  every company-like row, including the 296 this run judged to
    //          sell into a DIFFERENT market.
    //   769    the union minus those, which is what "in this market" means.
    expect(summary.companies).toBe(769)
    expect(summary.counts.product + summary.counts.player - summary.companies).toBe(296)
    // `unplaced` is the WHOLE map's `relation: "none"` count — 485 — because it
    // includes the publishers and communities placed nowhere too. The 265 above
    // is its company-like subset, and the two are not interchangeable: a card
    // subtracting `unplaced` from the union would under-count by 220.
    expect(summary.unplaced).toBe(325)

    const html = renderToStaticMarkup(<KbCard kb={summary} showcase />)
    expect(html).toContain("769</span>")
    expect(html).not.toContain("1,065</span>")
    expect(html).toContain("companies in this market")
    expect(html).toContain("1,427</span> entities")
    expect(html).toContain("3,067</span> links")
    expect(html).toContain("Online payment processing")
    expect(html).toContain("stripe.com")
  })
})
