"use client";

import { useMemo, useState } from "react";
import { KbCard } from "@/components/KbCard";
import { manifestStr, builtAtOf } from "@/components/kb/layerMeta";
import type { KbSummary } from "@/lib/viewTypes";

/* The gallery, made navigable.
   ---------------------------------------------------------------------------
   The grid was a plain map over every stored run, newest-ish first, and that
   held up until the deployment had thirty-six of them — most of which are the
   SAME domain mapped again with different settings. At that size the reader's
   two real questions ("where is the brightdata one" and "which of these six
   brightdata runs is the big one") both had the same answer: scroll and squint.

   So: a filter over the domain, and three sorts that each answer one of those
   questions. Both are client-side over a list the server already sent — this
   is a few dozen rows, and a round trip to re-sort them would be slower than
   the reader's own eye.

   The sorts are named for what they surface, not for the field they read:
   "Newest" / "Biggest map" / "Most unplaced". The last one is a lead, not a
   complaint — a map with a lot of unplaced entities is usually the one with
   something in it nobody has looked at yet. */

type Sort = "recent" | "size" | "unplaced";

const SORTS: { id: Sort; label: string; hint: string }[] = [
  { id: "recent", label: "Newest", hint: "Most recently finished run first" },
  { id: "size", label: "Biggest map", hint: "Most entities placed first" },
  {
    id: "unplaced",
    label: "Most unplaced",
    hint: "Maps carrying the most entities the classifier would not place — usually the ones with the most left to look at",
  },
];

function domainOf(kb: KbSummary): string {
  return manifestStr(kb.manifest, "brand", "root", "input") ?? kb.slug;
}

export function KbGallery({ kbs }: { kbs: KbSummary[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? kbs.filter((k) =>
          `${domainOf(k)} ${k.slug}`.toLowerCase().includes(needle),
        )
      : kbs.slice();
    rows.sort((a, b) => {
      if (sort === "size") return b.notes - a.notes;
      if (sort === "unplaced") return b.unplaced - a.unplaced;
      // A run with no recorded finish time sorts last rather than first: an
      // empty string would otherwise beat every real timestamp.
      return (builtAtOf(b.manifest) ?? "").localeCompare(builtAtOf(a.manifest) ?? "");
    });
    return rows;
  }, [kbs, q, sort]);

  // The same domain mapped more than once is the norm here, so say how many
  // distinct domains are behind the count — that is the number a reader means
  // when they ask how much has been mapped.
  const domains = useMemo(() => new Set(shown.map(domainOf)).size, [shown]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[13rem] flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
            placeholder="Filter by domain…"
            aria-label="Filter knowledge bases by domain"
            className="w-full rounded-md border border-slate-800 bg-slate-900/50 py-1.5 pl-2.5 pr-3 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/50"
          />
        </div>
        <div
          role="group"
          aria-label="Sort knowledge bases"
          className="flex overflow-hidden rounded-md border border-slate-800"
        >
          {SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              title={s.hint}
              aria-pressed={sort === s.id}
              className={`px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors duration-150 ${
                sort === s.id
                  ? "bg-sky-500/15 text-sky-300"
                  : "text-slate-500 hover:bg-slate-800/50 hover:text-slate-300"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="tnum shrink-0 font-mono text-xs text-slate-500">
          {shown.length} {shown.length === 1 ? "map" : "maps"} · {domains}{" "}
          {domains === 1 ? "domain" : "domains"}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
          No map matches “{q}”.{" "}
          <button onClick={() => setQ("")} className="text-sky-400 hover:text-sky-300">
            Clear the filter
          </button>
          .
        </div>
      ) : (
        /* key on the ordering: re-keying replays the stagger, so a re-sort
           reads as the grid being rebuilt rather than the cards silently
           swapping places under the cursor. */
        <div
          key={`${sort}:${q}`}
          className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {shown.map((kb) => (
            <KbCard key={kb.slug} kb={kb} />
          ))}
        </div>
      )}
    </>
  );
}
