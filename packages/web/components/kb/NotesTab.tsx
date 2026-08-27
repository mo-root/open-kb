"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteRef } from "@/lib/viewTypes";
import { RELATION_BLURB } from "@/lib/viewTypes";
import { filterNotes, orderNotes, relationFacets } from "@/lib/notes-view";
import { groupLabel, nodeTypeOf, TYPE_CSS } from "@/lib/nodeTypes";
import { NodeGlyph, glyphForNotePath } from "@/components/icons";
import { NoteView } from "./NoteView";

/* port NOTE, ported verbatim except for two things.
   The sidebar now shows the classifier's RELATION beside each entity instead of
   a bare number, because "competitor" is what a reader is scanning for and the
   number is only a rank derived from it (see lib/kb-from-run.ts). Entities the
   classifier would not place sort last inside their group rather than being
   hidden — same rule as the graph.

   The organization logic itself (what a query matches, what a facet narrows,
   what order a group reads in) lives in lib/notes-view.ts, tested — this file
   only renders it. */

export function groupOf(path: string): string {
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
  /* The sidebar filter.
     A map with two hundred entities in it is a list you scroll, not a list you
     read, and the group headings only help once you already know which group a
     company is in. The filter matches the entity's NAME, its DOMAIN, its
     RELATION and any name a swarm merge folded into it (lib/notes-view.ts's
     haystack), so "competitor" narrows to the rivals and "postmark" goes
     straight to one host — the two ways a reader actually arrives.

     The facet row under the box exists because the typed filter demands the
     classifier's vocabulary. On the live brightdata map, "show me the rivals"
     meant already knowing to type "competitor" and then "substitute" — the
     chips show every relation this map actually contains, counted, strongest
     placement first, and one click narrows to it. Clicking the active chip
     clears it.

     Groups with nothing left in them disappear rather than sitting empty: a
     heading over no rows reads as a loading state that never finished. */
  const [filter, setFilter] = useState("");
  const [relation, setRelation] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);

  /* Counted over the WHOLE map, not the query-matched rows: the chip row is
     this map's relation tally (the same facts KbView.relations counts), and a
     count that shrank while you typed would read as the map changing. */
  const facets = useMemo(() => relationFacets(notes), [notes]);

  const matches = useMemo(
    () => filterNotes(notes, { query: filter, relation }),
    [notes, filter, relation],
  );

  const groups = useMemo(() => {
    const map = new Map<string, NoteRef[]>();
    for (const n of matches) {
      const g = groupOf(n.path);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(n);
    }
    const order = Array.from(map.keys()).sort((a, b) => {
      if (a === "overview") return -1;
      if (b === "overview") return 1;
      return a.localeCompare(b);
    });
    /* orderNotes: placement first, then evidence tier — on a swarm run a
       competitor judged from its own page lists above one seen only in a
       snippet; on a sweep run (no tiers anywhere) the order is unchanged. */
    return order.map((g) => ({
      name: g,
      items: orderNotes(map.get(g)!),
    }));
  }, [matches]);

  /* Up/Down walk the visible list, wherever the reader's hands already are —
     inside the filter box or on a row. The list is flattened in the order it
     is drawn, so "next" always means the row below the one that is lit. */
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const step = (dir: 1 | -1) => {
    if (flat.length === 0) return;
    const i = flat.findIndex((n) => n.path === selected);
    const next = i < 0 ? (dir === 1 ? 0 : flat.length - 1) : (i + dir + flat.length) % flat.length;
    onSelect(flat[next].path);
  };

  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Escape" && (filter || relation)) {
      // Peel the narrower filter first: the typed query, then the facet.
      e.preventDefault();
      if (filter) setFilter("");
      else setRelation(null);
    }
  };

  // Follow the selection into view — arrow-stepping past the fold, or landing
  // here from ⌘K or a graph click, should never leave the lit row off screen.
  useEffect(() => {
    boxRef.current
      ?.closest("aside")
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      <aside
        onKeyDown={onNavKey}
        className="lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100vh-6rem)] lg:flex-col lg:self-start"
      >
        <div className="relative mb-3 shrink-0">
          <input
            ref={boxRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter entities…"
            aria-label="Filter entities by name, domain or relation"
            className="w-full rounded-md border border-slate-800 bg-slate-900/50 py-1.5 pl-2.5 pr-16 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/50"
          />
          <span className="tnum pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-slate-500">
            {filter || relation ? `${matches.length}/${notes.length}` : notes.length}
          </span>
        </div>
        {/* The map's relations, counted, as one-click facets. Strongest
            placement first (competitor leads), so the row itself answers "who
            is after this company" before anything is clicked. */}
        {facets.length > 1 && (
          <div
            role="group"
            aria-label="Filter entities by relation"
            className="mb-3 flex shrink-0 flex-wrap gap-1"
          >
            {facets.map((f) => {
              const active = relation === f.relation;
              const label = f.relation === "none" ? "unplaced" : f.relation;
              return (
                <button
                  key={f.relation}
                  onClick={() => setRelation(active ? null : f.relation)}
                  aria-pressed={active}
                  title={RELATION_BLURB[f.relation]}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                    active
                      ? "border-sky-400 bg-sky-500/10 text-sky-300"
                      : "border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                  }`}
                >
                  {label}
                  <span className={`tnum ${active ? "text-sky-400/80" : "text-slate-500"}`}>
                    {f.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <nav className="space-y-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {flat.length === 0 && (
            <p className="px-2 py-6 text-xs text-slate-500">
              {filter ? (
                <>No entity matches “{filter}”{relation ? ` under ${relation === "none" ? "unplaced" : relation}` : ""}. </>
              ) : (
                <>No entity is placed as {relation === "none" ? "unplaced" : relation}. </>
              )}
              <button
                onClick={() => {
                  setFilter("");
                  setRelation(null);
                }}
                className="text-sky-400 hover:text-sky-300"
              >
                Clear the filter
              </button>
              .
            </p>
          )}
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
                        data-selected={active}
                        aria-current={active ? "true" : undefined}
                        /* The lit row grows a left edge in the accent rather
                           than only changing fill: at a glance down a long
                           list, an edge is findable and a tint is not. */
                        className={`flex w-full items-center justify-between gap-2 rounded border-l-2 px-2 py-1.5 text-left text-sm transition-colors duration-150 ${
                          active
                            ? "border-sky-400 bg-sky-500/10 text-sky-300"
                            : "border-transparent text-slate-300 hover:border-slate-700 hover:bg-slate-800/50"
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
        {/* A shortcut nobody is told about does not exist. One line, at the
            bottom of the list where it is out of the way of the reading. */}
        {flat.length > 1 && (
          <p className="mt-3 hidden shrink-0 border-t border-slate-800/60 pt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500 lg:block">
            ↑↓ step · ⌘K jump
          </p>
        )}
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
