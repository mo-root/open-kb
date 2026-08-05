import { describe, expect, it } from "vitest"
import {
  HUB_DEGREE,
  chargeDistanceMax,
  chargeStrength,
  hashUnit,
  isHubDegree,
  linkDistance,
  linkStrength,
  seedPosition,
  span,
  tetherAspect,
  tetherStrength,
  warmupTicks,
  cooldownTicks,
} from "./layout"

const node = (over: Partial<Parameters<typeof chargeStrength>[0]> = {}) => ({
  id: "x",
  deg: 1,
  r: 6,
  isHub: false,
  ...over,
})

describe("span", () => {
  it("grows with the square root of the node count", () => {
    // Area per node is what must stay constant, so doubling the nodes must
    // multiply the radius by about √2 — not by 2.
    const a = span(200)
    const b = span(400)
    expect(b / a).toBeGreaterThan(1.3)
    expect(b / a).toBeLessThan(1.5)
  })

  it("clamps at both ends so tiny and huge maps stay usable", () => {
    expect(span(1)).toBe(170)
    expect(span(100000)).toBe(560)
  })
})

describe("hub detection", () => {
  it("is a degree threshold, not a rank", () => {
    // The real failure this replaces: hub-ness was `id === anchorId`, so the
    // markets carrying 82, 64 and 55 children were laid out as leaves.
    expect(isHubDegree(82)).toBe(true)
    expect(isHubDegree(HUB_DEGREE)).toBe(true)
    expect(isHubDegree(HUB_DEGREE - 1)).toBe(false)
  })

  it("gives a high-degree node far more room than a leaf", () => {
    expect(chargeStrength(node({ deg: 82 }))).toBeLessThan(chargeStrength(node({ deg: 1 })))
  })

  it("pushes the anchor hardest, so it never sits inside its own fan", () => {
    expect(chargeStrength(node({ isHub: true, deg: 300 }))).toBeLessThan(
      chargeStrength(node({ deg: 82 })),
    )
  })
})

describe("linkDistance", () => {
  it("seats a large fan on a longer spring than a small one", () => {
    // 82 children on the same 55-unit spring as 3 children is a filled disc.
    const wide = linkDistance({ parentDeg: 82, hubLink: false }, 295)
    const narrow = linkDistance({ parentDeg: 3, hubLink: false }, 295)
    expect(wide).toBeGreaterThan(narrow * 1.5)
  })

  it("holds anchor edges far out and nearly inert", () => {
    const anchor = { parentDeg: 294, hubLink: true }
    expect(linkDistance(anchor, 295)).toBeGreaterThan(150)
    expect(linkStrength(anchor)).toBeLessThan(0.05)
    // A typed edge is what actually pulls.
    expect(linkStrength({ hubLink: false })).toBeGreaterThan(linkStrength(anchor) * 10)
  })
})

describe("repulsion is bounded but reaches between lobes", () => {
  it("stays finite and proportional to the working radius", () => {
    // Uncapped all-pairs repulsion is what flattened the map into one even
    // disc, so a cap has to exist and has to scale with the map.
    for (const n of [50, 295, 680]) {
      expect(chargeDistanceMax(n)).toBeGreaterThan(0)
      expect(chargeDistanceMax(n)).toBeLessThan(span(n) * 2)
    }
  })

  it("reaches PAST the working radius, so two lobes can push each other apart", () => {
    // This assertion was originally the opposite — the cap sat at 0.55·span,
    // which is shorter than the distance between two lobes, so lobes could not
    // feel each other while the centre tether kept pulling both inward. The
    // map piled into the middle of an empty canvas. The cap must clear the
    // working radius for the lobes to separate at all.
    for (const n of [50, 295, 680]) {
      expect(chargeDistanceMax(n)).toBeGreaterThan(span(n))
    }
  })
})

describe("tether", () => {
  it("holds a disconnected node much harder than a connected one", () => {
    // An entity with relation:"none" has no spring at all; without this it is
    // thrown off-canvas and drags zoomToFit's bounding box with it.
    expect(tetherStrength(node({ deg: 0 }))).toBeGreaterThan(tetherStrength(node({ deg: 4 })) * 4)
  })

  it("never fights the pinned anchor", () => {
    expect(tetherStrength(node({ isHub: true, deg: 0 }))).toBe(0)
  })
})

describe("settling schedule", () => {
  it("pre-settles more for bigger graphs but stays bounded", () => {
    expect(warmupTicks(680, false)).toBeGreaterThan(warmupTicks(150, false))
    expect(warmupTicks(100000, false)).toBeLessThanOrEqual(260)
  })

  it("reduced motion settles up front and animates nothing after", () => {
    expect(cooldownTicks(295, true)).toBe(0)
    expect(warmupTicks(295, true)).toBeGreaterThan(warmupTicks(295, false))
  })
})

describe("seeding", () => {
  it("is deterministic, so a reset reproduces the same opening shape", () => {
    expect(hashUnit("players/apify.com.md")).toBe(hashUnit("players/apify.com.md"))
    expect(hashUnit("a")).not.toBe(hashUnit("b"))
  })

  it("stays inside the unit interval for any id", () => {
    for (const s of ["", "a", "markets/x.md", "🙂", "z".repeat(500)]) {
      const u = hashUnit(s)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })

  it("starts the anchor at the origin and leaves further out than hubs", () => {
    const hub = seedPosition(node({ isHub: true }), 295, 82)
    expect(hub).toEqual({ x: 0, y: 0 })

    const radius = (n: ReturnType<typeof node>) => {
      const p = seedPosition(n, 295, 82)
      return Math.hypot(p.x, p.y)
    }
    expect(radius(node({ id: "leaf", deg: 1 }))).toBeGreaterThan(
      radius(node({ id: "market", deg: 82 })),
    )
  })
})

describe("tetherAspect", () => {
  it("is neutral on a square pane", () => {
    const a = tetherAspect(800, 800)
    expect(a.x).toBeCloseTo(1)
    expect(a.y).toBeCloseTo(1)
  })

  it("pulls harder vertically in a wide pane, so the map spreads sideways", () => {
    // The whole point: a disc in a 2:1 pane fits by height and wastes half the
    // canvas. Firmer vertical pull flattens it into the space that is there.
    const a = tetherAspect(1700, 730)
    expect(a.y).toBeGreaterThan(1)
    expect(a.x).toBeLessThan(1)
  })

  it("mirrors for a tall pane", () => {
    const a = tetherAspect(500, 1000)
    expect(a.x).toBeGreaterThan(1)
    expect(a.y).toBeLessThan(1)
  })

  it("clamps an extreme window rather than stretching the map into a line", () => {
    const a = tetherAspect(6000, 300)
    expect(a.y).toBeLessThan(2)
    expect(a.x).toBeGreaterThan(0.5)
  })

  it("survives a pane that has not been measured yet", () => {
    // The ResizeObserver has not fired on the first render; 0 must not become
    // a division by zero that NaNs every node position.
    for (const [w, h] of [[0, 0], [800, 0], [0, 600], [-1, 5]]) {
      const a = tetherAspect(w, h)
      expect(Number.isFinite(a.x)).toBe(true)
      expect(Number.isFinite(a.y)).toBe(true)
    }
  })
})
