/**
 * Bake the demo maps' settled layouts into the site.
 *
 * The graph's force settle is deterministic re-computation — same map, same
 * recipe, same equilibrium — and on a 2,500-node map it is also the whole
 * perceived load time. Repeat visits already skip it via localStorage
 * (lib/graph/layoutCache.ts); this script covers the FIRST visit by running
 * the same recipe headless for every committed demo map and writing the
 * settled positions to `public/layouts/<slug>.json`, where the canvas fetches
 * them as a seed.
 *
 * FIDELITY. Node identity, degrees, radii, clusters, spring metadata and every
 * force constant come from the same modules the canvas imports (`graphOf`,
 * `lib/graph/layout`, `lib/graph/cluster`), so the bake cannot disagree with
 * the app about what the graph IS. What it approximates is context the canvas
 * only knows at runtime — the pane's aspect ratio (assumed 1700x760, the
 * measured demo pane) and the lobe force, mirrored from GraphCanvas's
 * `makeClusterForce`. Any drift is absorbed on arrival: the canvas applies a
 * baked seed exactly like a remembered one, behind the same coverage gate, and
 * still runs its short relax under the real recipe.
 *
 *   cd packages/web && npx tsx scripts/bake-layouts.ts
 *
 * Re-run whenever demo/maps changes or the recipe in lib/graph/layout.ts moves.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  forceX,
  forceY,
} from "d3-force"
import { graphOf } from "../lib/kb-from-run"
import type { CompletedRun } from "../lib/runs"
import { nodeTypeOf } from "../lib/nodeTypes"
import {
  ALPHA_DECAY,
  VELOCITY_DECAY,
  chargeDistanceMax,
  chargeStrength,
  cooldownTicks,
  isHubDegree,
  linkDistance,
  linkStrength,
  seatRadius,
  seedPosition,
  tetherAspect,
  tetherStrength,
} from "../lib/graph/layout"
import { assignClusters, measureClusters, separationShoves } from "../lib/graph/cluster"

const HERE = dirname(fileURLToPath(import.meta.url))
const MAPS_DIR = join(HERE, "..", "..", "..", "demo", "maps")
const OUT_DIR = join(HERE, "..", "public", "layouts")

/* The demo pane, as measured in GraphCanvas's own comments. */
const PANE = { w: 1700, h: 760 }
/* Mirrors GraphCanvas.tsx — the lobe force's two constants. */
const CLUSTER_PAD_SEATS = 1.6
const CLUSTER_SHOVE = 0.12

interface SimNode {
  id: string
  deg: number
  r: number
  isHub: boolean
  hub: boolean
  x: number
  y: number
  vx?: number
  vy?: number
}

function bakeVariant(
  graph: ReturnType<typeof graphOf>,
  showUnplaced: boolean,
): { count: number; n: Record<string, [number, number]> } {
  /* Degrees and adjacency over the FULL graph, exactly as the canvas's meta
     memo computes them; the node list is filtered afterwards. */
  const degById = new Map<string, number>()
  const adj = new Map<string, Set<string>>()
  for (const n of graph.nodes) {
    degById.set(n.id, 0)
    adj.set(n.id, new Set())
  }
  for (const l of graph.edges) {
    if (!degById.has(l.source) || !degById.has(l.target)) continue
    degById.set(l.source, (degById.get(l.source) ?? 0) + 1)
    degById.set(l.target, (degById.get(l.target) ?? 0) + 1)
    adj.get(l.source)!.add(l.target)
    adj.get(l.target)!.add(l.source)
  }
  const maxRel = Math.max(1, ...graph.nodes.map((n) => n.relevance || 0))
  let hubId = ""
  let hubScore = -1
  let maxDeg = 0
  for (const n of graph.nodes) {
    const deg = degById.get(n.id) ?? 0
    if (deg > maxDeg) maxDeg = deg
    const score = deg + (nodeTypeOf(n.group) === "core" ? 0.5 : 0)
    if (score > hubScore) {
      hubScore = score
      hubId = n.id
    }
  }

  const list = graph.nodes.filter((n) => showUnplaced || n.relation !== "none")
  const nodeCount = Math.max(1, list.length)
  const nodes: SimNode[] = list.map((n) => {
    const deg = degById.get(n.id) ?? 0
    const isHub = n.id === hubId
    const rel = Math.max(0, n.relevance || 0)
    const seed = seedPosition({ id: n.id, deg, r: 0, isHub }, nodeCount, maxDeg)
    return {
      id: n.id,
      deg,
      r: 4 + Math.sqrt(rel / maxRel) * 12,
      isHub,
      hub: isHubDegree(deg),
      x: seed.x,
      y: seed.y,
    }
  })
  const clusterOf = assignClusters(nodes, adj)

  const byId = new Set(nodes.map((n) => n.id))
  const links = graph.edges
    .filter((l) => byId.has(l.source) && byId.has(l.target))
    .map((l) => {
      const sDeg = degById.get(l.source) ?? 0
      const tDeg = degById.get(l.target) ?? 0
      return {
        source: l.source,
        target: l.target,
        hubLink: l.source === hubId || l.target === hubId,
        parentDeg: Math.max(sDeg, tDeg),
      }
    })

  const meanR = nodes.reduce((a, n) => a + n.r, 0) / Math.max(1, nodes.length)
  const seat = seatRadius(meanR, 1)
  const aspect = tetherAspect(PANE.w, PANE.h)
  const pad = seat * CLUSTER_PAD_SEATS

  /* The lobe force, mirrored from GraphCanvas's makeClusterForce at the
     shipped defaults (cohesion 1, spacing 1). */
  const cluster = (alpha: number) => {
    const discs = measureClusters(nodes, clusterOf)
    if (discs.size === 0) return
    for (const nd of nodes) {
      const d = discs.get(clusterOf.get(nd.id) ?? nd.id)
      if (!d || d.n < 2) continue
      nd.vx = (nd.vx ?? 0) + (d.x - nd.x) * 0.06 * alpha
      nd.vy = (nd.vy ?? 0) + (d.y - nd.y) * 0.06 * alpha
    }
    const shoves = separationShoves([...discs.values()], pad)
    if (shoves.size === 0) return
    const kx = aspect.y ** 3
    const ky = aspect.x ** 3
    for (const nd of nodes) {
      const s = shoves.get(clusterOf.get(nd.id) ?? nd.id)
      if (!s) continue
      nd.vx = (nd.vx ?? 0) + s.dx * CLUSTER_SHOVE * kx
      nd.vy = (nd.vy ?? 0) + s.dy * CLUSTER_SHOVE * ky
    }
  }

  const sim = forceSimulation(nodes as never[])
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .force(
      "charge",
      forceManyBody()
        .strength((n) => chargeStrength(n as never))
        .distanceMax(chargeDistanceMax(nodeCount))
        .distanceMin(2),
    )
    .force(
      "link",
      forceLink(links as never[])
        .id((n) => (n as SimNode).id)
        .distance((l) => linkDistance(l as never, nodeCount, seat))
        .strength((l) => linkStrength(l as never)),
    )
    .force(
      "collide",
      forceCollide()
        .radius((n) => seatRadius((n as SimNode).r, 1))
        .strength(0.9)
        .iterations(3),
    )
    .force("x", forceX(0).strength((n) => tetherStrength(n as never) * aspect.x))
    .force("y", forceY(0).strength((n) => tetherStrength(n as never) * aspect.y))
    .force("cluster", cluster)
    .stop()

  /* The canvas budget plus headroom — the bake pays once, offline, so it can
     afford to be certain the lobes have finished separating. */
  const ticks = cooldownTicks(nodeCount) + 200
  for (let i = 0; i < ticks; i++) sim.tick()

  const out: Record<string, [number, number]> = {}
  for (const n of nodes) out[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10]
  return { count: nodes.length, n: out }
}

mkdirSync(OUT_DIR, { recursive: true })
for (const file of readdirSync(MAPS_DIR).filter((f) => f.endsWith(".json"))) {
  const slug = file.replace(/\.json$/, "")
  const raw = JSON.parse(readFileSync(join(MAPS_DIR, file), "utf8"))
  const graph = graphOf({ result: raw } as CompletedRun)
  const started = Date.now()
  const u1 = bakeVariant(graph, true)
  const u0 = bakeVariant(graph, false)
  writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify({ u1, u0 }))
  console.log(
    `${slug}: ${u1.count} nodes (u0 ${u0.count}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
}
console.log("baked into", OUT_DIR)
