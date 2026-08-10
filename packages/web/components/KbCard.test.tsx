import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { KbCard } from "./KbCard"
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
 */

const kb: KbSummary = {
  slug: "acme-com-202608070005",
  manifest: { brand: "acme.com", builtAt: "2026-08-07T00:05:00.000Z", usd: 1.5, seconds: 120 },
  counts: { core: 1, product: 4, player: 9, community: 2 },
  notes: 16,
  unplaced: 3,
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
  it("carries no edge count and no market chips", () => {
    const html = renderToStaticMarkup(<KbCard kb={kb} />)

    expect(html).not.toContain("edges")
    expect(html).not.toContain("widget hosting")
    // Still the card it always was: title, run stamp, badge, glyph counts.
    expect(html).toContain("acme.com")
    expect(html).toContain("3 unplaced")
    expect(html).toContain('href="/kb/acme-com-202608070005"')
  })
})

describe("the showcase card", () => {
  it("adds the edge count and the markets, and drops the remainder bucket", () => {
    const html = renderToStaticMarkup(<KbCard kb={kb} showcase />)

    expect(html).toContain("41")
    expect(html).toContain("edges</span>")
    expect(html).toContain("widget hosting")
    expect(html).toContain("widget analytics")
    expect(html).toContain("widget billing")
    // Three named, the fourth counted. A card that listed every market of a
    // nine-market map would be a card nobody reads.
    expect(html).not.toContain("widget support")
    expect(html).toContain("+1")
    expect(html).not.toContain("unattributed")
  })

  it("says nothing about edges on a run that recorded none", () => {
    // Not "0 edges". `SweepResult.edges` is optional, so zero here can mean the
    // run measured no relations OR that it predates the field, and a card
    // asserting a flat market it never looked for is the more expensive of the
    // two readings to be wrong about.
    const html = renderToStaticMarkup(<KbCard kb={{ ...kb, edges: 0 }} showcase />)
    expect(html).not.toContain("edges")
  })
})
