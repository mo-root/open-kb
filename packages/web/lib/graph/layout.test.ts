import { describe, expect, it } from "vitest"
import {
  HUB_DEGREE,
  chargeDistanceMax,
  chargeStrength,
  hashUnit,
  isHubDegree,
  linkDistance,
  linkStrength,
  seatRadius,
  SEAT_FLOOR,
  seedPosition,
  span,
  tetherAspect,
  tetherStrength,
  WARMUP_TICKS,
  cooldownTicks,
  ALPHA_MIN,
  ALPHA_DECAY,
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

describe("seatRadius", () => {
  it("is the drawn radius plus the floor when spacing is zero", () => {
    // At spacing 0 the proportional term drops out entirely — the floor is
    // the only padding a node gets, never zero padding.
    expect(seatRadius(10, 0)).toBe(10 + SEAT_FLOOR)
  })

  it("claims half again its own radius per unit of spacing, on top of the floor", () => {
    expect(seatRadius(10, 1)).toBe(10 * 1.5 + SEAT_FLOOR)
    expect(seatRadius(10, 2)).toBe(10 * 2 + SEAT_FLOOR)
  })

  it("clamps negative spacing to zero rather than shrinking the seat below the floor", () => {
    // Nothing constructs a negative spacing today, but the dial is user-facing
    // and the clamp is what stands between a bad value and a seat smaller than
    // the node it is meant to pad.
    expect(seatRadius(10, -5)).toBe(seatRadius(10, 0))
  })

  it("keeps the floor even for a zero-radius node", () => {
    expect(seatRadius(0, 3)).toBe(SEAT_FLOOR)
  })
})

describe("linkDistance", () => {
  it("seats a large fan on a longer spring than a small one", () => {
    // 82 children on the same 55-unit spring as 3 children is a filled disc.
    const wide = linkDistance({ parentDeg: 82, hubLink: false }, 295)
    const narrow = linkDistance({ parentDeg: 3, hubLink: false }, 295)
    expect(wide).toBeGreaterThan(narrow * 1.5)
  })

  /* The spring must be SHORTER than the disc a fan needs, so that collide has
     something to push against and the children fill the disc instead of lining
     up on one hoop. When it was longer, every market drew as a thin crescent
     with its hub stranded at the tip. */
  it("falls short of the packing radius, so a fan fills a disc not a hoop", () => {
    const seat = 17
    for (const fan of [38, 82, 164, 342]) {
      const packing = seat * Math.sqrt(fan) // radius a filled disc of `fan` needs
      expect(linkDistance({ parentDeg: fan, hubLink: false }, 849, seat)).toBeLessThan(
        packing,
      )
    }
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
  it("holds a disconnected node harder than a connected one", () => {
    /* An entity with relation:"none" has no spring at all; without a firmer
       tether it is thrown off-canvas and drags zoomToFit's bounding box with
       it, shrinking the real map to a dot.
       This used to demand a 4x margin, from when the connected tether was 0.008
       and the ratio was 16x. The connected tether is now 0.064 (see
       tetherStrength) so the ratio is 2x, and the margin was measuring the
       wrong thing anyway — what matters is that nothing else holds a
       disconnected node, so it must be held strictly harder. Measured on the
       849-node map, the lone degree-0 entity settles at radius 430 against a
       connected median of 752: comfortably inside the map, not escaping it. */
    expect(tetherStrength(node({ deg: 0 }))).toBeGreaterThan(tetherStrength(node({ deg: 4 })))
  })

  /* The compaction pass. Repulsion used to do two jobs — separate nodes AND
     reserve each market its room — and the lobe force now owns the second, so
     the duplicated push was flinging the lobes into a layout that filled 23% of
     its own bounding box. Lighter charge plus a firmer tether takes the fitted
     scale from 0.31 to 0.42 (a ~38% bigger node on screen) with no new
     overlaps. Both directions are asserted so a future "let's spread it out"
     tweak has to argue with the measurement. */
  it("keeps the map gathered: the tether is no longer negligible", () => {
    expect(tetherStrength(node({ deg: 4 }))).toBeGreaterThan(0.03)
    expect(tetherStrength(node({ deg: 4 }))).toBeLessThan(0.13)
  })

  it("leaves room-reserving to the lobe force rather than to charge", () => {
    // A 342-child market still repels far harder than a leaf...
    expect(chargeStrength(node({ deg: 342 }))).toBeLessThan(chargeStrength(node({ deg: 1 })))
    // ...but not so hard that it throws its neighbours off the canvas.
    expect(chargeStrength(node({ deg: 342 }))).toBeGreaterThan(-1800)
  })

  /* The anchor used to be exempt because it was pinned with fx/fy. It is not
     pinned any more — an immovable member inside a lobe that has to move to
     satisfy the separation constraint is what walked the anchor's own fan 1,398
     units away from it. So it is tethered like any other connected node. */
  it("tethers the anchor like any other connected node, since it is not pinned", () => {
    expect(tetherStrength(node({ isHub: true, deg: 300 }))).toBe(
      tetherStrength(node({ isHub: false, deg: 4 })),
    )
    expect(tetherStrength(node({ isHub: true, deg: 300 }))).toBeGreaterThan(0)
  })
})

describe("settling schedule", () => {
  /* THE WARMUP RAN THE WRONG FORCES.
     force-graph spends warmupTicks inside its own graphData update, which
     happens on mount — before the React effect that installs this recipe. So
     every warmup tick integrated the library's defaults (charge -30, link
     distance 30) on a map tuned for charge -900, crushed 849 nodes into a pile,
     and left the real forces to dig back out within the cooldown budget.
     Measured: a median gap between drawn rims of -0.4 units where the recipe
     asks for 47.6. A warmup that runs the wrong physics is worse than none. */
  it("does no blocking warmup, because the library would run it too early", () => {
    expect(WARMUP_TICKS).toBe(0)
  })

  it("gives every map a real settle budget, reduced motion included", () => {
    // Reduced motion used to get 0 cooldown and a huge warmup instead, which —
    // once the warmup was known to run the wrong forces — meant those readers
    // got a layout built ENTIRELY by force-graph's defaults. The budget is now
    // the same for everyone; "no motion" is kept by hiding the canvas until it
    // settles, not by refusing to compute the layout.
    expect(cooldownTicks(295, true)).toBe(cooldownTicks(295, false))
    expect(cooldownTicks(295)).toBeGreaterThan(0)
  })

  /* The lobe separation converges more slowly than the node-level forces: on
     the 849-node map two lobe pairs were still overlapping when the engine
     stopped at 320 ticks, and zero at 400. The budget has to outlast it. */
  it("gives a large map long enough for its lobes to finish separating", () => {
    expect(cooldownTicks(849)).toBeGreaterThanOrEqual(400)
  })

  it("scales the budget with the map but stays bounded", () => {
    expect(cooldownTicks(680)).toBeGreaterThan(cooldownTicks(150))
    expect(cooldownTicks(100000)).toBeLessThanOrEqual(440)
  })

  /* ALPHA_MIN MUST STAY 0, AND THE REASON IS NOT OBVIOUS.
     A positive floor looks like the tidy way to make the simulation genuinely
     stop, and it silently disables every ripple a drag produces. force-graph
     checks the floor BEFORE ticking (canvas-force-graph.js:135-141), so a
     settled map — which by definition sits just under the floor — re-stops on
     every drag frame and the tick that would raise alpha toward the drag's
     alphaTarget never runs. Grab a node and it moves alone. */
  it("uses a zero alpha floor so a drag can reheat a settled layout", () => {
    expect(ALPHA_MIN).toBe(0)
    expect(Number.isFinite(cooldownTicks(849))).toBe(true)
  })

  it("cools to a visually dead alpha within the cooldown budget", () => {
    // With no alpha floor, cooldownTicks is the only thing that stops the
    // engine, so it has to outlast the decay rather than cut it off early.
    expect(Math.pow(1 - ALPHA_DECAY, cooldownTicks(849))).toBeLessThan(0.01)
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
