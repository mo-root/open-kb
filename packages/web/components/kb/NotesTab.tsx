"use client";

import { useMemo } from "react";
import type { NoteRef } from "@/lib/viewTypes";
import { groupLabel, nodeTypeOf, TYPE_CSS } from "@/lib/nodeTypes";
import { NodeGlyph, glyphForNotePath } from "@/components/icons";
import { NoteView } from "./NoteView";

/* port NOTE, ported verbatim except for two things.
   The sidebar now shows the classifier's RELATION beside each entity instead of
   a bare number, because "competitor" is what a reader is scanning for and the
   number is only a rank derived from it (see lib/kb-from-run.ts). Entities the
   classifier would not place sort last inside their group rather than being
   hidden — same rule as the graph. */

function groupOf(path: string): string {
  const idx = path.indexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "overview";
}

export function NotesTab({
  slug,
  notes,
  selected,
  onSelect,
  openNote,
}: {
  slug: string;
  notes: NoteRef[];
  selected: string | null;
  onSelect: (p: string) => void;
  openNote: (p: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, NoteRef[]>();
    for (const n of notes) {
      const g = groupOf(n.path);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(n);
    }
    const order = Array.from(map.keys()).sort((a, b) => {
      if (a === "overview") return -1;
      if (b === "overview") return 1;
      return a.localeCompare(b);
    });
    return order.map((g) => ({
      name: g,
      items: map
        .get(g)!
        .slice()
        .sort((x, y) => y.relevance - x.relevance || x.title.localeCompare(y.title)),
    }));
  }, [notes]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
        <nav className="space-y-4">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="mb-1 flex items-center gap-1.5 px-2 font-mono text-[11px] uppercase tracking-wider text-slate-500">
                <span
                  aria-hidden
                  className="shrink-0"
                  style={{ color: TYPE_CSS[nodeTypeOf(g.name)] }}
                >
                  <NodeGlyph
                    kind={
                      g.name === "overview"
                        ? "company"
                        : glyphForNotePath(g.name)
                    }
                    size={13}
                  />
                </span>
                <span>{groupLabel(g.name)}</span>
                <span className="tnum ml-auto normal-case text-slate-500">
                  {g.items.length}
                </span>
              </div>
              <ul>
                {g.items.map((n) => {
                  const active = n.path === selected;
                  const unplaced = n.relation === "none";
                  return (
                    <li key={n.path}>
                      <button
                        onClick={() => onSelect(n.path)}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition ${
                          active
                            ? "bg-sky-500/10 text-sky-300"
                            : "text-slate-300 hover:bg-slate-800/50"
                        }`}
                      >
                        <span className="truncate">{n.title}</span>
                        <span
                          className={`shrink-0 font-mono text-[10px] ${
                            unplaced ? "text-amber-400/80" : "text-slate-500"
                          }`}
                        >
                          {unplaced ? "unplaced" : n.relation}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0">
        {selected ? (
          <NoteView
            key={selected}
            slug={slug}
            path={selected}
            notes={notes}
            openNote={openNote}
          />
        ) : (
          <div className="p-6 text-sm text-slate-500">No entities.</div>
        )}
      </div>
    </div>
  );
}
