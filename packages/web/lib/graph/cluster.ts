/**
 * Lobes: finding them, measuring them, and keeping them off each other.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OLD CLUSTERING DID NOTHING
 *
 * The canvas ran a force that pulled every node toward its own TYPE's centroid.
 * Measured against a real map, that is not a clustering signal at all — there
 * are exactly five distinct `group` values on an 849-node brightdata run:
 *
 *     429 players · 163 communities · 129 products · 127 unplaced · 1 overview
 *
 * So the force was dragging all 429 players toward one point, all 163
 * communities toward another, and so on. Those are not lobes, they are legend
 * rows. Worse, the map's actual structure cuts ACROSS them: a market's fan is a
 * mix of players and communities, so pulling by type actively pulled each lobe
 * apart while the springs were trying to hold it together.
 *
 * WHAT THE STRUCTURE ACTUALLY IS
 *
 * Degree, on the same run: 739 of 849 nodes have degree 1, and the top degrees
 * are 292, 167, 164, 163 and 49 — five product hubs. The visible donuts ARE
 * those hubs' fans. So a node's lobe is simply "the biggest thing I am attached
 * to", and a hub, having nothing bigger next to it, anchors its own. That rule
 * recovers seven clusters of 293/167/164/163/49/12/1 — the picture, exactly.
 *
 * TWO LEVELS OF COLLISION
 *
 * `forceCollide` stops two NODES overlapping. Nothing stopped two LOBES
 * overlapping, because no force in the recipe knew a lobe existed: charge is
 * per-node and capped by distance, so two clusters could interleave into one
 * ambiguous mass and every individual pair of nodes would still be perfectly
 * legal. Measuring each lobe as a disc and pushing overlapping discs apart is
 * the missing level.
 */

export interface ClusterMember {
  id: string
  deg: number
  x?: number
  y?: number
  /** d3 writes fx/fy to PIN a node. The anchor is pinned by the recipe; any
   *  node is pinned for as long as a reader is dragging it. */
  fx?: number
  fy?: number
}

/** A lobe reduced to a circle: where it is, how big, and how heavy. */
export interface ClusterDisc {
  id: string
  x: number
  y: number
  /** Working radius — see `measureClusters` for why it is not the max. */
  r: number
  /** Member count. Doubles as mass when two discs shove each other. */
  n: number
  /**
   * Contains a pinned node, so the lobe cannot actually go anywhere.
   *
   * The anchor is pinned at the origin by the recipe, and a shove applied to
   * its lobe moves its 342 CHILDREN while the hub itself stays put — measured
   * on a real map, that walked the fan 1,398 units away and left the anchor
   * sitting outside its own lobe. A pinned lobe is therefore treated as
   * immovable and its neighbour absorbs the whole separation, which is also the
   * composition the pin was always reaching for: the anchor is the landmark and
   * everything else arranges around it.
   */
  fixed: boolean
}

/**
 * Which lobe each node belongs to.
 *
 * The rule is one line: a node joins its highest-degree neighbour, or keeps
 * itself if nothing next to it is bigger. Leaves fall into their parent's fan;
 * a hub, surrounded by leaves, anchors its own.
 *
 * Deliberately NOT transitive. Following the chain to a global maximum would
 * merge every lobe the moment one hub happened to link to another — and on a
 * star-shaped map, where the anchor touches everything, that collapses the
 * whole graph into a single cluster and the separation force below has nothing
 * left to separate. One hop is what keeps the five real fans distinct.
 *
 * Ties break on the lower id so the same graph always produces the same lobes;
 * a clustering that reshuffled between runs would make a reader think the data
 * had changed.
 */
export function assignClusters(
  nodes: ClusterMember[],
  adj: Map<string, Set<string>>,
): Map<string, string> {
  const degOf = new Map(nodes.map((n) => [n.id, n.deg]))
  const out = new Map<string, string>()
  for (const n of nodes) {
    let bestId = n.id
    let bestDeg = n.deg
    for (const m of adj.get(n.id) ?? []) {
      // `m` may not be in the node list (a filtered type, a hidden unplaced) —
      // an absent node has no degree to beat.
      const d = degOf.get(m)
      if (d === undefined) continue
      if (d > bestDeg || (d === bestDeg && m < bestId)) {
        bestDeg = d
        bestId = m
      }
    }
    out.set(n.id, bestId)
  }
  return out
}

/**
 * A radius that describes the lobe rather than its worst outlier.
 *
 * `max(distance)` is the obvious choice and the wrong one: one leaf flung wide
 * by a long spring would inflate the disc to twice the lobe it represents, and
 * the separation force would then shove a neighbouring cluster out of a region
 * that is, visibly, empty. Root-mean-square distance is set by where the bulk
 * of the members actually are, and a single far member barely moves it.
 *
 * The 1.45 converts that back into an enclosing radius: members spread evenly
 * over a disc of radius R have mean squared distance R²/2, so R = √2 · rms.
 * Rounded up slightly, because a lobe is denser at its rim than a uniform disc.
 */
export const RMS_TO_RADIUS = 1.45

export function measureClusters(
  nodes: ClusterMember[],
  clusterOf: Map<string, string>,
): Map<string, ClusterDisc> {
  const acc = new Map<string, { x: number; y: number; n: number; fixed: boolean }>()
  for (const n of nodes) {
    if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    const k = clusterOf.get(n.id) ?? n.id
    const pinned = n.fx != null || n.fy != null
    const a = acc.get(k)
    if (a) {
      a.x += n.x
      a.y += n.y
      a.n += 1
      a.fixed ||= pinned
    } else {
      acc.set(k, { x: n.x, y: n.y, n: 1, fixed: pinned })
    }
  }

  const out = new Map<string, ClusterDisc>()
  for (const [k, a] of acc) {
    out.set(k, { id: k, x: a.x / a.n, y: a.y / a.n, r: 0, n: a.n, fixed: a.fixed })
  }

  // Second pass for the spread, now that the centres are known.
  const sq = new Map<string, number>()
  for (const n of nodes) {
    if (n.x == null || n.y == null || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    const k = clusterOf.get(n.id) ?? n.id
    const d = out.get(k)
    if (!d) continue
    const dx = n.x - d.x
    const dy = n.y - d.y
    sq.set(k, (sq.get(k) ?? 0) + dx * dx + dy * dy)
  }
  for (const [k, d] of out) {
    d.r = Math.sqrt((sq.get(k) ?? 0) / d.n) * RMS_TO_RADIUS
  }
  return out
}

/** How far one disc must move this tick to stop overlapping its neighbours. */
export interface Shove {
  dx: number
  dy: number
}

/**
 * Push overlapping lobes apart.
 *
 * Pairwise and O(k²), which is free: a map of 849 nodes produces seven
 * clusters, so this is 21 comparisons per tick against the 849 the node-level
 * forces already do.
 *
 * The shove is split by MASS — a fan of 293 barely yields to a fan of 12, the
 * small one does most of the moving. Splitting it evenly instead made the big
 * central lobe wander every time a small one brushed it, and a map whose
 * biggest landmark drifts is a map that never looks settled.
 */
export function separationShoves(
  discs: ClusterDisc[],
  pad: number,
): Map<string, Shove> {
  const out = new Map<string, Shove>()
  const add = (id: string, dx: number, dy: number) => {
    const s = out.get(id)
    if (s) {
      s.dx += dx
      s.dy += dy
    } else {
      out.set(id, { dx, dy })
    }
  }

  for (let i = 0; i < discs.length; i++) {
    for (let j = i + 1; j < discs.length; j++) {
      const a = discs[i]
      const b = discs[j]
      const want = a.r + b.r + pad
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d = Math.sqrt(dx * dx + dy * dy)

      if (d >= want) continue

      if (d === 0 || !Number.isFinite(d)) {
        /* Two lobes sitting on the exact same point have no direction to
           separate along, and `dx/d` would be NaN — which in a velocity
           Verlet integrator spreads to every node within one tick and deletes
           the map. The tie is broken deterministically off the ids rather than
           at random, so the same coincidence always resolves the same way. */
        const t = ((hashAngle(a.id) + hashAngle(b.id)) % 1) * Math.PI * 2
        dx = Math.cos(t)
        dy = Math.sin(t)
        d = 1
      } else {
        dx /= d
        dy /= d
      }

      const overlap = want - d
      /* Who yields. A pinned lobe cannot move at all, so its neighbour absorbs
         everything — shoving it would only walk its free members away from the
         member holding it in place. Otherwise each disc yields in proportion to
         the OTHER's size, so a fan of 12 does the travelling and a fan of 342
         barely registers it: a map whose biggest landmark drifts every time a
         small lobe brushes it never looks settled. */
      let aShare: number
      let bShare: number
      if (a.fixed && b.fixed) {
        continue // neither can move; shoving both is wasted motion
      } else if (a.fixed) {
        aShare = 0
        bShare = 1
      } else if (b.fixed) {
        aShare = 1
        bShare = 0
      } else {
        const total = a.n + b.n
        aShare = total > 0 ? b.n / total : 0.5
        bShare = 1 - aShare
      }
      if (aShare > 0) add(a.id, -dx * overlap * aShare, -dy * overlap * aShare)
      if (bShare > 0) add(b.id, dx * overlap * bShare, dy * overlap * bShare)
    }
  }
  return out
}

/** Deterministic 0..1 from an id — only used to break an exact-overlap tie. */
function hashAngle(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}
