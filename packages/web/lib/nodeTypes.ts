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
  community: "#C4C1F8", // lavender
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

/** Map a raw graph group (top-level folder) to the label shown to a reader. */
export function groupLabel(group: string): string {
  return group === "overview" ? "core" : group
}
