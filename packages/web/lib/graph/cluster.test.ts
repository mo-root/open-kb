import { describe, expect, it } from "vitest"
import {
  RMS_TO_RADIUS,
  assignClusters,
  measureClusters,
  separationShoves,
  type ClusterDisc,
  type ClusterMember,
} from "./cluster"

const adjOf = (pairs: [string, string][]): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    if (!m.has(a)) m.set(a, new Set())
    m.get(a)!.add(b)
  }
  for (const [a, b] of pairs) {
    add(a, b)
    add(b, a)
  }
  return m
}

const nodesOf = (adj: Map<string, Set<string>>, extra: string[] = []): ClusterMember[] =>
  [...new Set([...adj.keys(), ...extra])].map((id) => ({
    id,
    deg: adj.get(id)?.size ?? 0,
  }))

describe("assignClusters", () => {
  it("puts a leaf in its parent's lobe", () => {
    const adj = adjOf([
      ["hub", "a"],
      ["hub", "b"],
      ["hub", "c"],
    ])
    const c = assignClusters(nodesOf(adj), adj)
    expect(c.get("a")).toBe("hub")
    expect(c.get("b")).toBe("hub")
    expect(c.get("hub")).toBe("hub") // nothing bigger next to it
  })

  it("keeps two hubs in separate lobes when they do not touch", () => {
    const adj = adjOf([
      ["h1", "a"],
      ["h1", "b"],
      ["h1", "c"],
      ["h2", "x"],
      ["h2", "y"],
    ])
    const c = assignClusters(nodesOf(adj), adj)
    expect(c.get("h1")).toBe("h1")
    expect(c.get("h2")).toBe("h2")
    expect(new Set(c.values())).toEqual(new Set(["h1", "h2"]))
  })

  /* THE property the whole design rests on. Following the chain to a global
     maximum would merge every lobe as soon as one hub touched a bigger one —
     and on a star-shaped map, where the anchor touches everything, that is one
     cluster containing the entire graph and nothing left to separate. */
  it("does not chain: a hub touching a bigger hub keeps its own fan", () => {
    const adj = adjOf([
      // big: 4 leaves + a link to `small`
      ["big", "b1"],
      ["big", "b2"],
      ["big", "b3"],
      ["big", "small"],
      // small: 2 leaves of its own
      ["small", "s1"],
      ["small", "s2"],
    ])
    const c = assignClusters(nodesOf(adj), adj)
    expect(c.get("small")).toBe("big") // small itself joins big — one hop
    // but small's OWN leaves stay with small; they never chain up to big
    expect(c.get("s1")).toBe("small")
    expect(c.get("s2")).toBe("small")
    expect(c.get("b1")).toBe("big")
  })

  it("leaves a disconnected node as its own lobe", () => {
    const adj = adjOf([["hub", "a"]])
    const c = assignClusters(nodesOf(adj, ["lonely"]), adj)
    expect(c.get("lonely")).toBe("lonely")
  })

  it("ignores a neighbour that is not in the node list", () => {
    // `ghost` is adjacent to `a` and bigger than `hub`, but it has been
    // filtered out of the layout (a hidden type, an unplaced node). It must not
    // win a lobe it is not in — `a` belongs to the biggest neighbour still on
    // the map. Degrees still count the filtered edges, exactly as meta.degById
    // does in the canvas.
    const adj = adjOf([
      ["hub", "a"],
      ["hub", "h1"],
      ["hub", "h2"],
      ["a", "ghost"],
      ["ghost", "g1"],
      ["ghost", "g2"],
      ["ghost", "g3"],
      ["ghost", "g4"],
    ])
    const nodes = nodesOf(adj).filter((n) => n.id !== "ghost")
    const c = assignClusters(nodes, adj)
    expect(c.get("a")).toBe("hub") // not "ghost", which outranks it 5 to 3
    expect([...c.values()]).not.toContain("ghost")
  })

  it("breaks ties on the lower id, so the same graph clusters the same way", () => {
    // `n` sits between two equally-sized hubs and must pick the same one
    // regardless of the order the node list happens to arrive in.
    const adj = adjOf([
      ["zeta", "z1"],
      ["zeta", "z2"],
      ["zeta", "n"],
      ["alpha", "a1"],
      ["alpha", "a2"],
      ["alpha", "n"],
    ])
    const nodes = nodesOf(adj)
    expect(nodes.find((x) => x.id === "zeta")!.deg).toBe(
      nodes.find((x) => x.id === "alpha")!.deg,
    )
    const a = assignClusters(nodes, adj)
    const b = assignClusters([...nodes].reverse(), adj)
    expect(a.get("n")).toBe("alpha")
    expect(b.get("n")).toBe("alpha")
  })

  it("assigns every node exactly one lobe", () => {
    const adj = adjOf([
      ["h", "a"],
      ["h", "b"],
      ["h", "c"],
      ["k", "d"],
    ])
    const nodes = nodesOf(adj, ["solo"])
    const c = assignClusters(nodes, adj)
    expect(c.size).toBe(nodes.length)
    for (const n of nodes) expect(c.get(n.id)).toBeTruthy()
  })
})

describe("measureClusters", () => {
  it("puts the centre at the mean of the members", () => {
    const nodes: ClusterMember[] = [
      { id: "a", deg: 1, x: 0, y: 0 },
      { id: "b", deg: 1, x: 10, y: 0 },
      { id: "c", deg: 1, x: 0, y: 10 },
      { id: "d", deg: 1, x: 10, y: 10 },
    ]
    const of = new Map(nodes.map((n) => [n.id, "L"]))
    const d = measureClusters(nodes, of).get("L")!
    expect(d.x).toBeCloseTo(5)
    expect(d.y).toBeCloseTo(5)
    expect(d.n).toBe(4)
  })

  it("derives the radius from the RMS spread", () => {
    // Four points at distance 10 from the centre: rms = 10.
    const nodes: ClusterMember[] = [
      { id: "a", deg: 1, x: 10, y: 0 },
      { id: "b", deg: 1, x: -10, y: 0 },
      { id: "c", deg: 1, x: 0, y: 10 },
      { id: "d", deg: 1, x: 0, y: -10 },
    ]
    const of = new Map(nodes.map((n) => [n.id, "L"]))
    expect(measureClusters(nodes, of).get("L")!.r).toBeCloseTo(10 * RMS_TO_RADIUS)
  })

  /* Why RMS and not max: one leaf on a long spring must not inflate the disc
     into empty space and shove a neighbouring lobe out of a region that is
     visibly free. */
  it("is barely moved by a single far outlier", () => {
    const core: ClusterMember[] = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      deg: 1,
      x: Math.cos(i) * 10,
      y: Math.sin(i) * 10,
    }))
    const of = new Map<string, string>()
    for (const n of core) of.set(n.id, "L")
    const tight = measureClusters(core, of).get("L")!.r

    const withOutlier = [...core, { id: "far", deg: 1, x: 400, y: 0 }]
    of.set("far", "L")
    const loose = measureClusters(withOutlier, of).get("L")!.r

    // The max-distance radius would jump ~40x; RMS must stay in the same league.
    expect(loose).toBeLessThan(tight * 10)
  })

  it("skips nodes with no position yet, and NaN", () => {
    const nodes: ClusterMember[] = [
      { id: "a", deg: 1, x: 0, y: 0 },
      { id: "b", deg: 1 },
      { id: "c", deg: 1, x: NaN, y: 0 },
    ]
    const of = new Map(nodes.map((n) => [n.id, "L"]))
    const d = measureClusters(nodes, of).get("L")!
    expect(d.n).toBe(1)
    expect(Number.isFinite(d.x)).toBe(true)
    expect(Number.isFinite(d.r)).toBe(true)
  })
})

describe("separationShoves", () => {
  const disc = (
    id: string,
    x: number,
    y: number,
    r: number,
    n = 10,
    fixed = false,
  ): ClusterDisc => ({ id, x, y, r, n, fixed })

  it("leaves lobes that already clear each other alone", () => {
    const s = separationShoves([disc("a", 0, 0, 10), disc("b", 100, 0, 10)], 20)
    expect(s.size).toBe(0)
  })

  it("pushes overlapping lobes apart along the line between them", () => {
    const s = separationShoves([disc("a", 0, 0, 10), disc("b", 15, 0, 10)], 0)
    expect(s.get("a")!.dx).toBeLessThan(0)
    expect(s.get("b")!.dx).toBeGreaterThan(0)
    expect(s.get("a")!.dy).toBeCloseTo(0)
  })

  it("closes exactly the overlap, no more", () => {
    // want = 10 + 10 + 5 = 25, d = 15 -> overlap 10, split evenly at equal mass
    const s = separationShoves([disc("a", 0, 0, 10), disc("b", 15, 0, 10)], 5)
    const moved = Math.abs(s.get("a")!.dx) + Math.abs(s.get("b")!.dx)
    expect(moved).toBeCloseTo(10)
  })

  it("makes the small lobe do most of the moving", () => {
    const s = separationShoves([disc("big", 0, 0, 10, 300), disc("small", 15, 0, 10, 5)], 0)
    expect(Math.abs(s.get("small")!.dx)).toBeGreaterThan(Math.abs(s.get("big")!.dx) * 10)
  })

  /* A NaN here reaches every node's velocity within one tick and the map is
     simply gone, so the degenerate case is a test rather than a comment. */
  it("resolves two lobes sitting on the exact same point, finitely and stably", () => {
    const pair = [disc("a", 40, 40, 10), disc("b", 40, 40, 10)]
    const s = separationShoves(pair, 5)
    for (const v of s.values()) {
      expect(Number.isFinite(v.dx)).toBe(true)
      expect(Number.isFinite(v.dy)).toBe(true)
    }
    expect(Math.hypot(s.get("a")!.dx, s.get("a")!.dy)).toBeGreaterThan(0)
    // deterministic: same input, same direction, every time
    const again = separationShoves([disc("a", 40, 40, 10), disc("b", 40, 40, 10)], 5)
    expect(again.get("a")).toEqual(s.get("a"))
  })

  /* The anchor is pinned at the origin, so shoving its lobe would move its 342
     children while the hub itself stayed put — the fan walks away and the
     anchor ends up sitting outside its own lobe. Measured at 1,398 units on a
     real map before this rule existed. */
  it("makes a pinned lobe immovable and lets its neighbour absorb everything", () => {
    const s = separationShoves(
      [disc("pinned", 0, 0, 10, 300, true), disc("free", 15, 0, 10, 5)],
      5,
    )
    expect(s.get("pinned")).toBeUndefined()
    expect(s.get("free")!.dx).toBeCloseTo(10) // the whole overlap, not a share
  })

  it("does not waste motion when both lobes are pinned", () => {
    const s = separationShoves(
      [disc("a", 0, 0, 10, 30, true), disc("b", 15, 0, 10, 30, true)],
      5,
    )
    expect(s.size).toBe(0)
  })

  it("accumulates shoves from several crowding neighbours", () => {
    const s = separationShoves(
      [disc("mid", 0, 0, 10), disc("left", -12, 0, 10), disc("right", 12, 0, 10)],
      0,
    )
    // Squeezed from both sides, so the middle lobe barely moves sideways…
    expect(Math.abs(s.get("mid")!.dx)).toBeLessThan(1)
    // …while the outer two are each pushed away.
    expect(s.get("left")!.dx).toBeLessThan(0)
    expect(s.get("right")!.dx).toBeGreaterThan(0)
  })

  it("converges: repeatedly applying the shove clears the overlap", () => {
    let a = disc("a", 0, 0, 10)
    let b = disc("b", 4, 0, 10)
    for (let i = 0; i < 400; i++) {
      const s = separationShoves([a, b], 5)
      if (s.size === 0) break
      a = { ...a, x: a.x + (s.get("a")?.dx ?? 0) * 0.12 }
      b = { ...b, x: b.x + (s.get("b")?.dx ?? 0) * 0.12 }
    }
    expect(Math.abs(b.x - a.x)).toBeGreaterThanOrEqual(25 - 0.5)
  })
})
