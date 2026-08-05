/**
 * The graph's live controls.
 *
 * Everything the layout and the paint read that a reader is allowed to change.
 * A force graph has no single correct tuning — a 60-node map and a 680-node map
 * want different repulsion, and how much text someone wants on screen is taste,
 * not a fact — so the numbers stop being constants and become a panel.
 *
 * Multipliers, not absolutes. The recipe in `layout.ts` stays the thing that
 * knows how a hub differs from a leaf; these scale its output. That way a
 * reader turning "repel" up gets more of the same well-shaped layout instead of
 * a different one, and every slider is meaningful at 1.0 = "as designed".
 */

export interface GraphSettings {
  /** Multiplies every node's drawn radius (and its collision radius with it). */
  nodeScale: number
  /** Multiplies edge width. */
  linkWidth: number
  /** On-screen label size in px. Doubles as the reader's text-density dial. */
  labelPx: number
  /**
   * Screen radius a node must reach before it may claim a label — Obsidian's
   * "text fade threshold". Higher means labels appear only when zoomed further
   * in, which is how someone quiets a dense map without losing the shape.
   */
  labelThreshold: number
  /** Draw direction arrows on edges. Off by default: 400 arrowheads on a
   *  300-node map is texture, not information. */
  arrows: boolean
  /** Multiplies the pull toward the centre. */
  centerForce: number
  /** Multiplies node-to-node repulsion. */
  repelForce: number
  /** Multiplies spring strength. */
  linkForce: number
  /** Multiplies spring length. */
  linkDistance: number
}

export const DEFAULT_SETTINGS: GraphSettings = {
  nodeScale: 1,
  linkWidth: 1,
  labelPx: 11,
  labelThreshold: 9,
  arrows: false,
  centerForce: 1,
  repelForce: 1,
  linkForce: 1,
  linkDistance: 1,
}

/** Slider bounds, so the panel and the clamp cannot drift apart. */
export const RANGES: Record<
  keyof Omit<GraphSettings, "arrows">,
  { min: number; max: number; step: number }
> = {
  nodeScale: { min: 0.4, max: 2.5, step: 0.05 },
  linkWidth: { min: 0.2, max: 4, step: 0.1 },
  labelPx: { min: 8, max: 20, step: 0.5 },
  labelThreshold: { min: 0, max: 40, step: 1 },
  centerForce: { min: 0, max: 3, step: 0.05 },
  repelForce: { min: 0.2, max: 4, step: 0.05 },
  linkForce: { min: 0, max: 3, step: 0.05 },
  linkDistance: { min: 0.3, max: 3, step: 0.05 },
}

const KEY = "kb-graph-settings"

function clampNum(v: unknown, r: { min: number; max: number }, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(r.max, Math.max(r.min, v))
    : fallback
}

/**
 * Read the saved settings.
 *
 * Every field is validated against its own range rather than trusted: this is
 * localStorage, which survives deploys, so a value written by an older build
 * (or edited by hand) can be any shape at all. A bad field falls back to its
 * default instead of poisoning the layout with NaN, which in a force
 * simulation propagates to every node's position within one tick.
 */
export function loadSettings(): GraphSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== "object") return DEFAULT_SETTINGS
    return {
      nodeScale: clampNum(o.nodeScale, RANGES.nodeScale, DEFAULT_SETTINGS.nodeScale),
      linkWidth: clampNum(o.linkWidth, RANGES.linkWidth, DEFAULT_SETTINGS.linkWidth),
      labelPx: clampNum(o.labelPx, RANGES.labelPx, DEFAULT_SETTINGS.labelPx),
      labelThreshold: clampNum(
        o.labelThreshold,
        RANGES.labelThreshold,
        DEFAULT_SETTINGS.labelThreshold,
      ),
      arrows: o.arrows === true,
      centerForce: clampNum(o.centerForce, RANGES.centerForce, DEFAULT_SETTINGS.centerForce),
      repelForce: clampNum(o.repelForce, RANGES.repelForce, DEFAULT_SETTINGS.repelForce),
      linkForce: clampNum(o.linkForce, RANGES.linkForce, DEFAULT_SETTINGS.linkForce),
      linkDistance: clampNum(
        o.linkDistance,
        RANGES.linkDistance,
        DEFAULT_SETTINGS.linkDistance,
      ),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: GraphSettings): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // A full or blocked store must not break the graph — the settings are a
    // convenience, the map is the product.
  }
}
