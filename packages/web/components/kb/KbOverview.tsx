"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { NodeGlyph, TYPE_GLYPH } from "@/components/icons";
import { SiteIcon } from "@/components/SiteIcon";
import {
  TYPE_CSS,
  TYPE_LABEL,
  TYPE_ORDER,
  type NodeType,
} from "@/lib/nodeTypes";
import {
  GROUNDING_MEAN_BLURB,
  RELATION_BLURB,
  type KbScorecard,
  type KbView,
  type NoteRef,
} from "@/lib/viewTypes";
import { gateExchange, nOfM, share, usdOfUsd } from "@/lib/scorecard-view";
import { builtAtOf, manifestNum, manifestStr } from "./layerMeta";
import {
  BarMeter,
  Donut,
  Gauge,
  Sparkline,
  StatTile,
  type BarMeterRow,
} from "@/components/viz";

/* KbOverview, the KB's intelligence dashboard: an instrument panel reading
   what this brain holds and what it aims at, in one glance. Real hand-rolled
   dataviz (composition donut, ecosystem bars, signal-quality gauges), never
   chrome for its own sake.

   Data (read-only; no API is modified here):
     GET /api/kb/<id>  -> { slug, manifest, counts, notes, kinds, relations }

   PORT NOTE — TWO THINGS WENT, ONE ARRIVED.

   1. THE SECOND REQUEST. v1 also fetched `/api/kb/<slug>/note?path=ecosystem.md`
      and re-parsed a markdown table out of the body to recover "players by
      kind". The tallies ride in the envelope now, counted straight off the run,
      so there is one request and no format between the count and the reader.

   2. THE LISTENING PANEL. v1 shipped it "wired but dormant", waiting for a
      listening catalog no engine wrote. This engine has no listening stage
      either, and the house rule KbBrowser states is to name a surface only once
      something writes to it — so it is not ported, rather than ported asleep.

   3. WHAT ARRIVED: the unplaced. Every other KB surface reports how much of the
      map the classifier would not connect to the anchor; the dashboard is where
      a reader looks first, so it reports it in the KPI row and draws it as the
      second gauge. */

/* Relations, in display order, each with a sanctioned brand hue. Rivals take
   the pink; the rest fan across the blue / lavender / muted tokens. Every bar
   is direct-labelled, so these near hues stay gate-safe.

   v1's equivalent map was keyed by its own six player KINDS (competitor,
   alternative, adjacent, integration, dependency, partner). The axis here is
   the RELATION the classifier assigned, which is the thing this engine actually
   decides — the hues are carried across one-for-one where the words match. */
const RELATION_ORDER = [
  "competitor",
  "substitute",
  "integration",
  "dependency",
  "shaper",
  "buyer",
  "target",
  "none",
];
const RELATION_COLOR: Record<string, string> = {
  competitor: "var(--type-player, #EB368C)",
  substitute: "#F072AC",
  integration: "#76A5FF",
  dependency: "var(--type-community, #D95926)",
  shaper: "var(--accent, #3D7FFC)",
  buyer: "var(--type-core, #9DB2D6)",
  target: "#8FA3C6",
  // The unplaced wear the advisory amber wherever they appear, so the eye
  // learns one colour for "the run did not answer this".
  none: "#F0A441",
};

function timeAgo(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const pct = (v: number, total: number) =>
  total > 0 ? Math.round((v / total) * 100) : 0;

export function meanRelevance(notes: NoteRef[]): number {
  if (notes.length === 0) return 0;
  const sum = notes.reduce((acc, n) => acc + (n.relevance || 0), 0);
  return Math.max(0, Math.min(100, Math.round(sum / notes.length)));
}

/* ---------- small shared chrome ---------- */

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-slate-800 bg-slate-900/30 p-4 ${className}`}
    >
      {children}
    </section>
  );
}

function PanelHead({
  title,
  count,
  right,
}: {
  title: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
        {title}
        {count !== undefined && (
          <span className="tnum ml-2 text-slate-400">{count}</span>
        )}
      </h3>
      {right}
    </div>
  );
}

function typeGlyph(t: NodeType, size = 12) {
  return (
    <span style={{ color: TYPE_CSS[t] }}>
      <NodeGlyph kind={TYPE_GLYPH[t]} size={size} />
    </span>
  );
}

/* ---------- panels ---------- */

function CompositionPanel({
  counts,
  total,
}: {
  counts: Record<NodeType, number>;
  total: number;
}) {
  const segments = TYPE_ORDER.map((t) => ({
    key: t,
    label: TYPE_LABEL[t],
    value: counts[t],
    color: TYPE_CSS[t],
    glyph: <NodeGlyph kind={TYPE_GLYPH[t]} size={12} />,
  }));
  return (
    <Card className="reveal reveal-2">
      <PanelHead title="Composition" count={total} />
      {total === 0 ? (
        <p className="py-6 text-center font-mono text-[11px] text-slate-500">
          nothing on the map — run a sweep to fill this panel.
        </p>
      ) : (
        <Donut
          segments={segments}
          centerValue={total}
          centerLabel="entities"
          legend="right"
        />
      )}
    </Card>
  );
}

/* port NOTE, v1's "Signal quality" panel drew mean relevance against 100 and
   documentation coverage (docs read / docs enumerated), with a deliberate
   withheld state for the second dial: "A doc-coverage gauge with no doc set
   reads as '0% read', which is a different and much worse claim than 'this
   build did not enumerate one'."

   This engine enumerates no doc set either — it follows pages as it finds them
   — so that dial has no input. Rather than keep the withheld state as permanent
   furniture, the slot draws the ratio this engine DOES measure and that matters
   most: how much of the host bag the classifier could actually place. */
function PlacementPanel({
  placement,
  placed,
  total,
  profile,
}: {
  placement: number;
  placed: number;
  total: number;
  profile: number[];
}) {
  const coverage = pct(placed, total);
  return (
    <Card className="reveal reveal-2">
      <PanelHead title="Placement" />
      <div className="flex flex-wrap items-center justify-around gap-4">
        <Gauge
          value={placement}
          max={100}
          size={116}
          color="var(--accent, #3D7FFC)"
          label="mean place"
        />
        <Gauge
          value={coverage}
          max={100}
          size={116}
          color={coverage >= 60 ? "#76A5FF" : "#F0A441"}
          valueText={`${coverage}%`}
          label="placed"
        />
      </div>
      <div className="mt-3 border-t border-slate-800 pt-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            placement profile
          </span>
          <span className="tnum font-mono text-[10px] text-slate-500">
            {placed}/{total} placed
          </span>
        </div>
        {profile.length > 1 ? (
          <Sparkline
            values={profile}
            width={260}
            height={34}
            preserveAspectRatio="none"
            className="w-full"
            ariaLabel={`placement profile across ${profile.length} entities, strongest to weakest`}
          />
        ) : (
          <p className="font-mono text-[10px] text-slate-600">
            not enough entities to profile.
          </p>
        )}
      </div>
    </Card>
  );
}

/* The competitive field at a glance, favicons of the top rivals by placement.
   Always shown when there are players, so the dashboard surfaces WHO the rivals
   are, not just how many. */
function PlayerFaces({ players }: { players: NoteRef[] }) {
  const top = [...players]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 8);
  if (top.length === 0) return null;
  const rest = players.length - top.length;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {top.map((p) => (
        <span key={p.path} title={`${p.title} · ${p.relation}`}>
          <SiteIcon domain={p.domain} name={p.title} size={18} />
        </span>
      ))}
      {rest > 0 && (
        <span className="font-mono text-[10px] text-slate-500">+{rest}</span>
      )}
    </div>
  );
}

function EcosystemPanel({
  relations,
  players,
}: {
  relations: Record<string, number>;
  players: NoteRef[];
}) {
  const seen = Object.keys(relations);
  const ordered = [
    ...RELATION_ORDER.filter((k) => relations[k] > 0),
    ...seen.filter((k) => !RELATION_ORDER.includes(k) && relations[k] > 0),
  ];
  const rows: BarMeterRow[] = ordered.map((k) => ({
    key: k,
    label: k === "none" ? "unplaced" : k,
    value: relations[k] ?? 0,
    color: RELATION_COLOR[k] ?? "var(--type-core, #9DB2D6)",
    glyph: <NodeGlyph kind={k === "none" ? "alert" : "player"} size={13} />,
  }));
  const count = Object.values(relations).reduce((a, b) => a + b, 0);

  return (
    <Card className="reveal reveal-3">
      <PanelHead
        title="Who's in this market"
        count={count}
        right={
          <span className="font-mono text-[10px] lowercase tracking-wide text-slate-600">
            by relation to the anchor
          </span>
        }
      />
      {players.length > 0 && <PlayerFaces players={players} />}
      {rows.length === 0 ? (
        <p className="py-6 text-center font-mono text-[11px] text-slate-500">
          nothing placed yet.
        </p>
      ) : (
        <>
          <BarMeter
            rows={rows}
            barHeight={8}
            sort={false}
            title="ecosystem by relation to the anchor"
          />
          {/* The bars are the classifier's vocabulary and nobody is born
              knowing it, so the words are glossed where they are drawn. */}
          <p className="mt-3 border-t border-slate-800 pt-2.5 text-[10px] leading-4 text-slate-500">
            {ordered
              .slice(0, 3)
              .map((k) => `${k === "none" ? "unplaced" : k} = ${RELATION_BLURB[k] ?? ""}`)
              .join(" · ")}
          </p>
        </>
      )}
    </Card>
  );
}

function CommunitiesPanel({ communities }: { communities: NoteRef[] }) {
  const shown = communities.slice(0, 14);
  const rest = communities.length - shown.length;
  const color = TYPE_CSS.community;
  return (
    <Card className="reveal reveal-3">
      <PanelHead
        title="Communities, publishers & directories"
        count={communities.length}
        right={
          <span
            title="Three classifier kinds share one colour: the --type-* palette is fixed at four hues, and a subreddit, a newsletter and a vendor list are all third-party venues rather than vendors. Each card names its own kind."
            className="font-mono text-[10px] lowercase tracking-wide text-slate-600"
          >
            three kinds, one hue
          </span>
        }
      />
      {communities.length === 0 ? (
        <div className="flex items-center gap-2.5 py-4 text-slate-500">
          <span style={{ color }} className="opacity-40">
            <NodeGlyph kind="community" size={16} />
          </span>
          <p className="font-mono text-[11px]">
            none mapped — no third-party venues surfaced for this market yet.
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((c) => (
              <li
                key={c.path}
                title={`${c.kind} · ${c.relation === "none" ? "unplaced" : c.relation}`}
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
                style={{
                  color,
                  borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
                  backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                }}
              >
                <span aria-hidden className="leading-none">
                  <NodeGlyph kind="community" size={11} />
                </span>
                <span className="max-w-[13rem] truncate">{c.title}</span>
              </li>
            ))}
          </ul>
          {rest > 0 && (
            <p className="mt-2 font-mono text-[10px] text-slate-500">
              +{rest} more
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* What the run cost, in dollars and wall-clock.
 *
 * v1's version of this panel was empty by design: its engine streamed the
 * numbers over a cost channel and wrote none of them into the manifest, so
 * there was nothing to read back and the panel said where the numbers were
 * rather than drawing a row of zeroes. The run's own ledger is persisted here
 * (lib/runs.ts writes the whole `SweepResult`), so the panel reports it. */
function RunTelemetry({
  usd,
  seconds,
  queries,
  hosts,
  grounding,
}: {
  usd?: number;
  seconds?: number;
  queries?: number;
  hosts?: number;
  /** report.kernel.groundingMean (sweep runs). A drift meter, not a defect
   *  rate — the tooltip carries the honest gloss so the number cannot read
   *  as "68% true". */
  grounding?: number;
}) {
  const items = [
    usd !== undefined ? { label: "spent", value: `$${usd.toFixed(4)}` } : null,
    seconds !== undefined
      ? { label: "wall clock", value: `${Math.round(seconds)}s` }
      : null,
    queries !== undefined ? { label: "queries bought", value: String(queries) } : null,
    hosts !== undefined ? { label: "hosts returned", value: String(hosts) } : null,
    grounding !== undefined
      ? {
          label: "descriptions grounded",
          value: `${grounding.toFixed(2)} mean`,
          title: GROUNDING_MEAN_BLURB,
        }
      : null,
  ].filter((x): x is { label: string; value: string; title?: string } => x !== null);

  if (items.length === 0) return null;

  return (
    <Card className="reveal reveal-2">
      <PanelHead
        title="Run telemetry"
        right={
          <Link
            href="/runs"
            className="font-mono text-[10px] lowercase tracking-wide text-sky-300 hover:text-sky-200"
          >
            the full bill →
          </Link>
        }
      />
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        {items.map((it) => (
          <div key={it.label} title={it.title}>
            <div className="tnum text-lg font-semibold leading-none text-slate-100">
              {it.value}
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {it.label}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* The run's own instrument, read back. A swarm run serializes its scorecard
   at the ending (report.scorecard, T6): the planned-question rows, the
   evidence fractions with num/den beside every value, the unspent pool, and
   the finish gate's record. Until now all of it stopped at the JSON — this
   card is where the night's grading becomes visible.

   Two display rules, enforced in lib/scorecard-view.ts where they are tested:
   every fraction shows its own arithmetic ("2 of 3 · 0.67", never a bare
   percent), and the gate's exchange renders the objection sentences verbatim —
   they are fact-sentences written to be read, and paraphrase would be the
   harness editorializing over its own instrument. */
function CoveragePanel({ scorecard }: { scorecard: KbScorecard }) {
  const rows = [
    {
      key: "families",
      label: "families answered with page evidence",
      of: nOfM(scorecard.familiesWithPageTier),
      value: share(scorecard.familiesWithPageTier),
    },
    {
      key: "pageTier",
      label: "nodes on page-or-better evidence",
      of: nOfM(scorecard.pageTier),
      value: share(scorecard.pageTier),
    },
    {
      key: "singleSourced",
      label: "nodes resting on a single source",
      of: nOfM(scorecard.singleSourced),
      value: share(scorecard.singleSourced),
    },
    {
      key: "poolUnspent",
      label: "budget left unspent",
      of: usdOfUsd(scorecard.poolUnspent),
      value: share(scorecard.poolUnspent),
    },
  ];
  const exchange = gateExchange(scorecard.gate);
  const refused = scorecard.gate.refusedFinish;

  return (
    <Card className="reveal reveal-2">
      <PanelHead
        title="Coverage"
        right={
          <span className="font-mono text-[10px] lowercase tracking-wide text-slate-600">
            the run grading itself
          </span>
        }
      />
      <dl className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-3">
            <dt className="text-[11px] text-slate-400">{r.label}</dt>
            <dd className="tnum shrink-0 font-mono text-[11px] text-slate-300">
              {r.of} <span className="text-slate-600">·</span>{" "}
              <span className="text-slate-100">{r.value}</span>
            </dd>
          </div>
        ))}
      </dl>

      {scorecard.families.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            planned questions
          </div>
          <ul className="space-y-1">
            {scorecard.families.map((f, i) => (
              <li
                key={`${f.lens}-${i}`}
                className="flex items-baseline justify-between gap-3 text-[11px]"
              >
                <span className="min-w-0 truncate text-slate-400">
                  <span className="font-mono">{f.lens}</span>
                  {f.status !== "landed" && (
                    <span className="text-slate-500">
                      {" "}
                      · {f.status}
                      {f.because ? ` — ${f.because}` : ""}
                    </span>
                  )}
                </span>
                {/* A family whose answer never reached page-tier evidence is
                    the gap the scorecard exists to name, so it wears the
                    advisory amber the rest of the app uses for "the run did
                    not answer this". */}
                <span
                  className={`tnum shrink-0 font-mono text-[10px] ${
                    f.pageTierNodes === 0 ? "text-amber-300" : "text-slate-500"
                  }`}
                >
                  {f.pageTierNodes} of {f.nodesAdded} on page evidence
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 border-t border-slate-800 pt-3">
        {exchange.spoke ? (
          /* The exchange, in the gate's own bytes. Amber stays inside the
             theme-re-keyed 200-500 steps, the same rule as NoteView's
             downgrade box. */
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-amber-400">
              the gate refused the finish
              {scorecard.gate.refusals > 1 ? ` × ${scorecard.gate.refusals}` : ""}
            </div>
            <ul className="space-y-1 text-sm text-amber-300">
              {exchange.lines.map((l, i) => (
                <li key={i}>
                  {l.text}
                  {l.carried && (
                    <span
                      className="ml-1.5 font-mono text-[10px] text-amber-400/80"
                      title="Still standing at the run's end — the accepted finish's unresolved list omitted it."
                    >
                      still standing
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {refused?.summary && (
              <p className="mt-2 border-t border-amber-500/20 pt-2 text-[11px] text-amber-300/80">
                the refused finish would have said: “{refused.summary}”
              </p>
            )}
          </div>
        ) : (
          <p className="font-mono text-[10px] text-slate-500">
            the finish gate never refused.
          </p>
        )}
      </div>
    </Card>
  );
}

/* Skeleton mirroring the dashboard shape, no spinners. */
function OverviewSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
        <div className="mb-3 h-3 w-28 rounded bg-slate-800/70" />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-800 bg-slate-800/70 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[64px] bg-slate-900" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-52 rounded-lg border border-slate-800 bg-slate-900/30" />
        <div className="h-52 rounded-lg border border-slate-800 bg-slate-900/30" />
      </div>
    </div>
  );
}

export function KbOverview({
  slug,
  onOpenGraph,
}: {
  slug: string;
  /** Optional: switch the parent to the Graph tab. When absent, the dashboard
   *  clicks the sibling Graph tab as a progressive enhancement. */
  onOpenGraph?: () => void;
}) {
  const [envelope, setEnvelope] = useState<KbView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // No reset block here on purpose. Upstream cleared the states at the top of
    // this effect so a slug change could not show the previous KB's dashboard;
    // a synchronous setState in an effect body is a cascading render
    // (react-hooks/set-state-in-effect) and this repo's lint rejects it. The
    // parent keys this component by slug instead, the same idiom NotesTab
    // already uses for NoteView, so a new slug is a fresh mount with
    // loading=true and there is nothing stale left to clear.
    let cancelled = false;

    fetch(`/api/kb/${slug}`)
      .then(async (r) => {
        const data = (await r.json()) as KbView & { error?: string };
        if (cancelled) return;
        if (!r.ok) setError(data.error || `request failed (${r.status})`);
        else setEnvelope(data);
      })
      .catch(() => {
        if (!cancelled) setError("could not reach the kb endpoint");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const goToGraph = () => {
    if (onOpenGraph) return onOpenGraph();
    try {
      for (const b of Array.from(document.querySelectorAll("button"))) {
        if (b.textContent?.trim() === "Graph") {
          b.click();
          return;
        }
      }
    } catch {
      /* progressive enhancement only */
    }
  };

  if (loading) return <OverviewSkeleton />;
  if (error || !envelope)
    return (
      <Card>
        <p className="font-mono text-[11px] text-slate-500">
          overview unavailable{error ? `: ${error}` : ""}
        </p>
      </Card>
    );

  const { manifest, notes, counts, relations } = envelope;
  const entities = notes.filter((n) => n.relation !== "anchor");
  const totalTyped = TYPE_ORDER.reduce((n, t) => n + counts[t], 0);
  const place = meanRelevance(entities);
  const totalNotes = manifestNum(manifest, "notes") ?? notes.length;
  const unplaced = relations.none ?? 0;
  const brand = manifestStr(manifest, "brand", "input") ?? slug;
  const built = builtAtOf(manifest);
  const profile = entities
    .map((n) => n.relevance)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);

  const communities = entities
    .filter((n) => n.type === "community")
    .sort((a, b) => b.relevance - a.relevance);
  const players = entities.filter((n) => n.type === "player");

  const linkCls =
    "inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-mono text-[11px] text-sky-300 transition hover:border-sky-400 hover:bg-sky-500/15 hover:text-sky-200";

  return (
    <div className="space-y-4" aria-label="knowledge base intelligence dashboard">
      {/* Header: holdings + provenance, with the graph control. */}
      <section
        className="prov-rail rounded-lg border border-slate-800 bg-slate-900/30 p-4"
        style={
          {
            "--rel": pct(entities.length - unplaced, Math.max(1, entities.length)),
          } as React.CSSProperties
        }
        title={`${entities.length - unplaced} of ${entities.length} entities carry a relation to the anchor`}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.2em]"
              style={{ color: "var(--highlight, #EB368C)" }}
            >
              intelligence
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold leading-none text-slate-100">
                {totalNotes}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                entities held
              </span>
            </div>
            <div className="tnum mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
              <span>{brand}</span>
              <span className="text-slate-700">·</span>
              <span>
                {counts.player} players · {counts.community} venues
              </span>
              {built && (
                <>
                  <span className="text-slate-700">·</span>
                  <span title={built}>built {timeAgo(built)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href={`/runs/${slug}`} className={linkCls}>
              <NodeGlyph kind="signal" size={13} />
              Run report
              <span aria-hidden>↗</span>
            </Link>
            <button type="button" onClick={goToGraph} className={linkCls}>
              <NodeGlyph kind="community" size={13} />
              Graph
              <span aria-hidden>↗</span>
            </button>
          </div>
        </div>
      </section>

      {/* KPI row: the four holdings, machined seams. */}
      <div className="reveal grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-800 bg-slate-800/70 sm:grid-cols-4">
        <StatTile
          glyph={typeGlyph("core", 18)}
          label="entities"
          value={totalNotes}
          hint={`mean place ${place}`}
        />
        <StatTile
          glyph={typeGlyph("player", 18)}
          label="players"
          value={counts.player}
          hint={`${pct(counts.player, totalTyped)}% of the map`}
        />
        <StatTile
          glyph={typeGlyph("community", 18)}
          label="venues"
          value={counts.community}
          hint={`${pct(counts.community, totalTyped)}% of the map`}
        />
        {/* v1's fourth tile counted notes that failed a quality check. There is
            no such check here, so the tile carries the number that IS measured
            and that a reader most needs: how much of the map the classifier
            would not place. */}
        <StatTile
          glyph={
            <span className={unplaced > 0 ? "text-amber-400" : "text-slate-600"}>
              <NodeGlyph kind="alert" size={18} />
            </span>
          }
          label="unplaced"
          value={unplaced}
          tone={unplaced > 0 ? "text-amber-300" : "text-slate-100"}
          hint={
            unplaced > 0
              ? "seen, but placed against nothing"
              : "everything carries a relation"
          }
        />
      </div>

      <RunTelemetry
        usd={manifestNum(manifest, "usd")}
        seconds={manifestNum(manifest, "seconds")}
        queries={manifestNum(manifest, "queries")}
        hosts={manifestNum(manifest, "hosts")}
        grounding={manifestNum(manifest, "groundingMean")}
      />

      {/* Swarm runs only: the scorecard the run serialized at its ending.
          Absent on sweep runs and on runs recorded before it existed —
          absence means "never measured", so no card rather than an empty one. */}
      {envelope.scorecard && <CoveragePanel scorecard={envelope.scorecard} />}

      {/* Composition + placement. */}
      <div className="grid gap-4 md:grid-cols-2">
        <CompositionPanel counts={counts} total={totalTyped} />
        <PlacementPanel
          placement={place}
          placed={entities.length - unplaced}
          total={entities.length}
          profile={profile}
        />
      </div>

      {/* Ecosystem + venues. */}
      <div className="grid gap-4 md:grid-cols-2">
        <EcosystemPanel relations={relations} players={players} />
        <CommunitiesPanel communities={communities} />
      </div>
    </div>
  );
}
