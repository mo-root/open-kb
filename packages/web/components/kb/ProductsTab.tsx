"use client";

import { useMemo } from "react";
import type { NoteRef } from "@/lib/viewTypes";
import { RELATION_BLURB } from "@/lib/viewTypes";
import { relationFacets } from "@/lib/notes-view";
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
  readPages = [],
  strips = [],
  integrations = [],
  rivalLeads = [],
  rivalsOnMap,
  brand,
  openNote,
}: {
  catalog?: { name: string; does: string; foundAt?: string }[]
  markets?: { name: string; does: string; centrality?: string; covers: string[] }[]
  /** The pages the understand stage read to write the catalog, cited under
   *  the "What <brand> sells" explainer so a reader can follow the same
   *  links the model did. */
  readPages?: string[]
  /** The strip artifact (spec section "Strip"): per product, the terms a
   *  buyer would actually type, closest-first — the audit trail behind the
   *  plain-family templates and the widening loop's reserve draws. */
  strips?: { product: string; terms: string[]; generic: boolean; foundAt: string }[]
  /** Who the anchor says it works with, off its own docs — the catalog's
   *  triple under a different name, and belonging beside it for the same
   *  reason: everything else on this tab is somebody else's product, judged. */
  integrations?: { with: string; does: string; foundAt?: string }[]
  /** The rivals the anchor names on its own comparison pages, each with the
   *  url that named it, and how many of those names this map holds. */
  rivalLeads?: { name: string; foundAt?: string }[]
  rivalsOnMap?: number
  /** The company's own name for itself (`decomposition.brand`). Falls back
   *  to "this company" when a run predates that field. */
  brand?: string
  notes: NoteRef[];
  openNote: (p: string) => void;
}) {
  const products = useMemo(() => notes.filter((n) => n.type === "product"), [notes]);
  const productFacets = useMemo(() => relationFacets(products), [products]);

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
            <SectionHead title={`What ${brand ?? "this company"} sells`} count={catalog.length} />
          </div>
        </div>
        {catalog.length > 0 && (
          <div className="mb-8">
            <p className="mb-3 max-w-[70ch] text-[13px] text-slate-500">
              What {brand ?? "this company"} sells, read from its own pages. Everything below this
              block is somebody else&rsquo;s product, found out in the market.
            </p>
            {readPages.length > 0 && (
              <p className="mb-3 font-mono text-[10px] text-slate-600">
                read from:{" "}
                {readPages.map((u, i) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="text-sky-500 hover:text-sky-400">
                    {i > 0 ? " · " : ""}{(() => { try { return new URL(u).pathname || "/" } catch { return u } })()}
                  </a>
                ))}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.map((p) => (
                <div
                  key={p.name}
                  className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-4"
                >
                  <div className="min-w-0 text-sm font-medium text-slate-100">{p.name}</div>
                  <p className="mt-1 text-[13px] leading-snug text-slate-400">{p.does}</p>
                  {p.foundAt && (
                    <a
                      href={p.foundAt}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block max-w-full truncate font-mono text-[10px] text-sky-400 hover:text-sky-300"
                      title={p.foundAt}
                    >
                      {(() => { try { return new URL(p.foundAt).pathname } catch { return p.foundAt } })()}
                    </a>
                  )}
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

            {strips.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  stripped to {strips.length} search term{strips.length === 1 ? "" : "s"} — the audit
                  trail behind the plain-family queries
                </p>
                <ul className="flex flex-col gap-1.5">
                  {strips.map((s) => (
                    <li key={s.product} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                      <span className="text-slate-200">{s.product}</span>
                      <span className="text-slate-600">→</span>
                      {s.terms.map((t) => (
                        <span
                          key={t}
                          className="rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                        >
                          {t}
                        </span>
                      ))}
                      {s.generic && (
                        <span className="font-mono text-[10px] text-slate-600">
                          generic — searched by category only
                        </span>
                      )}
                      {s.foundAt && (
                        <a
                          href={s.foundAt}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[10px] text-sky-500 hover:text-sky-400"
                        >
                          {(() => { try { return new URL(s.foundAt).pathname || "/" } catch { return s.foundAt } })()}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* WHAT THE COMPANY SAID ABOUT ITSELF, which is the one part of this map
            nothing inferred.

            The understand stage reads the anchor's own docs and feature pages
            before a single search is bought, and it keeps two things a reader
            can check directly: who the company says it plugs into, and who it
            names as competition on its own comparison pages. Both have been
            written by every run since the stage learned to keep them, and no
            surface read either one.

            They sit under the catalog rather than beside the ecosystem below,
            because the dividing line on this tab is not subject matter — it is
            who is speaking. Above: the company, quoted, with the page it said
            it on. Below: the classifier, judging strangers. */}
        {integrations.length > 0 && (
          <div className="mb-8 mt-10 border-t border-slate-800 pt-6">
            <SectionHead
              title="Integrations, from the company's own docs"
              count={integrations.length}
            />
            <p className="mb-3 mt-2 max-w-[70ch] text-[13px] text-slate-500">
              Who {brand ?? "this company"} says it works with, read off its own pages. Claims,
              not findings — each carries the page it was claimed on.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {integrations.map((i, idx) => (
                <div
                  key={`${i.with}-${idx}`}
                  className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-4"
                >
                  <div className="min-w-0 text-sm font-medium text-slate-100">{i.with}</div>
                  <p className="mt-1 text-[13px] leading-snug text-slate-400">{i.does}</p>
                  {i.foundAt && (
                    <a
                      href={i.foundAt}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block max-w-full truncate font-mono text-[10px] text-sky-400 hover:text-sky-300"
                      title={i.foundAt}
                    >
                      {(() => { try { return new URL(i.foundAt).pathname } catch { return i.foundAt } })()}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {rivalLeads.length > 0 && (
          <div className="mb-8">
            {/* The count stated is the length of the list printed directly
                below it, so the sentence and the evidence cannot drift. The
                second number is the run's own honesty check, and it is a
                name-match against the kept rows — worth showing precisely
                because a low one is the interesting case: the company naming
                rivals the sweep did not find. */}
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
              names {rivalLeads.length} rival{rivalLeads.length === 1 ? "" : "s"} on its own
              comparison pages
              {typeof rivalsOnMap === "number" && (
                <span title="How many of those names match an entity this map kept — by any route, not proof the comparison pages put it there.">
                  {" — "}
                  <span className="tnum">{rivalsOnMap}</span> of them match a row on this map
                </span>
              )}
            </p>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
              {rivalLeads.map((r, idx) => (
                <li key={`${r.name}-${idx}`}>
                  {r.foundAt ? (
                    <a
                      href={r.foundAt}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-400 hover:text-sky-300"
                      title={r.foundAt}
                    >
                      {r.name}
                    </a>
                  ) : (
                    <span className="text-slate-300">{r.name}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {products.length > 0 && (
          <div className="mb-4 mt-10 border-t border-slate-800 pt-6">
            <SectionHead title="What the market sells" count={products.length} />
            <p className="mt-2 max-w-[70ch] text-[13px] text-slate-500">
              Other companies&rsquo; products, grouped by which of the markets above was being
              searched when each one turned up.
            </p>
            {/* How those products stand to the anchor, tallied. On the live
                brightdata map 83 of 124 sell AGAINST the anchor (competitor +
                substitute) and 26 plug into it — a difference the grid hid
                until every card was opened. Strongest placement first, same
                order the cards inside each market already follow. */}
            <p className="mt-2 font-mono text-[11px] text-slate-500">
              {productFacets.map((f, i) => (
                <span key={f.relation} title={RELATION_BLURB[f.relation]}>
                  {i > 0 && " · "}
                  <span
                    className="tnum"
                    style={IS_RIVAL.test(f.relation) ? { color: "var(--highlight, #EB368C)" } : undefined}
                  >
                    {f.count}
                  </span>{" "}
                  {f.relation === "none" ? "unplaced" : f.relation}
                </span>
              ))}
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
                  {/* The relation, in words, beside the placement number that
                      encodes it — "place 85" told a reader nothing until they
                      knew the weight table. Same vocabulary and amber-unplaced
                      rule as the entities sidebar rows. */}
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span
                      title={RELATION_BLURB[p.relation]}
                      className={`font-mono text-[10px] ${
                        p.relation === "none" ? "text-amber-400/80" : "text-slate-500"
                      }`}
                    >
                      {p.relation === "none" ? "unplaced" : p.relation}
                    </span>
                    <RelevanceBadge value={p.relevance} />
                  </span>
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
              <SectionHead title="Who's in this market" count={ecosystem.length} />
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
  // A row with no `why` still opens the drawer once it carries `roads`. The
  // classifier's sentence is the part of this that can be missing — it is empty
  // on every host whose front page the run could not read — and the searches
  // that returned the host are exactly what a reader is left with when the
  // judgement is not there. Both absent is still nothing to say.
  const roads = p.roads ?? [];
  if (!p.why && roads.length === 0) return null;
  return (
    <details className="group mt-2.5">
      <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:text-[var(--accent)]">
        <span className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>{" "}
        why this one
      </summary>
      <div className="mt-2 space-y-2 border-l border-slate-800 pl-3">
        {p.why && <p className="text-xs leading-relaxed text-slate-400">{p.why}</p>}
        {/* The literal searches that returned this host, most-seen first. The
            line above is a judgement about the row; this one is the retrieval
            that produced it, and it is the one line in this drawer
            that asks nobody to be taken at their word. */}
        {roads.length > 0 && (
          <div className="font-mono text-[10px] text-slate-500">
            searched{" "}
            {roads.map((q, i) => (
              <span key={q}>
                {i > 0 ? " · " : ""}
                &ldquo;<span className="text-slate-400">{q}</span>&rdquo;
              </span>
            ))}
          </div>
        )}
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
