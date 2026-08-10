"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { NodeGlyph, TYPE_GLYPH } from "@/components/icons";
import { TYPE_CSS, type NodeType } from "@/lib/nodeTypes";

/* Finding one node on a map of three hundred.
   ---------------------------------------------------------------------------
   Until now the only way to reach a named company on the graph was to recognise
   its dot. Labels are drawn for six nodes plus whatever is under the cursor, so
   for the other 289 there was no way to ask "where is apify" — the information
   was on screen and unreachable.

   The box is deliberately thin. It does not filter the graph: hiding non-matches
   would destroy the layout and the whole point is to see WHERE the match sits in
   its neighbourhood. It ranks, it previews, and it hands one id back — the canvas
   decides what to do with it (dim the rest, fly the camera, open the card).

   Matching is prefix-first, then substring, over title AND domain, because
   people search for "apify" and for "apify.com" and both must land. */

import { rankMatches, type SearchItem } from "@/lib/graph/search";
export type { SearchItem };

export function GraphSearch({
  items,
  onPick,
  onQueryChange,
}: {
  items: readonly SearchItem[];
  /** Land on this node: focus it, light its neighbourhood, fly the camera. */
  onPick: (id: string) => void;
  /** Live query, so the canvas can dim everything that does not match. */
  onQueryChange: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => rankMatches(items, q), [items, q]);

  useEffect(() => onQueryChange(q), [q, onQueryChange]);
  useEffect(() => setCursor(0), [q]);

  /* `/` focuses the box from anywhere on the graph, the convention every map
     and every code host uses. Not captured while the reader is already typing
     somewhere — a shortcut that hijacks another field is worse than no
     shortcut. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        boxRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (i: number) => {
    const hit = results[i];
    if (!hit) return;
    onPick(hit.id);
    setOpen(false);
    boxRef.current?.blur();
  };

  return (
    <div className="relative w-56">
      <input
        ref={boxRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // A blur that fires before the click lands would close the list out
        // from under the pointer, so closing waits a frame.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(cursor);
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (q) setQ("");
            else boxRef.current?.blur();
          }
        }}
        placeholder="Find on the map…"
        aria-label="Find a node on the map"
        className="w-full rounded-md border border-slate-800 bg-slate-900/80 py-1 pl-2 pr-10 text-xs text-slate-200 outline-none backdrop-blur transition-colors placeholder:text-slate-500 focus:border-sky-500/50"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-slate-500">
        {q ? `${results.length}` : "/"}
      </kbd>

      {open && q.trim() !== "" && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-800 bg-slate-900 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)]">
          {results.length === 0 ? (
            <li className="px-2.5 py-2 text-[11px] text-slate-500">
              Nothing on this map matches “{q}”.
            </li>
          ) : (
            results.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onMouseMove={() => setCursor(i)}
                  onClick={() => pick(i)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    i === cursor ? "bg-sky-500/12 text-slate-100" : "text-slate-300"
                  }`}
                >
                  <NodeGlyph
                    kind={TYPE_GLYPH[r.type]}
                    size={12}
                    className="shrink-0"
                    style={{ color: TYPE_CSS[r.type] }}
                  />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="tnum shrink-0 font-mono text-[10px] text-slate-500">
                    {r.deg}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
