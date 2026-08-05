/**
 * Which labels to draw, and where.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * Labels were decided per node, inside the node painter, by a fixed rule: the
 * six highest-placement nodes plus the anchor, plus whatever was hovered or
 * focused. Two consequences, both visible on a real map:
 *
 * · Zooming told you nothing new. Six labels at the overview, six labels at 4x.
 *   The single gesture a reader makes to learn more about a region — zoom into
 *   it — returned nothing, so the other 289 nodes stayed anonymous dots at
 *   every scale.
 *
 * · Nothing checked whether two labels landed on top of each other. On a
 *   settled 295-node map "brightdata.com" overprinted a market name and
 *   "webfusiondata.com" overprinted "parser…", so the few labels that WERE
 *   drawn were partly unreadable.
 *
 * A per-node rule cannot fix either, because both are properties of the FRAME:
 * how far in the reader is zoomed, and what else is already on screen. So the
 * decision moves out of the node painter into one pass over the whole frame.
 *
 * The rule: a node earns a label when it is drawn big enough to own one — which
 * makes zoom the reveal, exactly as it should be — and it keeps it only if the
 * space is still free. Ties go to the more important node, so as a region gets
 * crowded the market survives and its leaves drop out, rather than whichever
 * node happened to be painted last.
 *
 * Pure and canvas-free: it takes measured widths and returns rectangles, so the
 * packing can be tested without a renderer.
 */

export interface LabelCandidate {
  id: string
  text: string
  /** Graph-space centre of the node. */
  x: number
  y: number
  /** Graph-space node radius. */
  r: number
  /**
   * Lower wins. Built from what makes a node worth naming — the anchor, then
   * how many things hang off it, then its placement.
   */
  priority: number
  /** Hovered, focused, or a search hit. Always drawn, never decluttered away. */
  forced: boolean
}

export interface PlacedLabel {
  id: string
  text: string
  /** Graph-space baseline origin for the text, already centred horizontally. */
  x: number
  y: number
  forced: boolean
}

export interface PlanOptions {
  /** Canvas scale — force-graph's globalScale. */
  scale: number
  /**
   * Screen radius a node must reach before it may claim a label. THE zoom
   * reveal: `r * scale` grows as the reader zooms, so more nodes qualify the
   * further in they go, with no separate zoom threshold to keep in sync.
   */
  minScreenR: number
  /** Hard cap, so a deep zoom on a dense lobe cannot cost an unbounded pass. */
  maxLabels: number
  /** Screen-space width of a string at the label font. */
  measure: (text: string) => number
  /** Screen-space line height at the label font. */
  lineHeight: number
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
}

/**
 * Choose the labels for one frame.
 *
 * Greedy by priority, which is the right shape here: the important labels are
 * placed first and keep their space, so a crowded region degrades by shedding
 * its least important names instead of by scrambling.
 */
export function planLabels(
  candidates: readonly LabelCandidate[],
  opts: PlanOptions,
): PlacedLabel[] {
  const { scale, minScreenR, maxLabels, measure, lineHeight } = opts

  const eligible = candidates.filter((c) => c.forced || c.r * scale >= minScreenR)
  // Sort a copy: the caller's array is the render list and reordering it would
  // change paint order, and therefore z-order, on every frame.
  const ordered = [...eligible].sort((a, b) => {
    // Forced labels are placed before everything, so a search hit can never be
    // decluttered away by an ordinary neighbour that happened to rank higher.
    if (a.forced !== b.forced) return a.forced ? -1 : 1
    return a.priority - b.priority || a.id.localeCompare(b.id)
  })

  const placed: PlacedLabel[] = []
  const taken: Rect[] = []

  for (const c of ordered) {
    if (placed.length >= maxLabels) break

    const w = measure(c.text)
    // Screen-space box, sitting just under the node. Translation is uniform
    // across the frame, so it cancels out of every comparison and only the
    // scaled positions matter.
    const sx = c.x * scale
    const sy = c.y * scale + c.r * scale + lineHeight
    const box: Rect = {
      left: sx - w / 2 - 2,
      right: sx + w / 2 + 2,
      top: sy - lineHeight,
      bottom: sy + 2,
    }

    // A forced label is drawn wherever it lands — the reader asked for that
    // one specifically — but it still reserves its space so the ordinary
    // labels around it move out of the way.
    if (!c.forced && taken.some((t) => overlaps(box, t))) continue

    taken.push(box)
    placed.push({
      id: c.id,
      text: c.text,
      // Back to graph space, which is what the painter draws in.
      x: c.x,
      y: c.y + c.r + lineHeight / scale,
      forced: c.forced,
    })
  }

  return placed
}

/**
 * How much a node deserves a name.
 *
 * The anchor first, then the hubs — a market with 82 things hanging off it is
 * the most useful word on that part of the map — then placement. Returns a
 * sort key where lower is better.
 */
export function labelPriority(n: {
  isHub: boolean
  deg: number
  rel: number
}): number {
  if (n.isHub) return -1_000_000
  return -(n.deg * 1000 + n.rel)
}
