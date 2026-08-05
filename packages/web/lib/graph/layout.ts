/**
 * The force recipe, as pure functions.
 *
 * Pulled out of the canvas so the numbers can be reasoned about and tested
 * without a browser, a simulation, or a screenshot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GRAPH LOOKED LIKE A DANDELION
 *
 * Three separate defects, each verified in the canvas before this file existed:
 *
 * 1. d3's default `forceCenter` was never removed. react-force-graph installs
 *    charge + link + center; the canvas replaced the first two and added its
 *    own x/y tethers, but `center` stayed. It translates the WHOLE graph every
 *    tick to keep the centroid at the origin, fighting the tethers forever —
 *    that is the slow orbit that never settles.
 *
 * 2. `forceManyBody` had no `distanceMax`, so every node repelled every other
 *    node across the entire canvas. All-pairs pressure inflates any layout into
 *    a uniform disc and flattens exactly the local structure the map is FOR.
 *
 * 3. Hub-ness was identity, not shape: `isHub = n.id === hubId` meant the
 *    ANCHOR and nothing else. On a real map that is measurably wrong — the
 *    anchor is not the hub. Of 295 nodes and 400 edges on brightdata, 249 have
 *    degree 1 and the top degrees are markets at 82, 64 and 55. So the seven
 *    market lobes — the actual structure — were being laid out with the
 *    settings meant for leaves: 82 children on springs of length 55 around one
 *    point, which is a solid disc of overlapping circles.
 *
 * The fix keeps the layout force-directed and organic (d3-force's velocity
 * Verlet integrator is the same family Obsidian uses, so this is tuning toward
 * the requested feel, not away from it). It changes what the forces are told
 * about the graph: hub-ness is DEGREE, link length grows with how many children
 * a parent has, and repulsion is local.
 */

/** What the recipe needs to know about a node. Deliberately structural — no
 *  colours, no titles, nothing that would tie the layout to the renderer. */
export interface LayoutNode {
  id: string
  /** Edge count. The only thing that decides how much room a node claims. */
  deg: number
  /** Drawn radius, already derived from placement. */
  r: number
  /** The anchor. Pinned, and otherwise treated like any other big node. */
  isHub: boolean
}

export interface LayoutLink {
  /** Degree of the more-connected endpoint. Set when the link list is built. */
  parentDeg: number
}

/**
 * A node is a HUB when its degree puts it far above the crowd.
 *
 * Threshold rather than rank: "top 7" would promote seven nodes on a map that
 * has no hubs at all, and a market with 82 children and one with 3 are not the
 * same kind of thing. 8 is the smallest fan that visibly needs its own room —
 * below that the generic settings already produce a readable clump.
 */
export const HUB_DEGREE = 8

export function isHubDegree(deg: number): boolean {
  return deg >= HUB_DEGREE
}

/**
 * The canvas's working radius, in graph units.
 *
 * Area, not length, scales with the node count: N nodes at mean radius r̄ need
 * about N·π(r̄+pad)² of surface to sit apart, so the radius that supplies it
 * grows as √N. A fixed span made 150 nodes look sparse and 680 look solid.
 * Clamped at both ends so a 5-node map is not lost in a huge empty field and a
 * 1000-node map does not need a telescope.
 */
export function span(nodeCount: number): number {
  const raw = 150 * Math.sqrt(Math.max(1, nodeCount) / 40)
  return Math.min(560, Math.max(170, raw))
}

/**
 * Charge. Negative is repulsion.
 *
 * Scales with drawn radius, so a big node claims proportionally more space than
 * a small one, and hubs get a large fixed push so their children have somewhere
 * to go. The anchor pushes hardest because everything is nominally attached to
 * it and it must not sit inside its own fan.
 */
export function chargeStrength(n: LayoutNode): number {
  if (n.isHub) return -900
  // A market with 82 children has to hold a whole lobe's worth of space, and
  // has to shove the neighbouring lobes off it.
  if (isHubDegree(n.deg)) return -(300 + 6 * n.deg)
  return -(55 + 9 * n.r)
}

/**
 * The radius past which two nodes stop pushing each other.
 *
 * THE fix for the uniform disc. Capping repulsion makes it a local force:
 * neighbours shove each other apart, distant clusters ignore one another, and
 * the lobes separate instead of being pressed into one even sheet. It is also
 * the single biggest tick-cost saving, since Barnes-Hut can prune whole cells.
 */
export function chargeDistanceMax(nodeCount: number): number {
  /* 1.15, not 0.55.
     Capping repulsion is what stopped the map being one uniform disc, but the
     first cap was tighter than the distance BETWEEN lobes — so two market
     lobes sitting a span apart could not feel each other at all, while the
     centre tether kept pulling both inward. The result was lobes stacked in a
     pile in the middle of an empty canvas, which is the opposite of the
     complaint the cap was introduced to fix.
     Above the working radius, repulsion still reaches lobe-to-lobe and pushes
     them apart; it is still bounded, so it never becomes the all-pairs
     pressure that flattens local structure. */
  return span(nodeCount) * 1.15
}

/**
 * Spring length, scaled to how many children the parent has.
 *
 * A parent with `d` children needs a circumference that seats them all: `d`
 * nodes of radius ~r̄+pad around a circle need radius ≥ d·(r̄+pad)/π. That is
 * what the sqrt term approximates, and it is the difference between a market
 * of 82 rendering as a legible rosette and rendering as a filled disc.
 *
 * The ANCHOR's own edges are the exception: they exist because the map asserts
 * a relation to the anchor, but they are not structure — every node has one, so
 * letting them act as springs pulls the entire graph into a single ring. They
 * are drawn and they are nearly inert.
 */
export function linkDistance(l: LayoutLink & { hubLink: boolean }, nodeCount: number): number {
  if (l.hubLink) return span(nodeCount) * 0.62
  // A parent with `d` children cannot seat them all on one ring unless the
  // ring is huge, so the springs deliberately fall short of that and let
  // `collide` pack the surplus into outer shells — a rosette rather than a
  // single hoop. What the length must guarantee is AREA: d nodes each claiming
  // ~π(r̄+pad)² need a disc of radius ≈ (r̄+pad)·√d, which is the √ term.
  const fan = Math.max(1, l.parentDeg)
  return 42 + 17 * Math.sqrt(fan)
}

export function linkStrength(l: { hubLink: boolean }): number {
  // 0.02: present, but it may only nudge. The typed entity-to-entity edges are
  // the ones carrying real structure, so they are the ones allowed to pull.
  return l.hubLink ? 0.02 : 0.5
}

/**
 * How hard a node is held toward the origin.
 *
 * With the anchor pinned and its springs inert, something has to stop the graph
 * drifting off-screen — but it must be weak enough that the springs and charge
 * still decide the shape. Disconnected nodes get more, because nothing else
 * holds them at all: with `relation: "none"` there is no edge, charge alone
 * would throw them to infinity, and `zoomToFit` measures every node, so a
 * handful of escapees shrink the real map to a dot.
 */
export function tetherStrength(n: LayoutNode): number {
  if (n.isHub) return 0
  if (n.deg === 0) return 0.13
  // Weak enough that repulsion decides the spread and this only stops drift.
  return 0.008
}

/**
 * Damping and cooling.
 *
 * `velocityDecay` 0.28 was floaty — nodes coasted past their targets and
 * wobbled back, which reads as jelly rather than as settling. 0.42 is d3's
 * ballpark for dense graphs and lands with weight.
 *
 * `alphaMin` above zero is what makes the simulation genuinely STOP. At the d3
 * default of 0 it creeps forever below the visible threshold, holding the
 * render loop open and never letting `onEngineStop` fire cleanly.
 */
export const ALPHA_DECAY = 0.019
export const ALPHA_MIN = 0.008
export const VELOCITY_DECAY = 0.42

/**
 * Per-axis multipliers on the centre tether, so the settled map fills the pane
 * it is actually in.
 *
 * A force graph with equal pull on both axes settles into a circle. Panes are
 * not circles — this one is routinely 1700x730, better than 2:1 — so a square
 * map fitted into it is limited by HEIGHT and leaves half the canvas empty
 * while the middle is too crowded to read. The space was there the whole time;
 * the layout just had no way to know about it.
 *
 * Pulling harder on the short axis than the long one settles the map into an
 * ellipse of roughly the pane's proportions. `sqrt` because the tether competes
 * against repulsion rather than setting position directly, so the effect on the
 * final shape is much gentler than the ratio suggests; the clamp keeps an
 * extreme window (a tall phone, an ultrawide) from stretching it into a line.
 */
export function tetherAspect(paneW: number, paneH: number): { x: number; y: number } {
  if (!(paneW > 0) || !(paneH > 0)) return { x: 1, y: 1 }
  const ratio = Math.min(2.6, Math.max(1 / 2.6, paneW / paneH))
  const k = Math.sqrt(ratio)
  // Wider pane -> weaker horizontal pull, firmer vertical one.
  return { x: 1 / k, y: k }
}

/** Blocking pre-settle ticks. Run before first paint so the reader never sees
 *  the initial collapse — only the last, gentle third of the settle. */
export function warmupTicks(nodeCount: number, reduceMotion: boolean): number {
  if (reduceMotion) return Math.min(700, 200 + nodeCount * 2)
  return Math.min(260, Math.round(90 + nodeCount * 0.25))
}

export function cooldownTicks(nodeCount: number, reduceMotion: boolean): number {
  if (reduceMotion) return 0
  return Math.min(320, Math.round(140 + nodeCount * 0.3))
}

/* ------------------------------------------------------------------ seeding */

/** Deterministic 0..1 from a string. Same map, same opening shape, every time —
 *  a layout that reshuffles on every reset makes a reader think the data
 *  changed. */
export function hashUnit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // >>> 0 keeps it unsigned; the divisor is 2^32.
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Where a node starts.
 *
 * d3 seeds nodes on a phyllotaxis spiral centred on the origin, so every node
 * starts in a pile and the first second of the animation is an explosion. A
 * ring seeded by degree — hubs inside, leaves outside — starts much nearer the
 * answer, so the settle reads as the map breathing into place.
 */
export function seedPosition(
  n: LayoutNode,
  nodeCount: number,
  maxDeg: number,
): { x: number; y: number } {
  if (n.isHub) return { x: 0, y: 0 }
  const s = span(nodeCount)
  // Well-connected nodes start inner, leaves outer.
  const t = maxDeg > 0 ? Math.sqrt(Math.min(1, n.deg / maxDeg)) : 0
  const radius = s * (1.05 - 0.6 * t)
  const angle = hashUnit(n.id) * Math.PI * 2
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}
