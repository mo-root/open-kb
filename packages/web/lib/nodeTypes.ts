/* Shared node-type presentation: the semantic type of a node (derived from its
   group) mapped to a stable colour / label / icon, so the graph canvas, the
   notes sidebar, relationship chips and the KB cards all speak one palette.

   PORT NOTE. Upstream this lived in the v1 app's `lib/nodeTypes.ts` and the
   components imported `{ TYPE_COLOR, type NodeType }` from it; `components/ui.tsx`
   carried a local copy with a TODO to reconcile. There is one copy now, here,
   and it is the one `ui.tsx`, `icons/NodeGlyph.tsx`, `GraphCanvas`, `GraphLegend`,
   `KbOverview`, `NotesTab` and `ProductsTab` all import.

   The hexes must stay identical to `app/globals.css`'s `--type-*` tokens —
   those tokens, not this map, are what the CSS paints with. This exists for the
   places that need the value in JS (an inline `color-mix`, an SVG fill, a
   canvas fillStyle).

   ONE FURTHER PORT NOTE. v1 re-exported `nodeTypeOf` from `lib/kb/types.ts`,
   where its build engine already decided a note's type — "two copies of that
   rule would let the writer and the reader disagree about what a note IS". That
   engine is not part of this rewrite, so the rule is DEFINED here instead, and
   this file is now the single writer as well as the single reader of it. The
   rule itself is unchanged: the top-level group names the type. */

export type NodeType = "core" | "product" | "player" | "community"

/** Group (top-level folder of a node id) -> its semantic type. `overview` and
 *  anything unrecognised is core, which is what keeps the hub central. */
export function nodeTypeOf(path: string): NodeType {
  const top = path.split("/")[0]
  if (top === "products") return "product"
  if (top === "players") return "player"
  if (top === "communities") return "community"
  return "core"
}

export const TYPE_COLOR: Record<NodeType, string> = {
  product: "#3D7FFC", // primary blue / --accent
  player: "#EB368C", // brand pink — rivals stand out
  // Kept in sync with --type-community's DARK step (globals.css). This map is
  // the fallback for canvas paint, which cannot read a CSS variable; surfaces
  // that can read one should, so they follow the theme.
  community: "#D95926", // orange
  core: "#9DB2D6", // muted
}

/** Canonical CSS colour per type: the --type-* var when defined, else the hex
 *  above. Use this in styles and canvas fallbacks, never inline the var+hex
 *  pair locally, so the palette can only drift in one place. */
export const TYPE_CSS: Record<NodeType, string> = {
  product: `var(--type-product, ${TYPE_COLOR.product})`,
  player: `var(--type-player, ${TYPE_COLOR.player})`,
  community: `var(--type-community, ${TYPE_COLOR.community})`,
  core: `var(--type-core, ${TYPE_COLOR.core})`,
}

export const TYPE_LABEL: Record<NodeType, string> = {
  product: "products",
  player: "players",
  community: "communities",
  core: "core",
}

/** Distinct geometric glyphs, coloured by type, for sidebar and legend markers. */
export const TYPE_ICON: Record<NodeType, string> = {
  core: "○",
  product: "◆",
  player: "▲",
  community: "●",
}

/** Stable display order: core first, then the market layers. */
export const TYPE_ORDER: NodeType[] = ["core", "product", "player", "community"]

/**
 * The node types that are A COMPANY ON THE MAP, and the reason this is one
 * name rather than an addition spelled out per surface.
 *
 * `company` and `product` were merged at the classifier (CLASSIFY_KINDS in
 * packages/sweep/src/sweep.ts) because the choice between them was a coin
 * flip. The merge fixes new runs and does nothing for the stored ones, and
 * the stored ones are the gallery: measured over the six committed maps,
 * `company` alone reads 1 for stripe.com, 1 for cursor.com, 2 for clerk.com,
 * 4 for supabase.com, 19 for vercel.com and 404 for brightdata.com — the same
 * classifier, the same question, one order of magnitude apart depending on
 * which afternoon the run happened. The union is stable across the same six:
 * 1,273 · 416 · 293 · 727 · 1,122 · 456, and every one of those is a number a
 * reader can hold against the domain it belongs to.
 *
 * `core` and `community` are deliberately out. `core` is the anchor plus every
 * `unknown` — a host the kernel could not read at all (`kind: "unknown"` folds
 * into the `unplaced` group, which falls through `nodeTypeOf` to core), 476 of
 * stripe.com's 2,522 and 383 of vercel.com's 2,333, all of them nameless and
 * descriptionless. `community` is publishers, directories and community
 * venues: channels this market is discussed in, not players in it.
 */
export const COMPANY_TYPES: readonly NodeType[] = ["product", "player"]

/** Map a raw graph group (top-level folder) to the label shown to a reader. */
export function groupLabel(group: string): string {
  return group === "overview" ? "core" : group
}
