"use client";

import { useMemo } from "react";
import type { NoteRef } from "@/lib/viewTypes";
import { RELATION_BLURB } from "@/lib/viewTypes";
import { KindChip, RelevanceBadge, SectionHead } from "@/components/ui";
import { SiteIcon } from "@/components/SiteIcon";
import { NodeGlyph, type GlyphKind } from "@/components/icons";
import { TYPE_CSS } from "@/lib/nodeTypes";

/* ---------------------------------------------------------------------------
   PORT NOTE (open-kb) — same tab, no parsing.

   v1's ProductsTab made two requests on mount and ran three regexes over what
   came back: `products/_catalog.md` for the taglines
   (`- [[products/x]] — blurb`), and `ecosystem.md` for the player table
   (`| [[players/x]] | kind | scope |`), with a whole second parser kept for the
   PROSE format older KBs used. Its own comment records what that cost: "This is
   why the tab read 'No ecosystem players parsed' on every recent KB: the note
   switched to a table and only the prose parser existed."

   The entities arrive as data here, off the same `KbView` the page already
   rendered, so all of it is gone: no fetch, no loading skeleton, no format to
   drift. `parseCatalogTaglines`, `parseTablePlayers`, `parseProsePlayers` and
   `parsePlayers` have no input and are not ported.

   THE GROUPING CHANGED TOO, and had to. v1 split on the note's KIND
   (`/competitor|rival/`) because kind was the only axis its table carried.
   Kind here says what a host IS (company, publisher, directory) and RELATION
   says how it stands to the anchor — so the split is on relation, which is the
   question "who competes with us" actually asks. Kind still shows on every
   card, as a chip.

   And a third group exists that v1 had no equivalent for: the entities the
   classifier would not place. Every other surface names them, so this one does
   too.
--------------------------------------------------------------------------- */

/* Mono uppercase pink pre-title (the sanctioned 15% highlight), borrowed from
   the catalog-app dashboard vocabulary to frame each section head. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono text-[10px] uppercase tracking-[0.2em]"
      style={{ color: "var(--highlight, #EB368C)" }}
    >
      {children}
    </div>
  );
}

/* One cell of the ecosystem stat strip (catalog-app framing). */
function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  /** Optional value colour (a CSS colour / token); defaults to ink slate. */
  color?: string;
}) {
  return (
    <div className="px-3 py-1.5">
      <div
        className="tnum text-sm font-semibold leading-none text-slate-200"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
    </div>
  );
}

/** Head-to-head: a rival sells against the anchor for the same buyer, or solves
 *  the buyer's problem a different way. Everything else with a relation is the
 *  surrounding ecosystem. */
const IS_RIVAL = /^(competitor|substitute)$/i;

/**
 * Group findings by the market whose queries surfaced them.
 *
 * `foundBy` is strongest-first, so the first name that matches a declared
 * market wins. Anything unattributed lands in one bucket at the end rather than
 * being dropped: a finding with no market is still a finding, and hiding it
 * would make the tab quietly disagree with the entity count.
 *
 * Markets keep the order the decomposition gave them, which is core before
 * adjacent, so the reader meets the company's main business first.
 */
function groupByMarket(
  rows: NoteRef[],
  markets: { name: string }[],
): [string, NoteRef[]][] {
  const key = (s: string) => s.trim().toLowerCase()
  const declared = new Map(markets.map((m) => [key(m.name), m.name]))
  const buckets = new Map<string, NoteRef[]>()
  for (const m of markets) buckets.set(m.name, [])
  const UNPLACED = "not attributed to a market"

  for (const r of rows) {
    const hit = (r.foundBy ?? []).map((m) => declared.get(key(m))).find(Boolean)
    const bucket = hit ?? UNPLACED
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket)!.push(r)
  }
  return [...buckets.entries()].filter(([, v]) => v.length > 0)
}

export function ProductsTab({
  notes,
  catalog = [],
  markets = [],
  openNote,
}: {
  catalog?: { name: string; does: string }[]
  markets?: { name: string; does: string; centrality?: string; covers: string[] }[]
  notes: NoteRef[];
  openNote: (p: string) => void;
}) {
  const products = useMemo(() => notes.filter((n) => n.type === "product"), [notes]);

  /* The ecosystem is everything that is not a product and not the anchor:
     companies, communities, publishers and directories alike. v1 listed only
     `players/`, but a directory that lists this market is part of the ecosystem
     by any reading, and the kind chip on each card keeps the distinction. */
  const ecosystem = useMemo(
    () => notes.filter((n) => n.type !== "product" && n.relation !== "anchor"),
    [notes],
  );

  const rivals = useMemo(
    () => ecosystem.filter((p) => IS_RIVAL.test(p.relation)),
    [ecosystem],
  );
  const related = useMemo(
    () => ecosystem.filter((p) => !IS_RIVAL.test(p.relation) && p.relation !== "none"),
    [ecosystem],
  );
  const unplaced = useMemo(
    () => ecosystem.filter((p) => p.relation === "none"),
    [ecosystem],
  );
  const domainCount = useMemo(
    () => new Set(ecosystem.map((p) => p.domain).filter(Boolean)).size,
    [ecosystem],
  );

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <div>
          <Eyebrow>Catalog</Eyebrow>
          <div className="flex items-center gap-2">
            <NodeGlyph
              kind="product"
              size={16}
              className="shrink-0"
              style={{ color: TYPE_CSS.product }}
            />
            <SectionHead title="What this company sells" count={catalog.length} />
          </div>
        </div>
        {catalog.length > 0 && (
          <div className="mb-8">
            <p className="mb-3 max-w-[70ch] text-[13px] text-slate-500">
              What this company sells, read from its own pages. Everything below this block is
              somebody else&rsquo;s product, found out in the market.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.map((p) => (
                <div
                  key={p.name}
                  className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-4"
                >
                  <div className="min-w-0 text-sm font-medium text-slate-100">{p.name}</div>
                  <p className="mt-1 text-[13px] leading-snug text-slate-400">{p.does}</p>
                </div>
              ))}
            </div>

            {markets.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  grouped into {markets.length} markets, which is how the query budget was split
                </p>
                <ul className="flex flex-col gap-1.5">
                  {markets.map((m) => (
                    <li key={m.name} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                        {m.centrality ?? "—"}
                      </span>
                      <span className="text-slate-200">{m.name}</span>
                      <span className="min-w-0 text-slate-500">{m.covers.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {products.length > 0 && (
          <div className="mb-4 mt-10 border-t border-slate-800 pt-6">
            <SectionHead title="Products found out in the market" count={products.length} />
            <p className="mt-2 max-w-[70ch] text-[13px] text-slate-500">
              Other companies&rsquo; products, grouped by which of the markets above was being
              searched when each one turned up.
            </p>
          </div>
        )}

        {products.length === 0 ? (
          <p className="text-sm text-slate-500">
            The classifier tagged nothing on this map as a standalone product —
            everything it kept is a company, a community, a publisher or a
            directory.
          </p>
        ) : (
          <div className="flex flex-col gap-7">
            {groupByMarket(products, markets).map(([marketName, rows]) => (
              <div key={marketName}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
                    {marketName}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-slate-600">{rows.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((p) => (
              <button
                key={p.path}
                onClick={() => openNote(p.path)}
                className="prov-rail group flex flex-col rounded-lg border border-slate-800 bg-slate-900/40 p-4 pl-5 text-left transition hover:border-slate-700 hover:bg-slate-900/70"
                style={{ "--rel": p.relevance } as React.CSSProperties}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <SiteIcon domain={p.domain} name={p.title} size={16} />
                    <span className="truncate font-medium text-slate-100 group-hover:text-sky-300">
                      {p.title}
                    </span>
                  </span>
                  <RelevanceBadge value={p.relevance} />
                </div>
                <p className="mt-2 text-sm text-slate-400">{p.what}</p>
              </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Eyebrow>Competitive field</Eyebrow>
            <div className="flex items-center gap-2">
              <NodeGlyph
                kind="player"
                size={16}
                className="shrink-0"
                style={{ color: TYPE_CSS.player }}
              />
              <SectionHead title="Ecosystem" count={ecosystem.length} />
            </div>
          </div>
          {ecosystem.length > 0 && (
            <div className="flex items-stretch divide-x divide-slate-800 overflow-hidden rounded-md border border-slate-800 bg-slate-900/40">
              <Stat label="on the map" value={ecosystem.length} />
              <Stat
                label="rivals"
                value={rivals.length}
                color="var(--highlight, #EB368C)"
              />
              <Stat label="domains" value={domainCount} />
              <Stat
                label="unplaced"
                value={unplaced.length}
                color={unplaced.length > 0 ? "#f0a441" : undefined}
              />
            </div>
          )}
        </div>
        {ecosystem.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing on this map beyond the anchor.
          </p>
        ) : (
          <div className="space-y-6">
            <PlayerGroup
              glyph="player"
              color={TYPE_CSS.player}
              title="Head to head"
              blurb="Competitors and substitutes — they are after the same buyer, or they solve the same problem a different way."
              players={rivals}
              openNote={openNote}
            />
            <PlayerGroup
              glyph="community"
              color={TYPE_CSS.community}
              title="The surrounding market"
              blurb="Dependencies, integrations, shapers, buyers and targets — placed against the anchor, but not selling against it."
              players={related}
              openNote={openNote}
            />
            <PlayerGroup
              glyph="alert"
              color="var(--type-core, #9DB2D6)"
              title="Seen, not placed"
              blurb="The classifier read these hosts and would not say how they stand to the anchor. They are listed rather than dropped: a market map that shows only what it could classify is a map that looks finished."
              players={unplaced}
              openNote={openNote}
            />
          </div>
        )}
      </section>
    </div>
  );
}

/* WhyFound, the audit trail behind a single entity.
 *
 * v1 shipped this drawer wired to a `Provenance` record its engine computed
 * while ranking and then never persisted, so `why` was permanently `{}` and no
 * card ever rendered one. The reasoning IS persisted here, the classifier
 * writes a line per host explaining why it belongs on this map, against the
 * anchor, so the drawer finally has its content. A native <details> keeps it
 * collapsed by default: the reasoning is available, not imposed. */
function WhyFound({ p }: { p: NoteRef }) {
  if (!p.why) return null;
  return (
    <details className="group mt-2.5">
      <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:text-[var(--accent)]">
        <span className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>{" "}
        why this one
      </summary>
      <div className="mt-2 space-y-2 border-l border-slate-800 pl-3">
        <p className="text-xs leading-relaxed text-slate-400">{p.why}</p>
        {p.relation !== "none" && (
          <div className="font-mono text-[10px] text-slate-500">
            placed as <span className="text-slate-300">{p.relation}</span>
            {RELATION_BLURB[p.relation] ? ` — ${RELATION_BLURB[p.relation]}` : ""}
          </div>
        )}
      </div>
    </details>
  );
}

function PlayerGroup({
  glyph,
  color,
  title,
  blurb,
  players,
  openNote,
}: {
  glyph: GlyphKind;
  color: string;
  title: string;
  blurb: string;
  players: NoteRef[];
  openNote?: (p: string) => void;
}) {
  if (players.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <NodeGlyph kind={glyph} size={14} className="shrink-0" style={{ color }} />
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
          {title}
        </span>
        <span className="tnum text-[11px] text-slate-500">{players.length}</span>
      </div>
      <p className="mb-3 max-w-2xl text-xs text-slate-500">{blurb}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {players.map((pl) => (
          <div
            key={pl.path}
            className="rounded-lg border border-slate-800 bg-slate-900/40 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <SiteIcon domain={pl.domain} name={pl.title} size={20} />
                <div className="min-w-0">
                  {openNote ? (
                    <button
                      onClick={() => openNote(pl.path)}
                      className="block max-w-full truncate text-left font-medium text-slate-100 transition-colors hover:text-[var(--accent)]"
                      title="Open this entity"
                    >
                      {pl.title}
                    </button>
                  ) : (
                    <div className="truncate font-medium text-slate-100">
                      {pl.title}
                    </div>
                  )}
                  {pl.domain && (
                    <a
                      href={`https://${pl.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-sky-300 hover:text-sky-200"
                    >
                      {pl.domain}
                    </a>
                  )}
                </div>
              </div>
              <KindChip kind={pl.kind} />
            </div>
            {pl.what && <p className="mt-2 text-sm text-slate-400">{pl.what}</p>}
            <WhyFound p={pl} />
          </div>
        ))}
      </div>
    </div>
  );
}
