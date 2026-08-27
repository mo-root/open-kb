"use client";

import { useState } from "react";
import { KindChip } from "@/components/ui";
import { SiteIcon } from "@/components/SiteIcon";
import { formatUsd, type TraceView } from "./types";

/* Streamed findings, the run's actual discoveries, not just counters.

   Ported from v1's FindingsPanel (same tab strip, same sticky-header table) and
   re-fed from THIS engine's streams. v1's `notes` tab is gone: there are no
   notes here, the run produces a classified map. What replaces it is `map`,
   filled per classification batch while the run is still working.

   The `calls` tab is the one worth watching. Every row is a search that was
   paid for, and `argsDigest` on a SERP row IS the query text — the only place a
   reader can see which question their money just bought. */

export interface EntityData {
  domain: string;
  name?: string;
  /** company · product · community · publisher · directory · noise · unknown —
   *  `JUDGED_KINDS` (`@open-kb/core/judge`), SEVEN members. This comment used
   *  to list five, the same drift SELF-106/107 found and fixed in the real
   *  KIND maps (ui.tsx's `KIND_TONES`, ResultPanel.tsx's `KIND_COLOR`) —
   *  `noise` and `unknown` are live values on this stream too, `KindChip`
   *  (components/ui.tsx) already renders both. */
  kind?: string;
  /** competitor · substitute · adjacent · dependency · integration · shaper ·
   *  buyer · target · covers · lists · discusses · unknown · none —
   *  `JUDGED_RELATIONS` (`@open-kb/core/judge`), THIRTEEN members. This
   *  comment used to list nine, the same drift SELF-108 found and fixed in
   *  `KbOverview.tsx`'s `RELATION_ORDER`/`RELATION_COLOR` — the four missing
   *  values (`covers`/`lists`/`discusses`/`unknown`) reach this stream
   *  unfiltered and render as plain text below the `KindChip` (line 115). */
  relation?: string;
  what?: string;
  why?: string;
  /** How many distinct search results pointed at this host. */
  breadth?: number;
}

const TABS = ["calls", "map"] as const;
type Tab = (typeof TABS)[number];

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center px-4 text-center text-xs text-slate-500">
      {text}
    </div>
  );
}

function CallsTab({ calls }: { calls: TraceView[] }) {
  if (!calls.length)
    return <Empty text="every search and every page fetch appears here as it is bought…" />;
  // Newest first: a live reader is watching the head of the stream, not its tail.
  const rows = [...calls].reverse();
  return (
    <div className="max-h-80 overflow-y-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-slate-950/95 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="py-1.5 pr-3">stage</th>
            <th className="py-1.5 pr-3">what it asked</th>
            <th className="py-1.5 pr-3">ms</th>
            <th className="py-1.5">cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {rows.map((r) => (
            <tr key={`${r.seq}-${r.ts}`} className="align-top">
              <td className="whitespace-nowrap py-1.5 pr-3">
                <span className="font-mono text-[11px] text-slate-400">{r.agent}</span>
                <span className="ml-1.5 text-[10px] text-slate-600">{r.kind}</span>
              </td>
              <td className="py-1.5 pr-3">
                <span
                  className={`break-words font-mono text-[11px] ${
                    r.ok ? "text-slate-200" : "text-rose-300 line-through"
                  }`}
                >
                  {r.argsDigest || r.tool}
                </span>
              </td>
              <td className="tnum py-1.5 pr-3 text-[10px] text-slate-500">{r.ms || "—"}</td>
              <td className="tnum py-1.5 text-[10px] text-slate-500">{formatUsd(r.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MapTab({ entities }: { entities: EntityData[] }) {
  if (!entities.length)
    return <Empty text="the map fills as each batch of hosts is classified…" />;
  const max = Math.max(...entities.map((e) => e.breadth ?? 0), 1);
  return (
    <div className="max-h-80 overflow-y-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-slate-950/95 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="py-1.5 pr-3">host</th>
            <th className="py-1.5 pr-3">kind</th>
            <th className="py-1.5 pr-3">seen</th>
            <th className="py-1.5">why it is on the map</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {entities.map((e) => (
            <tr key={e.domain} className="align-top">
              <td className="py-1.5 pr-3">
                <div className="flex items-center gap-1.5">
                  <SiteIcon domain={e.domain} name={e.name} size={14} />
                  <span className="font-mono text-slate-200">{e.domain}</span>
                </div>
                {e.name && e.name !== e.domain && (
                  <div className="text-[10px] text-slate-500">{e.name}</div>
                )}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3">
                {e.kind && <KindChip kind={e.kind} />}
                {e.relation && e.relation !== "none" && (
                  <div className="mt-0.5 text-[10px] text-slate-500">{e.relation}</div>
                )}
              </td>
              <td className="py-1.5 pr-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-1 w-12 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full bg-sky-400"
                      style={{ width: `${((e.breadth ?? 0) / max) * 100}%` }}
                    />
                  </div>
                  <span className="tnum text-[10px] text-slate-500">{e.breadth ?? 0}</span>
                </div>
              </td>
              <td className="py-1.5">
                {e.why && <div className="text-[11px] leading-snug text-slate-400">{e.why}</div>}
                {e.what && <div className="text-[10px] leading-snug text-slate-500">{e.what}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FindingsPanel({
  calls,
  entities,
}: {
  calls: TraceView[];
  entities: EntityData[];
}) {
  const [tab, setTab] = useState<Tab>("calls");
  const counts: Record<Tab, number> = { calls: calls.length, map: entities.length };
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <div className="mb-3 flex items-center gap-1">
        <span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          findings
        </span>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-1 text-[11px] ${
              tab === t ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {t}
            {counts[t] > 0 && (
              <span className="tnum ml-1 text-[10px] text-sky-400/80">{counts[t]}</span>
            )}
          </button>
        ))}
      </div>
      {tab === "calls" ? <CallsTab calls={calls} /> : <MapTab entities={entities} />}
    </div>
  );
}
