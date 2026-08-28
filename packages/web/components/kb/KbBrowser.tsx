"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import { NodeGlyph } from "@/components/icons";
import { normalizeDomain } from "@/components/SiteIcon";
import { TYPE_CSS } from "@/lib/nodeTypes";
import { useUrlView } from "@/lib/useUrlView";
import { usePaletteCommands, type Command } from "@/components/CommandPalette";
import type { KbManifest, NoteRef, TypeCounts } from "@/lib/viewTypes";
import { builtAtOf, manifestNum, manifestStr } from "./layerMeta";
import { GraphCanvas } from "./GraphCanvas";
import { KbOverview } from "./KbOverview";
import { NotesTab } from "./NotesTab";
import { ProductsTab } from "./ProductsTab";
import { TabBar, type TabDef } from "./TabBar";

export type Tab = "overview" | "notes" | "products" | "graph";

// Each tab carries its bureau glyph so the bar is scannable by mark, not just
// text: overview→company (the hub), notes→docs, products→product,
// graph→community (the network).
//
// Upstream also ships Market Map, Listening, Signals and Agent Swarm. This
// engine runs none of those stages, so their tabs are not drawn: an empty tab
// is a promise the product cannot keep, and the house rule is to name a surface
// only once something writes to it.
const TABS: TabDef<Tab>[] = [
  { id: "overview", label: "Overview", glyph: "company" },
  { id: "notes", label: "Entities", glyph: "docs" },
  { id: "products", label: "Products & Ecosystem", glyph: "product" },
  { id: "graph", label: "Graph", glyph: "community" },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

/* Tabs that opt into the full pane width. Everything else stays at content
   width, so this cannot regress a surface that was not designed for it. */
const PANE_TABS: ReadonlySet<Tab> = new Set<Tab>(["graph"]);

/**
 * The entity a bare KB URL opens on: the anchor, the one page that explains
 * what every other page is measured against. `company.md` wins by convention
 * wherever it sits in the list; the first note otherwise, so a map that
 * somehow shipped without an anchor note still opens on something rather than
 * a blank pane. Exported (not a component-local closure) so this fallback
 * order can be pinned by a test without a render harness — same shape as
 * HeaderNav's `active()`, extracted for the same reason.
 */
export function pickDefaultNote(notes: Pick<NoteRef, "path">[]): string | null {
  return notes.find((n) => n.path === "company.md")?.path ?? notes[0]?.path ?? null;
}

/** A hand-typed `?tab=` is untrusted input: an unknown id falls back to
 *  Overview rather than rendering a page with no panel in it. */
export function resolveTab(requested: string, ids: ReadonlySet<string>): Tab {
  return (ids.has(requested) ? requested : "overview") as Tab;
}

/** `?note=` deep links land here; a path this map never wrote (a stale link,
 *  a typo, a note the run dropped since the link was shared) falls back to
 *  the default note rather than a dead view. */
export function resolveNote(
  requested: string | null,
  notes: Pick<NoteRef, "path">[],
  defaultNote: string | null,
): string | null {
  return requested && notes.some((n) => n.path === requested) ? requested : defaultNote;
}

export function KbBrowser({
  slug,
  manifest,
  brand: companyBrand,
  notes,
  counts,
  unplaced,
  noise,
  catalog,
  markets,
  readPages,
  strips,
  integrations,
  rivalLeads,
  rivalsOnMap,
  initialNote,
}: {
  /** The anchor's own products, and the markets they group into. */
  catalog?: { name: string; does: string; foundAt?: string }[]
  markets?: { name: string; does: string; centrality?: string; covers: string[] }[]
  /** The strip artifact: per product, the terms it was stripped to. */
  strips?: { product: string; terms: string[]; generic: boolean; foundAt: string }[]
  /** What the anchor published about itself: who it says it plugs into, and
   *  the rivals it names on its own comparison pages (with how many of those
   *  names this map holds). Both ride straight through to ProductsTab. */
  integrations?: { with: string; does: string; foundAt?: string }[]
  rivalLeads?: { name: string; foundAt?: string }[]
  rivalsOnMap?: number
  slug: string;
  manifest: KbManifest | null;
  /** The company's own name for itself (`decomposition.brand`), for
   *  ProductsTab's "What <brand> sells" heading. Distinct from the `brand`
   *  computed below for the page header, which falls back to the slug rather
   *  than "this company". */
  brand?: string;
  notes: NoteRef[];
  /** Entities per node type, tallied by the reader off the run. */
  counts: TypeCounts;
  /** Entities on the map that the classifier would not place. */
  unplaced: number;
  /** Hosts the run paid for and the classifier threw away. */
  noise: number;
  /** The pages the understand stage read to write the catalog. */
  readPages?: string[];
  initialNote?: string;
}) {
  const defaultNote = useMemo(() => pickDefaultNote(notes), [notes]);

  const [view, go] = useUrlView({
    tab: "overview",
    note: resolveNote(initialNote ?? null, notes, null),
  });

  const tab: Tab = resolveTab(view.tab, TAB_IDS);
  const selected = resolveNote(view.note, notes, defaultNote);

  const setTab = useCallback((id: Tab) => go({ tab: id }), [go]);
  const setSelected = useCallback((path: string) => go({ note: path }, "push"), [go]);

  const openNote = useCallback(
    (path: string) => go({ tab: "notes", note: path }, "push"),
    [go],
  );

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

  /* Counts on the tabs. A tab that says how much is behind it is the cheapest
     navigation aid there is — the reader decides whether Products is worth a
     click before spending one. Graph carries none: its "size" is the same
     entity set the Entities tab already counted, and repeating a number in two
     places invites a reader to look for the difference. */
  const tabsWithCounts = useMemo<TabDef<Tab>[]>(
    () =>
      TABS.map((t) =>
        t.id === "notes"
          ? { ...t, count: notes.length }
          : t.id === "products"
            ? { ...t, count: (catalog?.length ?? 0) + counts.product }
            : t,
      ),
    [notes.length, catalog?.length, counts.product],
  );

  /* Every entity on this map, offered to ⌘K. The palette is the fastest route
     to a named thing — faster than the sidebar once a map runs past a screen —
     and registering here means it always describes the KB actually open. */
  const commands = useMemo<Command[]>(() => {
    const tabCmds: Command[] = TABS.map((t) => ({
      id: `tab:${t.id}`,
      title: t.label,
      group: "Go to",
      glyph: t.glyph,
      run: () => setTab(t.id),
    }));
    const noteCmds: Command[] = notes.map((n) => ({
      id: `note:${n.path}`,
      title: n.title,
      hint: n.relation === "none" ? "unplaced" : n.relation,
      group: "Entities",
      glyph: "docs",
      run: () => openNote(n.path),
    }));
    return [...tabCmds, ...noteCmds];
  }, [notes, setTab, openNote]);

  usePaletteCommands(commands);

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
          {/* THE UNPLACED BADGE IS GONE FROM THE HEADER — owner's call, and
              the gallery card made the same one first: an amber count of what
              the engine could not connect was the loudest mark on every map's
              title line. The number is not hidden — the overview's diagnostics
              still state it, and the canvas legend counts it — it has simply
              stopped being the first thing a visitor reads next to the
              company's name. */}
          <a
            href={`/api/kb/${slug}/export`}
            download
            title="Download this knowledge base as a folder of markdown — one note per entity with its receipts, wikilinks as edges, and AGENTS.md explaining how to read it honestly. What an agent needs to walk the map without this app."
            className="ml-auto rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-500/20"
          >
            export ↓
          </a>
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

      <div className="w-content mx-auto mb-5">
        <TabBar tabs={tabsWithCounts} active={tab} onChange={setTab} />
      </div>

      {/* key={tab}: remounting the panel wrapper is what makes `.panel-in` play
          once per switch, and it is also what tells the reader the view under
          the bar changed rather than merely re-rendered. */}
      <div
        key={tab}
        role="tabpanel"
        id={`kb-panel-${tab}`}
        aria-labelledby={`kb-tab-${tab}`}
        tabIndex={-1}
        className={`panel-in ${PANE_TABS.has(tab) ? "" : "w-content mx-auto"}`}
      >
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
          <ProductsTab
            notes={notes}
            catalog={catalog}
            markets={markets}
            readPages={readPages}
            strips={strips}
            integrations={integrations}
            rivalLeads={rivalLeads}
            rivalsOnMap={rivalsOnMap}
            brand={companyBrand}
            openNote={openNote}
          />
        )}
        {tab === "graph" && <GraphCanvas slug={slug} openNote={openNote} />}
      </div>
    </div>
  );
}
