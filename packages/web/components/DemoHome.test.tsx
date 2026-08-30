import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DemoHome } from "./DemoHome"
import { DEMO_ASIDE, DEMO_REPO } from "@/lib/demo"
import type { KbSummary } from "@/lib/viewTypes"

/**
 * DemoHome.tsx had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md itself is
 * gone from this checkout — see 48c1eaa's note on recovering section D's
 * scope from git history). This is the demo deployment's home page — the live
 * route at app/page.tsx, not the deprioritised demo-gallery-building script
 * (scripts/build-demo-maps.ts, already covered).
 *
 * A pure server component (no hooks, no client boundary), so unlike the last
 * several D-scope UI items it needs no note about a missing jsdom/RTL harness:
 * every branch below is decided at render time from props, and
 * renderToStaticMarkup exercises all of them.
 *
 * Three real behaviours pinned here that a casual read would miss:
 *   - `ledgerOf`'s usd/seconds sums are all-or-nothing: one card missing a
 *     manifest field turns the WHOLE total undefined (`u === undefined ||
 *     spent === undefined ? undefined : u + spent`), not just that card's
 *     contribution. A partial sum presented as a total understates the real
 *     figure, which is exactly what the field's own doc comment says the
 *     `undefined` guards against.
 *   - the sort is "biggest map first" (`b.notes - a.notes`) with slug as the
 *     tiebreaker, so the card order is stable across renders rather than
 *     depending on array insertion order.
 *   - `bare` swaps in a different top-level shell (a `<section>` under a run
 *     box) and drops the `notice` prop entirely along with the headline and
 *     launch video — matching the only two ways app/page.tsx actually calls
 *     this component (`bare` with no `notice`, or `notice` with no `bare`).
 */

function kb(over: Partial<KbSummary> & { slug: string; notes: number }): KbSummary {
  return {
    manifest: { usd: 1, seconds: 60 },
    counts: { core: 1, product: 1, player: 1, community: 0 },
    unplaced: 0,
    companies: 2,
    noise: 0,
    edges: 10,
    relations: { competitors: 1, substitutes: 0, partners: 1, voices: 0 },
    segments: [],
    ...over,
  }
}

describe("DemoHome: the cards are sorted biggest map first, slug breaking ties", () => {
  it("orders by notes descending", () => {
    const html = renderToStaticMarkup(
      <DemoHome
        kbs={[
          kb({ slug: "small-com-1", notes: 5 }),
          kb({ slug: "big-com-2", notes: 50 }),
          kb({ slug: "mid-com-3", notes: 20 }),
        ]}
      />,
    )
    const order = [...html.matchAll(/href="\/kb\/([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(["big-com-2", "mid-com-3", "small-com-1"])
  })

  it("breaks a tie on notes by slug, ascending", () => {
    const html = renderToStaticMarkup(
      <DemoHome
        kbs={[
          kb({ slug: "zebra-com-1", notes: 10 }),
          kb({ slug: "acme-com-2", notes: 10 }),
        ]}
      />,
    )
    const order = [...html.matchAll(/href="\/kb\/([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(["acme-com-2", "zebra-com-1"])
  })
})

describe("DemoHome: the ledger line", () => {
  it("says 'map' for one and 'maps' for more than one", () => {
    const one = renderToStaticMarkup(<DemoHome kbs={[kb({ slug: "a-com-1", notes: 5 })]} />)
    expect(one).toContain("1 map below")

    const many = renderToStaticMarkup(
      <DemoHome
        kbs={[kb({ slug: "a-com-1", notes: 5 }), kb({ slug: "b-com-2", notes: 6 })]}
      />,
    )
    expect(many).toContain("2 maps below")
  })

  it("sums usd and seconds across every card when every manifest has both", () => {
    const html = renderToStaticMarkup(
      <DemoHome
        kbs={[
          kb({ slug: "a-com-1", notes: 5, manifest: { usd: 1.5, seconds: 60 } }),
          kb({ slug: "b-com-2", notes: 6, manifest: { usd: 2.5, seconds: 90 } }),
        ]}
      />,
    )
    expect(html).toContain("$4.0000")
    expect(html).toContain("2m 30s")
    expect(html).toContain("of machine")
  })

  it("drops the usd/seconds clause entirely when one card's manifest lacks usd", () => {
    // ledgerOf's guard is all-or-nothing: a $2.50 card that never recorded a
    // cost must not silently make the total read as if it cost $1.50.
    const html = renderToStaticMarkup(
      <DemoHome
        kbs={[
          kb({ slug: "a-com-1", notes: 5, manifest: { usd: 1.5, seconds: 60 } }),
          kb({ slug: "b-com-2", notes: 6, manifest: { seconds: 90 } }),
        ]}
      />,
    )
    expect(html).not.toContain("of machine")
    expect(html).not.toContain("$1.5000")
    // The entity/link half of the line is unaffected by the missing cost.
    expect(html).toContain("2 maps below")
  })

  it("renders no ledger line at all when there are no maps to show", () => {
    const html = renderToStaticMarkup(<DemoHome kbs={[]} />)
    expect(html).not.toContain("below")
    expect(html).not.toContain("entities")
  })
})

describe("DemoHome: error and empty states", () => {
  it("shows the read failure and no card grid when error is set", () => {
    const html = renderToStaticMarkup(<DemoHome kbs={[]} error="OPENKB_DEMO is on…" />)
    expect(html).toContain("Could not read the maps this demo ships with")
    expect(html).toContain("OPENKB_DEMO is on…")
    expect(html).not.toContain('href="/kb/')
  })

  it("shows the holding-no-maps notice when there is no error and no kbs", () => {
    const html = renderToStaticMarkup(<DemoHome kbs={[]} />)
    expect(html).toContain("holding no maps to show")
  })
})

describe("DemoHome: bare vs. full shell", () => {
  it("bare renders the under-the-run-box section, not the headline or video", () => {
    const html = renderToStaticMarkup(
      <DemoHome kbs={[kb({ slug: "a-com-1", notes: 5 })]} bare notice="todays allowance is spent" />,
    )
    expect(html).toContain("maps already built here")
    expect(html).not.toContain("Map a market")
    expect(html).not.toContain("launch.mp4")
    // app/page.tsx never passes notice alongside bare — pinning that bare
    // drops it entirely rather than silently rendering it somewhere unexpected.
    expect(html).not.toContain("todays allowance is spent")
  })

  it("non-bare renders the headline, the video, and a set notice", () => {
    const html = renderToStaticMarkup(
      <DemoHome kbs={[kb({ slug: "a-com-1", notes: 5 })]} notice="todays allowance is spent" />,
    )
    expect(html).toContain("Map a market")
    expect(html).toContain("launch.mp4")
    expect(html).toContain("todays allowance is spent")
  })

  it("non-bare omits the notice paragraph entirely when notice is null", () => {
    const html = renderToStaticMarkup(<DemoHome kbs={[kb({ slug: "a-com-1", notes: 5 })]} />)
    expect(html).toContain("Map a market")
    expect(html).not.toContain("todays allowance is spent")
  })
})

describe("DemoHome: the aside is always present", () => {
  it("carries the fixed disclosure sentence and the repo link", () => {
    const html = renderToStaticMarkup(<DemoHome kbs={[kb({ slug: "a-com-1", notes: 5 })]} />)
    expect(html).toContain(DEMO_ASIDE)
    expect(html).toContain(`href="${DEMO_REPO}"`)
  })
})
