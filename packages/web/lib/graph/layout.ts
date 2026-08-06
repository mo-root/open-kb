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
  /* Scaled down ~30%, and the anchor's special case is gone.
     Repulsion was carrying two jobs: keeping nodes off each other, and giving
     each market's fan room. The second job now belongs to the lobe force
     (lib/graph/cluster.ts), which reserves that room explicitly and knows where
     one lobe ends and the next begins. Charge kept doing it too, and the
     duplicated effort flung the lobes so far apart that the settled map filled
     23% of its own bounding box — fitted into the pane, a node came out 4.3px
     across and no favicon or glyph could clear its legibility threshold.
     Measured: at 0.7 the map fits at 0.42 instead of 0.31, so every node is
     ~38% bigger on screen, with the same zero overlapping pairs.

     The flat `isHub ? -900` is dropped because it was backwards. The anchor is
     by definition the highest-degree node, so the degree formula below already
     pushes it hardest — the special case was overriding that with a WEAKER
     constant than a large market would have got. It also dates from when the
     anchor was pinned at the origin; it is not, any more. */
  // A market with 82 children has to hold a whole lobe's worth of space.
  if (isHubDegree(n.deg)) return -(210 + 4.2 * n.deg)
  return -(38 + 6.3 * n.r)
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
/**
 * The radius one node claims, drawn size plus its share of breathing room.
 *
 * THE unit the rest of the recipe is measured in. Spacing used to be a flat
 * `+ 7 * nodeSpacing` added to the drawn radius, which is fine at one setting
 * and absurd at the others: turned up to 3.4 on nodes drawn at radius 4, it
 * demanded 23.8 units of padding around a 4-unit dot — six times the node — and
 * blew the map out to three thousand units wide for 849 entities. The dial was
 * a spread-the-map-apart dial rather than a give-each-node-room dial.
 *
 * Proportional instead, with a small floor so the smallest dots still separate:
 * a node claims half again its own radius per unit of spacing. The gap between
 * two nodes then always reads as a fraction of the things it is separating,
 * which is what "room to breathe" means visually, at any node size.
 */
export const SEAT_FLOOR = 2

export function seatRadius(drawnRadius: number, spacing: number): number {
  return drawnRadius * (1 + 0.5 * Math.max(0, spacing)) + SEAT_FLOOR
}

/**
 * Spring length, in units of the seat radius.
 *
 * A parent with `d` children cannot seat them all on one ring unless the ring
 * is huge, so the springs deliberately fall short of that and let `collide`
 * pack the surplus into shells — a rosette rather than a single hoop. What the
 * length must guarantee is AREA: d nodes each claiming ~π·seat² need a disc of
 * radius ≈ seat·√d, which is the √ term.
 *
 * Expressed in seats rather than in absolute units so that the packing and the
 * springs cannot disagree. They used to: this was a hardcoded `42 + 17·√fan`
 * while collide's radius moved with two sliders, so turning spacing up made
 * every node demand more room WITHOUT making the ring it sits on any longer.
 * Collide and the springs then fought over the same circumference, and collide
 * lost — which is how nodes ended up touching on a map that was, on paper,
 * generously padded. At the shipped defaults `seat` is ~17 and this reproduces
 * the old numbers exactly; it is only the other settings that change.
 */
export function linkDistance(
  l: LayoutLink & { hubLink: boolean },
  nodeCount: number,
  seat = 17,
): number {
  if (l.hubLink) return span(nodeCount) * 0.62
  /* THE SPRING HAS TO FALL SHORT, AND IT DID NOT.
     The paragraph above says the springs "deliberately fall short" so collide
     can pack the surplus into shells. `seat·(2.5 + √fan)` does the opposite: it
     is LONGER than the packing radius `seat·√fan`, so every one of a market's
     children was pulled onto a single hoop at the same distance from its hub.
     With more children than the circumference can seat, they spread sideways
     until the ring ran into its neighbours and stopped — which is why each
     market drew as a thin crescent with its hub stranded at the tip, rather
     than as a rosette with the hub in the middle.
     At half the packing radius the spring pulls INWARD and collide pushes back
     out, and the fan fills the disc between them. Measured on the 849-node map
     by the spread of each lobe's members about their own hub (0 = a hoop, ~0.35
     = an evenly filled disc): three of five markets went from 0.20/0.21/0.24 to
     0.34/0.31/0.28. The map also got smaller doing it — the fitted scale rose
     from 0.42 to 0.51, so every node is another 21% bigger on screen. */
  const fan = Math.max(1, l.parentDeg)
  return seat * (1.2 + 0.5 * Math.sqrt(fan))
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
/*
 * THE ANCHOR IS NO LONGER PINNED, so it needs a tether like everything else.
 *
 * It used to be nailed to the origin with fx/fy — reasonably, since everything
 * is nominally attached to it and a drifting anchor drags the whole map after
 * it. What made that untenable is the lobe force (lib/graph/cluster.ts): the
 * anchor's fan is a lobe, lobes get shoved apart to stop them overlapping, and
 * a shove applied to a lobe containing an immovable member moves every OTHER
 * member. Measured on a real 849-node map, the anchor's 342 children walked
 * 1,398 units away and left the anchor sitting outside its own fan.
 *
 * Treating the pinned lobe as immovable instead was worse: it becomes a wall
 * the other five lobes must all flee, and they pile up against one another —
 * 3 overlapping pairs, versus 0 with no pin at all.
 *
 * Nothing is needed to replace it. The anchor's lobe is the heaviest on the
 * map by a wide margin, and separation is mass-weighted, so it already barely
 * moves; this tether is what stops it drifting. Measured, unpinning improves
 * every number: overlapping lobe pairs 3 -> 0, the anchor's distance from the
 * middle of its own lobe 279 -> 140, and the settled aspect 1.53 -> 1.62
 * against a 2.29 pane.
 */
export function tetherStrength(n: LayoutNode): number {
  if (n.deg === 0) return 0.13
  /* 0.064, up from 0.008.
     "Weak enough that repulsion decides the spread" was right when repulsion
     was the only thing arranging the map. The lobe force now decides how the
     markets sit relative to each other, and against that a near-zero tether
     simply let the whole arrangement drift outward until the springs ran out —
     a 2,972 x 2,038 layout for a pane of 1,686 x 737.
     Firmer, it gathers the lobes without touching how they pack internally:
     collide and the springs still set every gap between nodes, unchanged.
     Measured, this and the lighter charge together take the fitted scale from
     0.31 to 0.42 with no new overlaps anywhere.
     Disconnected nodes keep their much stronger pull above — nothing else holds
     them at all. */
  return 0.064
}

/**
 * Damping and cooling.
 *
 * `velocityDecay` 0.28 was floaty — nodes coasted past their targets and
 * wobbled back, which reads as jelly rather than as settling. 0.42 is d3's
 * ballpark for dense graphs and lands with weight.
 *
 * ---------------------------------------------------------------------------
 * ALPHA_MIN IS ZERO, AND THAT IS WHAT MAKES DRAGGING WORK.
 *
 * It used to be 0.008, on the reasoning that a positive floor is what makes the
 * simulation genuinely STOP rather than creep forever below the visible
 * threshold. The reasoning was sound and the consequence was not: it silently
 * disabled every ripple a drag was supposed to produce.
 *
 * force-graph runs the textbook d3 drag recipe — hold `alphaTarget(0.3)` for
 * the duration of the drag, release it on drop — but `alphaTarget` only takes
 * effect INSIDE `simulation.tick()`, and its engine loop checks the floor
 * BEFORE ticking (canvas-force-graph.js:135-141):
 *
 *     if (++cntTicks > cooldownTicks || elapsed > cooldownTime
 *         || (d3AlphaMin > 0 && alpha < d3AlphaMin)) { stop }
 *     else { forceLayout.tick() }
 *
 * A settled map sits just below the floor, by definition — that is why it
 * stopped. So on the next drag frame the third clause is still true, the engine
 * stops again before ticking, and the tick that would have raised alpha toward
 * 0.3 never happens. Grab a node and it moves alone: the springs and collisions
 * around it are never evaluated. A positive floor cannot be climbed out of.
 *
 * Nothing is lost by removing it, because the floor was never the only stop
 * condition — `cooldownTicks` is finite and reaches zero energy first (alpha
 * decays to ~0.002 within 320 ticks), so `onEngineStop` still fires cleanly and
 * on time. What changes is that a drag can now call `resetCountdown()` and
 * genuinely restart the engine, which is exactly what the library is trying to
 * do.
 */
export const ALPHA_DECAY = 0.019
export const ALPHA_MIN = 0
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

/**
 * WARMUP IS ZERO, BECAUSE force-graph's WARMUP RUNS THE WRONG FORCES.
 *
 * `warmupTicks` is spent inside the library's own graphData update
 * (canvas-force-graph.js:550), which happens when the component MOUNTS — and
 * the recipe in this file is installed by a React effect, which necessarily
 * runs afterwards. So every warmup tick was integrating force-graph's defaults:
 * charge -30 and a 30-unit link distance, on a map tuned for charge -900 and
 * springs an order of magnitude longer. It crushed 849 nodes into a pile, and
 * the real forces then had to dig the layout back out of it within the cooldown
 * budget. Nodes ended up touching with no daylight between them — measured, a
 * median gap of -0.4 units where the recipe asks for 47.6.
 *
 * A warmup that runs the wrong physics is worse than no warmup: the seeded ring
 * (see `seedPosition`) is already a better starting shape than anything 80
 * ticks of the wrong forces can produce. So there is none, first paint is
 * immediate, and the entire settle happens under the real recipe where it can
 * be watched.
 */
export const WARMUP_TICKS = 0

/**
 * The animated settle budget — now the ONLY place the layout is computed.
 *
 * Reduced motion used to return 0 here while taking a huge warmup instead, on
 * the reasoning that someone who asked for no animation wants the finished map
 * rather than a settle they can watch. With the warmup running the wrong
 * forces, that combination meant a reduced-motion reader got a layout built
 * ENTIRELY by force-graph's defaults — the recipe was installed and then the
 * engine stopped on its very next tick, having never applied it.
 *
 * The budget is therefore the same for everyone, and the promise of "no motion"
 * is kept where it belongs: the canvas stays hidden until the layout settles,
 * so the reader is shown a finished map and never a moving one.
 */
export function cooldownTicks(nodeCount: number, _reduceMotion?: boolean): number {
  /* Capped at 440, not 320.
     The lobe separation is a hard constraint being satisfied a fraction of the
     overlap at a time, and on a large map it needs longer to converge than the
     node-level forces do. Measured on the 849-node map: at 320 and 360 ticks
     two lobe pairs were still overlapping when the engine stopped; at 400 it is
     zero. 440 leaves headroom without letting a settle outstay its welcome —
     alpha is ~0.0002 by then, so the last stretch is visually motionless
     anyway. */
  return Math.min(440, Math.round(140 + nodeCount * 0.4))
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
