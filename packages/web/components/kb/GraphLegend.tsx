"use client";

import { NodeGlyph, TYPE_GLYPH } from "@/components/icons";
import { TYPE_CSS, TYPE_LABEL, type NodeType } from "@/lib/nodeTypes";

/**
 * Corner overlay for the graph: one row per node type present in the map —
 * colour swatch + glyph + label + count. Rows are toggles: click to hide or
 * show that type on the canvas. Colours come from the shared TYPE_CSS map in
 * lib/nodeTypes — the single palette source — so the legend can never drift
 * from the canvas or the rest of the app.
 *
 * PORT NOTE — THE FOOTNOTE EARNS ITS LINE.
 *
 * v1's read "counts = drawn nodes · size = relevance · ring = company hub ·
 * players wear their favicon". Two of those four are no longer true here: the
 * size encodes PLACEMENT (a rank derived from the classifier's relation, not a
 * measured relevance — see lib/kb-from-run.ts) and the ring marks the ANCHOR.
 *
 * A third line is added, because the legend is exactly where the palette's one
 * lie has to be confessed: `communities` is drawn for three different
 * classifier kinds — community, publisher and directory — since the `--type-*`
 * tokens are fixed at four hues and none of the other three would be honest for
 * a newsletter or a vendor directory. Every node's card names its real kind.
 */
export function GraphLegend({
  types,
  counts,
  visible,
  onToggle,
}: {
  types: NodeType[];
  counts: Record<NodeType, number>;
  visible: Record<NodeType, boolean>;
  onToggle: (t: NodeType) => void;
}) {
  if (types.length === 0) return null;
  return (
    <div className="absolute bottom-3 left-3 z-10 w-44 rounded-md border border-slate-800 bg-slate-950/85 px-2 pb-2 pt-2 shadow-lg">
      <p className="mb-1.5 px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-500">
        signal key
      </p>
      <ul>
        {types.map((t) => {
          const on = visible[t];
          return (
            <li key={t}>
              <button
                onClick={() => onToggle(t)}
                aria-pressed={on}
                title={`${on ? "hide" : "show"} ${TYPE_LABEL[t]}`}
                className="flex w-full items-center gap-2 rounded px-1 py-[3px] text-left text-[11px] transition-colors hover:bg-slate-800/40"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ background: on ? TYPE_CSS[t] : "var(--border)" }}
                />
                <span
                  aria-hidden
                  className="flex w-3 shrink-0 items-center justify-center leading-none"
                  style={{ color: on ? TYPE_CSS[t] : "var(--muted)" }}
                >
                  <NodeGlyph kind={TYPE_GLYPH[t]} size={12} />
                </span>
                <span className={on ? "text-slate-300" : "text-slate-600 line-through"}>
                  {TYPE_LABEL[t]}
                </span>
                <span className="tnum ml-auto text-[10px] text-slate-500">
                  {counts[t]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 border-t border-slate-800/70 px-1 pt-1.5 text-[10px] leading-4 text-slate-500">
        counts = drawn nodes · size = placement · ring = the anchor · players wear
        their favicon
      </p>
      <p
        title="The --type-* palette is fixed at four hues in both themes, and neither the product blue nor the rival pink would be honest for a newsletter or a vendor directory. Each node's detail card names its real kind."
        className="mt-1 px-1 text-[10px] leading-4 text-slate-600"
      >
        communities = community · publisher · directory
      </p>
    </div>
  );
}
