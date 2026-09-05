import { describe, expect, it } from "vitest"
import { labelPriority, planLabels, type LabelCandidate } from "./labels"

// 7px per character, 12px line — close enough to the real mono metrics that the
// packing behaves the way it does on the canvas.
const measure = (t: string) => t.length * 7
const opts = (over: Partial<Parameters<typeof planLabels>[1]> = {}) => ({
  scale: 1,
  minScreenR: 9,
  maxLabels: 100,
  measure,
  lineHeight: 12,
  ...over,
})

const cand = (over: Partial<LabelCandidate> & { id: string }): LabelCandidate => ({
  text: over.id,
  x: 0,
  y: 0,
  r: 12,
  priority: 0,
  forced: false,
  ...over,
})

describe("zoom reveals labels", () => {
  const nodes = [
    cand({ id: "big", r: 14 }),
    cand({ id: "mid", r: 8, x: 400 }),
    cand({ id: "small", r: 4, x: 800 }),
  ]

  it("names only the largest nodes when zoomed out", () => {
    // THE bug this replaces: the old rule showed the same six labels at every
    // zoom, so zooming in — the one gesture for "tell me more" — did nothing.
    const ids = planLabels(nodes, opts({ scale: 0.8 })).map((l) => l.id)
    expect(ids).toEqual(["big"])
  })

  it("names more of them as the reader zooms in", () => {
    const at2 = planLabels(nodes, opts({ scale: 2 })).map((l) => l.id)
    expect(at2).toContain("big")
    expect(at2).toContain("mid")
  })

  it("eventually names even the smallest", () => {
    expect(planLabels(nodes, opts({ scale: 4 })).map((l) => l.id)).toContain("small")
  })
})

describe("decluttering", () => {
  it("drops a label that would overprint one already placed", () => {
    // Two nodes on the same spot: one name is readable, two stacked are not.
    const a = cand({ id: "aaaaaaaaaaaa", priority: 0 })
    const b = cand({ id: "bbbbbbbbbbbb", priority: 1, x: 2 })
    const ids = planLabels([a, b], opts()).map((l) => l.id)
    expect(ids).toEqual(["aaaaaaaaaaaa"])
  })

  it("keeps both when they are far enough apart", () => {
    const a = cand({ id: "aaa" })
    const b = cand({ id: "bbb", x: 500 })
    expect(planLabels([a, b], opts())).toHaveLength(2)
  })

  it("gives the space to the more important node regardless of input order", () => {
    // Order of the render list must not decide who gets named.
    const leaf = cand({ id: "leaf", priority: 50 })
    const market = cand({ id: "market", priority: -1000, x: 3 })
    expect(planLabels([leaf, market], opts())[0].id).toBe("market")
    expect(planLabels([market, leaf], opts())[0].id).toBe("market")
  })

  it("does not reorder the caller's array", () => {
    // It is the render list; reordering it would change z-order every frame.
    const list = [cand({ id: "z", priority: 9 }), cand({ id: "a", priority: 0, x: 900 })]
    const before = list.map((c) => c.id)
    planLabels(list, opts())
    expect(list.map((c) => c.id)).toEqual(before)
  })
})

describe("forced labels", () => {
  it("draws a hovered or searched node even when it is tiny", () => {
    const tiny = cand({ id: "tiny", r: 1, forced: true })
    expect(planLabels([tiny], opts({ scale: 0.2 })).map((l) => l.id)).toEqual(["tiny"])
  })

  it("never lets an ordinary label crowd out a forced one", () => {
    const forced = cand({ id: "searched-hit", forced: true, priority: 999 })
    const ordinary = cand({ id: "ordinary-nod", priority: -999, x: 2 })
    const ids = planLabels([ordinary, forced], opts()).map((l) => l.id)
    expect(ids).toContain("searched-hit")
    expect(ids).not.toContain("ordinary-nod")
  })

  it("wins the same tie-break with the forced node listed first", () => {
    // The sort comparator's `a.forced ? -1 : 1` branch above is only ever
    // exercised with the forced node as the comparator's SECOND argument by
    // the fixtures in this file (render lists always happen to list "found"
    // nodes after ordinary ones) — so `a.forced` true, the mirror case, had
    // never run. Same nodes, input order flipped.
    const forced = cand({ id: "searched-hit", forced: true, priority: 999 })
    const ordinary = cand({ id: "ordinary-nod", priority: -999, x: 2 })
    const ids = planLabels([forced, ordinary], opts()).map((l) => l.id)
    expect(ids).toContain("searched-hit")
    expect(ids).not.toContain("ordinary-nod")
  })

  it("shows every forced label even when several overlap", () => {
    // Two forced labels on top of each other is worse than one, but hiding the
    // node a reader explicitly asked about is worse still.
    const a = cand({ id: "aaaa", forced: true })
    const b = cand({ id: "bbbb", forced: true, x: 1 })
    expect(planLabels([a, b], opts())).toHaveLength(2)
  })
})

describe("budget", () => {
  it("never exceeds maxLabels", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      cand({ id: `n${i}`, x: i * 300, r: 20 }),
    )
    expect(planLabels(many, opts({ maxLabels: 40 })).length).toBe(40)
  })
})

describe("labelPriority", () => {
  it("ranks the anchor above every hub", () => {
    expect(labelPriority({ isHub: true, deg: 1, rel: 0 })).toBeLessThan(
      labelPriority({ isHub: false, deg: 82, rel: 100 }),
    )
  })

  it("ranks a market above its own leaves", () => {
    expect(labelPriority({ isHub: false, deg: 82, rel: 50 })).toBeLessThan(
      labelPriority({ isHub: false, deg: 1, rel: 100 }),
    )
  })

  it("falls back to placement between equally-connected nodes", () => {
    expect(labelPriority({ isHub: false, deg: 3, rel: 90 })).toBeLessThan(
      labelPriority({ isHub: false, deg: 3, rel: 10 }),
    )
  })
})
