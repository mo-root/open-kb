"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { NodeGlyph, type GlyphKind } from "@/components/icons";
import { normalizeDomain } from "@/components/SiteIcon";
import { TYPE_CSS } from "@/lib/nodeTypes";
import type { KbManifest, NoteRef, TypeCounts } from "@/lib/viewTypes";
import { builtAtOf, manifestNum, manifestStr } from "./layerMeta";
import { GraphCanvas } from "./GraphCanvas";
import { KbOverview } from "./KbOverview";
import { NotesTab } from "./NotesTab";
import { ProductsTab } from "./ProductsTab";

type Tab = "overview" | "notes" | "products" | "graph";

// Each tab carries its bureau glyph so the bar is scannable by mark, not just
// text: overview→company (the hub), notes→docs, products→product,
// graph→community (the network).
//
// Upstream also ships Market Map, Listening, Signals and Agent Swarm. This
// engine runs none of those stages, so their tabs are not drawn: an empty tab
// is a promise the product cannot keep, and the house rule is to name a surface
// only once something writes to it.
const TABS: { id: Tab; label: string; glyph: GlyphKind }[] = [
  { id: "overview", label: "Overview", glyph: "company" },
  { id: "notes", label: "Entities", glyph: "docs" },
  { id: "products", label: "Products & Ecosystem", glyph: "product" },
  { id: "graph", label: "Graph", glyph: "community" },
];

/* Tabs that opt into the full pane width. Everything else stays at content
   width, so this cannot regress a surface that was not designed for it. */
const PANE_TABS: ReadonlySet<Tab> = new Set<Tab>(["graph"]);

export function KbBrowser({
  slug,
  manifest,
  notes,
  counts,
  unplaced,
  noise,
  initialNote,
}: {
  slug: string;
  manifest: KbManifest | null;
  notes: NoteRef[];
  /** Entities per node type, tallied by the reader off the run. */
  counts: TypeCounts;
  /** Entities on the map that the classifier would not place. */
  unplaced: number;
  /** Hosts the run paid for and the classifier threw away. */
  noise: number;
  initialNote?: string;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<string | null>(() => {
    // ?note= deep links land here; unknown paths fall back to the anchor rather
    // than a dead view.
    if (initialNote && notes.some((n) => n.path === initialNote))
      return initialNote;
    const home = notes.find((n) => n.path === "company.md");
    return home?.path ?? notes[0]?.path ?? null;
  });

  const openNote = useCallback((path: string) => {
    setSelected(path);
    setTab("notes");
  }, []);

  const brand = manifestStr(manifest, "brand", "input") ?? slug;
  const root = normalizeDomain(manifestStr(manifest, "root", "input"));
  const noteCount = manifestNum(manifest, "notes") ?? notes.length;
  const built = builtAtOf(manifest);
  const queries = manifestNum(manifest, "queries");
  const hosts = manifestNum(manifest, "hosts");

  /* port NOTE, v1's "O1" bug, and why it cannot recur here.
     Upstream this line read `manifest.player_notes ?? counts.player`, with a
     long comment about `manifest.players` being the number of player HOMEPAGES
     HARVESTED (8) while `player_notes` was the number of notes WRITTEN (44) —
     reading the wrong one undercounted the ecosystem 5x on every KB. There is
     one number here and the reader computes it off the run itself, so the two
     cannot disagree. */
  const playerCount = counts.player;

  return (
    <div className="w-pane mx-auto px-5 py-6">
      <div className="w-content mx-auto mb-4">
        <div className="flex items-center gap-3">
          {/* ← is a text back-affordance, not a NodeGlyph type mark — kept as a
              glyph in the label run alongside the other unicode affordances. */}
          <Link href="/kb" className="text-xs text-slate-500 hover:text-slate-300">
            ← all
          </Link>
          <h1 className="font-mono text-lg text-slate-100">{brand}</h1>
          {/* PORT NOTE — v1 badged `violations` here: green "verified", titled
              "Every claim is cited, every link resolves, nothing is unsourced —
              the KB passed all integrity checks". This engine runs no such
              check, so that badge would be an unearned pass on a test never
              taken. The badge states the number that IS measured instead: how
              many entities the classifier put on the map and would not place. */}
          {unplaced > 0 ? (
            <span
              title="Entities the classifier saw and would not connect to the anchor. They are on the map, wired to nothing — named rather than hidden, because a map that reports none of these is usually a map that stopped looking."
              className="tnum rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300"
            >
              {unplaced} unplaced
            </span>
          ) : (
            <span
              title="Every entity on this map carries a relation to the anchor."
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300"
            >
              all placed
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 tnum">
          {root && (
            <a
              href={`https://${root}`}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400/80 hover:text-sky-300"
            >
              {root}
            </a>
          )}
          <span className="inline-flex items-center gap-1">
            <NodeGlyph kind="docs" size={12} className="shrink-0 text-slate-400" />
            <span>
              <span className="text-slate-400">{noteCount}</span> entities
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <NodeGlyph
              kind="player"
              size={12}
              className="shrink-0"
              style={{ color: TYPE_CSS.player }}
            />
            <span>
              <span className="text-slate-400">{playerCount}</span> players
            </span>
          </span>
          {/* No leading glyph here: the docs page-mark already tags "entities"
              above, and two identical marks in one strip stop being scannable. */}
          {queries !== undefined && (
            <span>
              <span className="text-slate-400">{queries}</span> queries
              {hosts !== undefined && (
                <>
                  {" → "}
                  <span className="text-slate-400">{hosts}</span> hosts
                </>
              )}
            </span>
          )}
          {noise > 0 && (
            <span
              title="Hosts this run paid a search for and the classifier judged unrelated to the market. There is no node for them; the money is spent and the map is empty there."
              className="text-slate-500"
            >
              <span className="text-slate-400">{noise}</span> discarded as noise
            </span>
          )}
          {built && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
              built {built.slice(0, 16).replace("T", " ")}
            </span>
          )}
        </div>
      </div>

      <div className="w-content mx-auto mb-5 flex gap-1 overflow-x-auto border-b border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 font-mono text-xs uppercase tracking-[0.08em] transition ${
              tab === t.id
                ? "border-sky-400 text-slate-100"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {/* Active nav intent = --accent, matching HeaderNav's active glyph
                so header and tab bar can never drift to two different blues. */}
            <NodeGlyph
              kind={t.glyph}
              size={13}
              className={`shrink-0 ${tab === t.id ? "text-[var(--accent)]" : "text-slate-500"}`}
            />
            {t.label}
          </button>
        ))}
      </div>

      <div className={PANE_TABS.has(tab) ? "" : "w-content mx-auto"}>
        {/* key={slug}: the dashboard fetches its own envelope, and remounting
            on a slug change is how it starts fresh without a reset-setState in
            its effect body (see the note there). */}
        {tab === "overview" && (
          <KbOverview key={slug} slug={slug} onOpenGraph={() => setTab("graph")} />
        )}
        {tab === "notes" && (
          <NotesTab
            slug={slug}
            notes={notes}
            selected={selected}
            onSelect={setSelected}
            openNote={openNote}
          />
        )}
        {tab === "products" && (
          <ProductsTab notes={notes} catalog={kb.catalog} markets={kb.markets} openNote={openNote} />
        )}
        {tab === "graph" && <GraphCanvas slug={slug} openNote={openNote} />}
      </div>
    </div>
  );
}
