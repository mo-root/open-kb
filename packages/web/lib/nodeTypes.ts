/**
 * The four node types the design system colours by, and their brand hexes.
 *
 * PORT NOTE. Upstream this lived in the v1 app's `lib/nodeTypes.ts` and the
 * components imported `{ TYPE_COLOR, type NodeType }` from it; `components/ui.tsx`
 * carried a local copy with a TODO to reconcile. There is one copy now, here,
 * and it is the one both `ui.tsx` and `icons/NodeGlyph.tsx` import.
 *
 * The hexes must stay identical to `app/globals.css`'s `--type-*` tokens —
 * those tokens, not this map, are what the CSS paints with. This exists for the
 * places that need the value in JS (an inline `color-mix`, an SVG fill).
 */
export type NodeType = "product" | "player" | "community" | "core"

export const TYPE_COLOR: Record<NodeType, string> = {
  product: "#3D7FFC", // primary blue / --accent
  player: "#EB368C", // brand pink — rivals stand out
  community: "#C4C1F8", // lavender
  core: "#9DB2D6", // muted
}
