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
  /**
   * Multiplies the empty space `forceCollide` keeps between two node edges.
   *
   * The air dial. Repulsion decides where the lobes go; this decides how
   * tightly the nodes inside one are allowed to pack, and it is the difference
   * between a lobe that reads as a rosette of distinct sites and one that reads
   * as a single filled disc. Above 1 by default — the map was legible at 1 and
   * noticeably easier to read (and to point at) with a little more room.
   */
  nodeSpacing: number
  /**
   * Bow in the edges. 0 draws straight lines.
   *
   * With one anchor carrying most of the wiring, straight edges stack into a
   * solid ink starburst at the centre. A slight curve fans them apart. Off by
   * default because straight is the honest reading of "A relates to B"; the
   * curve is there for a reader who wants the hub legible.
   */
  linkCurve: number
  /**
   * How tightly a lobe holds itself together.
   *
   * A node's lobe is the fan it hangs off — see lib/graph/cluster.ts. Raise it
   * and each market draws into a tight rosette; drop it to 0 and the springs
   * alone decide, which is the layout as it was before lobes existed.
   */
  clusterPull: number
  /**
   * Clear space demanded between two lobes.
   *
   * The one force in the recipe that knows a lobe exists as a THING rather than
   * as a set of nodes. `forceCollide` stops two nodes overlapping and is
   * perfectly happy to let two whole markets interleave into one ambiguous
   * mass; this measures each lobe as a disc and pushes overlapping discs apart.
   * 0 turns it off and the lobes may sit on each other again.
   */
  clusterSpacing: number

  /* ---- style: what the canvas actually draws -------------------------------
     Obsidian's graph reads calm because it runs ONE visual encoding — a grey
     dot sized by its links. Ours has more to say (four entity types, eleven
     relations, a placement rank) and had been saying all of it at once: type
     fill AND favicon AND a type-coloured rim AND size, over glowing cyan edges.
     Four signals competing is why it read busy at 915 nodes.

     So each encoding becomes a switch, and the shipped default keeps only the
     two that carry something Obsidian's graph has no equivalent for — the type
     colour and the size. The rest is there when a reader goes looking. */

  /** Fill nodes by entity type. Off = one neutral ink, Obsidian-style. */
  colorByType: boolean
  /** Draw each site's favicon once the node is big enough on screen. */
  showIcons: boolean
  /** A type-coloured rim around the favicon chip. */
  typeRings: boolean
  /** Cyan bloom on hovered nodes and their edges. */
  glow: boolean
  /** Label size grows with zoom (Obsidian) instead of staying constant. */
  labelsScaleWithZoom: boolean
  /** Edge opacity at rest. */
  linkOpacity: number

  /* ---- what hovering is allowed to do -------------------------------------
     Hover was doing the work of a click. Passing over a node dimmed every
     non-neighbour, re-coloured every edge and re-planned the whole label set —
     and on the way to anywhere the pointer crosses dozens of nodes, so the map
     strobed between lit and dimmed while the reader was merely moving the
     mouse. Nothing was being decided; it just looked like it was.

     So the two jobs are separated. CLICK is the deliberate, sticky gesture and
     it keeps focus mode. HOVER identifies one node — a ring on it, its own
     edges lit, its card raised — and leaves the rest of the map exactly where
     the reader's eye left it. */

  /** Hover dims everything that is not a neighbour (the old behaviour). */
  hoverDims: boolean
  /** Hovering raises the detail card, so the pointer is a reading instrument
   *  and nothing has to be clicked to find out what a dot is. */
  hoverCard: boolean
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
  // Above 1. See `nodeSpacing` — the extra air is the cheapest legibility this
  // map has, and it makes every node a larger target to point at.
  // 1 now means "as designed" again: spacing became proportional to the drawn
  // node (see seatRadius), so the old 1.25 nudge is baked into the shape.
  nodeSpacing: 1,
  linkCurve: 0,
  clusterPull: 1,
  clusterSpacing: 1,
  // The quiet default: colour and size carry the meaning, nothing else
  // competes. Every switch below turns detail back on.
  colorByType: true,
  showIcons: true,
  typeRings: false,
  glow: false,
  labelsScaleWithZoom: false,
  // Lighter than it was. With dense bundles now fading further by fan size
  // (see bundleFade), 0.1 was drawing the wiring as the subject of the map.
  linkOpacity: 0.07,
  hoverDims: false,
  hoverCard: true,
}

/** Slider bounds, so the panel and the clamp cannot drift apart. */
export const RANGES: Record<
  keyof Omit<
    GraphSettings,
    | "arrows"
    | "colorByType"
    | "showIcons"
    | "typeRings"
    | "glow"
    | "labelsScaleWithZoom"
    | "hoverDims"
    | "hoverCard"
  >,
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
  nodeSpacing: { min: 0.4, max: 3.5, step: 0.05 },
  linkCurve: { min: 0, max: 0.6, step: 0.02 },
  clusterPull: { min: 0, max: 3, step: 0.05 },
  clusterSpacing: { min: 0, max: 3, step: 0.05 },
  linkOpacity: { min: 0.02, max: 0.6, step: 0.01 },
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
      nodeSpacing: clampNum(o.nodeSpacing, RANGES.nodeSpacing, DEFAULT_SETTINGS.nodeSpacing),
      linkCurve: clampNum(o.linkCurve, RANGES.linkCurve, DEFAULT_SETTINGS.linkCurve),
      clusterPull: clampNum(o.clusterPull, RANGES.clusterPull, DEFAULT_SETTINGS.clusterPull),
      clusterSpacing: clampNum(
        o.clusterSpacing,
        RANGES.clusterSpacing,
        DEFAULT_SETTINGS.clusterSpacing,
      ),
      // `?? default` rather than `=== true`: these are opt-OUT switches, so a
      // settings blob written before they existed must keep the shipped look
      // instead of silently turning every one of them off.
      colorByType: typeof o.colorByType === "boolean" ? o.colorByType : DEFAULT_SETTINGS.colorByType,
      showIcons: typeof o.showIcons === "boolean" ? o.showIcons : DEFAULT_SETTINGS.showIcons,
      typeRings: typeof o.typeRings === "boolean" ? o.typeRings : DEFAULT_SETTINGS.typeRings,
      glow: typeof o.glow === "boolean" ? o.glow : DEFAULT_SETTINGS.glow,
      labelsScaleWithZoom:
        typeof o.labelsScaleWithZoom === "boolean"
          ? o.labelsScaleWithZoom
          : DEFAULT_SETTINGS.labelsScaleWithZoom,
      linkOpacity: clampNum(o.linkOpacity, RANGES.linkOpacity, DEFAULT_SETTINGS.linkOpacity),
      // `=== true`, not `?? default`: hover-dimming is opt-IN, so a blob
      // written before it became a setting must land on the calm behaviour.
      hoverDims: o.hoverDims === true,
      hoverCard:
        typeof o.hoverCard === "boolean" ? o.hoverCard : DEFAULT_SETTINGS.hoverCard,
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
