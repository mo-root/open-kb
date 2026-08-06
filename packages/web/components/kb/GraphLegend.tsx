"use client";

import { NodeGlyph, TYPE_GLYPH } from "@/components/icons";
import { TYPE_CSS, TYPE_LABEL, type NodeType } from "@/lib/nodeTypes";

/**
 * Corner overlay for the graph: one row per node type present in the map —
 * colour swatch + glyph + label + count. Rows are toggles: click to hide or
 * show that type on the canvas. Colours come from the shared TYPE_CSS map in
 * lib/nodeTypes, the single palette source, so the legend can never drift
 * from the canvas or the rest of the app.
 *
 * port NOTE, THE footnote earns ITS line.
 *
 * v1's read "counts = drawn nodes · size = relevance · ring = company hub ·
 * players wear their favicon". Two of those four are no longer true here: the
 * size encodes placement (a rank derived from the classifier's relation, not a
 * measured relevance, see lib/kb-from-run.ts) and the ring marks the anchor.
 *
 * A third line is added, because the legend is exactly where the palette's one
 * lie has to be confessed: `communities` is drawn for three different
 * classifier kinds, community, publisher and directory, since the `--type-*`
 * tokens are fixed at four hues and none of the other three would be honest for
 * a newsletter or a vendor directory. Every node's card names its real kind.
 */
export function GraphLegend({
  types,
  counts,
  visible,
  onToggle,
  onHighlight,
}: {
  types: NodeType[];
  counts: Record<NodeType, number>;
  visible: Record<NodeType, boolean>;
  onToggle: (t: NodeType) => void;
  /** Pointer resting on a row — the canvas lifts that type and recedes the
   *  rest. A key that only toggled was a key you had to DESTROY the map to
   *  read: the sole way to find out which dots were communities was to hide
   *  the other three and put them back. */
  onHighlight: (t: NodeType | null) => void;
}) {
  if (types.length === 0) return null;
  return (
    <div /* max-h + scroll: a map with every type present, with the notes open, must
         never grow past the canvas it is labelling. */
      onPointerLeave={() => onHighlight(null)}
      className="absolute bottom-3 left-3 z-10 max-h-[calc(100%-1.5rem)] w-44 overflow-y-auto rounded-md border border-slate-800 bg-slate-950/85 px-2 pb-2 pt-2 shadow-lg">
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
                onPointerEnter={() => on && onHighlight(t)}
                onPointerLeave={() => onHighlight(null)}
                onFocus={() => on && onHighlight(t)}
                onBlur={() => onHighlight(null)}
                aria-pressed={on}
                title={`hover to pick them out · click to ${on ? "hide" : "show"} ${TYPE_LABEL[t]}`}
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
      {/* The two footnotes are a DISCLOSURE, not standing text.
          Eleven lines of 10px prose in a 176px column made the key taller than
          the corner it sits in — on a normal window the last line ran off the
          bottom of the canvas and the sentence about publishers and directories
          was cut in half, so the one place the palette's compromise gets
          confessed was the one place nobody could read. Closed it is four rows
          and a link; open, it says everything it said before. */}
      <details className="group mt-1.5 border-t border-slate-800/70 pt-1.5">
        <summary className="cursor-pointer list-none px-1 font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500 transition-colors hover:text-slate-300">
          <span className="group-open:hidden">what the marks mean</span>
          <span className="hidden group-open:inline">hide</span>
        </summary>
        <p className="mt-1 px-1 text-[10px] leading-4 text-slate-500">
          counts = drawn nodes · size = placement · ring = the anchor · nodes wear
          their favicon
        </p>
        <p
          title="The --type-* palette is fixed at a few hues in both themes, and neither the product blue nor the rival pink would be honest for a newsletter or a vendor directory. Each node's detail card names its real kind."
          className="mt-1 px-1 text-[10px] leading-4 text-slate-600"
        >
          communities = community · publisher · directory
        </p>
      </details>
    </div>
  );
}
