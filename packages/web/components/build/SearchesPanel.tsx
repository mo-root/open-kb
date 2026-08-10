"use client";

import { useMemo, useState } from "react";
import { FAMILY_TONE } from "@/lib/viewTypes";

/**
 * Every question the run asked, why it asked it, and what came back.
 *
 * The rest of the build view reports aggregates, "580 results, 88 hosts", and an
 * aggregate is not something a reader can check. Everything downstream is derived
 * from these rows: the hosts, the classifications, the map. This is the raw
 * material, so it is the one panel that makes the run auditable rather than
 * merely watchable.
 *
 * Collapsed by default and opened one query at a time: eighty queries times a
 * dozen results is a wall, and a wall is read as decoration.
 */

export interface SearchHitView {
  url: string;
  title: string;
  description: string;
}

export interface SearchView {
  query: string;
  intent: string;
  platform: string;
  /** The model's stated reason for asking, written before any result existed. */
  why: string;
  /** Which of the plain/debranded/branded families this query belongs to.
   *  Optional: a run recorded before families existed carries no frame with
   *  one, and that is a real run, not a malformed one. */
  family?: string;
  ok: boolean;
  error?: string;
  ms: number;
  usd: number;
  hits: SearchHitView[];
}

/** Reads a `searched` frame off the results stream. Returns null on anything else,
 *  in the same defensive style as the other readers, an unrecognised frame is
 *  dropped, never rendered as an empty search that looks like a failed one. */
export function readSearched(v: unknown): SearchView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== "searched" || typeof o.query !== "string") return null;
  const hits = Array.isArray(o.hits)
    ? o.hits.flatMap((h) => {
        if (!h || typeof h !== "object") return [];
        const r = h as Record<string, unknown>;
        return typeof r.url === "string"
          ? [{ url: r.url, title: String(r.title ?? ""), description: String(r.description ?? "") }]
          : [];
      })
    : [];
  return {
    query: o.query,
    intent: String(o.intent ?? ""),
    platform: String(o.platform ?? ""),
    why: String(o.why ?? ""),
    family: typeof o.family === "string" && o.family ? o.family : undefined,
    ok: o.ok !== false,
    error: typeof o.error === "string" ? o.error : undefined,
    ms: Number(o.ms) || 0,
    usd: Number.isFinite(Number(o.usd)) ? Number(o.usd) : 0,
    hits,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function SearchesPanel({ searches }: { searches: SearchView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [onlyEmpty, setOnlyEmpty] = useState(false);

  const shown = useMemo(
    () => (onlyEmpty ? searches.filter((s) => !s.ok || s.hits.length === 0) : searches),
    [searches, onlyEmpty],
  );

  const totalHits = searches.reduce((n, s) => n + s.hits.length, 0);
  const barren = searches.filter((s) => s.ok && s.hits.length === 0).length;
  const failed = searches.filter((s) => !s.ok).length;

  if (searches.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/40">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
            searches
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-slate-500">
            {searches.length} asked · {totalHits} results
          </span>
        </div>
        <div className="flex items-center gap-3">
          {(barren > 0 || failed > 0) && (
            <span className="font-mono text-[11px] tabular-nums text-amber-500/80">
              {failed > 0 && `${failed} failed`}
              {failed > 0 && barren > 0 && " · "}
              {barren > 0 && `${barren} returned nothing`}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOnlyEmpty((v) => !v)}
            aria-pressed={onlyEmpty}
            className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              onlyEmpty
                ? "border-amber-600/60 text-amber-400"
                : "border-slate-700 text-slate-500 hover:text-slate-300"
            }`}
          >
            only the empty
          </button>
        </div>
      </header>

      <ol className="divide-y divide-slate-900">
        {shown.map((s, i) => {
          const id = `${s.query}-${i}`;
          const isOpen = open === id;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : id)}
                aria-expanded={isOpen}
                className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left hover:bg-slate-900/40"
              >
                {s.family && (
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${
                      FAMILY_TONE[s.family] ?? "text-slate-400 border-slate-600/40 bg-slate-700/20"
                    }`}
                    title={`asked as a ${s.family} query`}
                  >
                    {s.family}
                  </span>
                )}
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">
                  {s.intent}
                </span>
                <span className="flex-1 font-mono text-[12.5px] text-slate-300">{s.query}</span>
                <span
                  className={`font-mono text-[11px] tabular-nums ${
                    !s.ok ? "text-rose-400" : s.hits.length === 0 ? "text-amber-500" : "text-slate-500"
                  }`}
                >
                  {s.ok ? `${s.hits.length}` : "failed"}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-slate-600">
                  {(s.ms / 1000).toFixed(1)}s
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-slate-900 bg-slate-950/60 px-4 py-3">
                  {s.why && (
                    <p className="mb-3 max-w-[70ch] text-[13px] text-slate-400">
                      <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
                        why it asked
                      </span>
                      {s.why}
                    </p>
                  )}
                  {s.error && (
                    <p className="mb-3 font-mono text-[12px] text-rose-400">{s.error}</p>
                  )}
                  {s.hits.length === 0 ? (
                    <p className="text-[13px] italic text-slate-500">
                      Nothing came back. That is a fact about this market, not a broken query —
                      absence is worth reading.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2.5">
                      {s.hits.map((h, j) => (
                        <li key={`${h.url}-${j}`} className="flex flex-col gap-0.5">
                          <a
                            href={h.url}
                            target="_blank"
                            rel="noopener"
                            className="font-mono text-[11px] text-cyan-500/80 hover:text-cyan-400"
                          >
                            {hostOf(h.url)}
                          </a>
                          <span className="text-[13px] text-slate-300">{h.title}</span>
                          {h.description && (
                            <span className="text-[12.5px] text-slate-500">{h.description}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
