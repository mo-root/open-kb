import { BarMeter, Donut } from "@/components/viz";
import { CostBreakdown } from "./CostBreakdown";
import { formatDuration, formatUsd, readRunCost } from "./types";

/* How a run ends. Ported from v1's ResultPanel — same badge-and-stat-grid
   layout, same three endings — and re-keyed to this engine's outcome.

   v1's ending was a knowledge base: notes written, citations verified,
   violations. This engine's ending is a MAP: how many hosts came back, how many
   of them are actually players, and what kind. So the stat grid counts hosts and
   entities, and the two charts answer the question a total cannot — what KIND of
   thing is on this map, and how does each relate to the anchor.

   v1's "Open KB" and "Full report" links are gone: those pages belong to the
   KB-browsing surface, which is not part of this app. */

export interface RunResult {
  domain?: string;
  sells?: string;
  queries?: number;
  results?: number;
  hosts?: number;
  entities?: number;
  kept?: number;
  noise?: number;
  kinds?: Record<string, number>;
  relations?: Record<string, number>;
  usd?: number;
  seconds?: number;
  /** The itemised bill. Unknown-typed because it crosses the NDJSON stream —
   *  `readRunCost` is what turns it into something renderable, or into null. */
  cost?: unknown;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2">
      <div className="tnum text-lg font-semibold text-slate-100">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

/* Entity kinds share the node-type palette so a `company` reads the same colour
   here as it does everywhere else. Relations get the neutral blue ramp — they
   are a magnitude, not an identity. */
const KIND_COLOR: Record<string, string> = {
  company: "var(--type-player, #EB368C)",
  product: "var(--type-product, #3D7FFC)",
  community: "var(--type-community, #C4C1F8)",
  publisher: "var(--type-core, #9DB2D6)",
  directory: "#7C8BA8",
};

function Composition({ r }: { r: RunResult }) {
  const kinds = Object.entries(r.kinds ?? {}).sort((a, b) => b[1] - a[1]);
  const relations = Object.entries(r.relations ?? {})
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1] - a[1]);
  if (!kinds.length && !relations.length) return null;

  return (
    <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
      {kinds.length > 0 && (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            what kind of thing came back
          </div>
          <Donut
            segments={kinds.map(([label, value]) => ({
              label,
              value,
              color: KIND_COLOR[label] ?? "#7C8BA8",
            }))}
            size={132}
          />
        </div>
      )}
      {relations.length > 0 && (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            how each one stands to {r.domain ?? "the anchor"}
          </div>
          <BarMeter rows={relations.map(([label, value]) => ({ label, value }))} />
        </div>
      )}
    </div>
  );
}

function ResultStats({ r }: { r: RunResult }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="on the map" value={r.kept ?? 0} />
        <Stat label="hosts seen" value={r.hosts ?? 0} />
        <Stat label="judged noise" value={r.noise ?? 0} />
        <Stat label="queries" value={r.queries ?? 0} />
        <Stat label="took" value={formatDuration((r.seconds ?? 0) * 1000)} />
        <Stat label="spent" value={formatUsd(r.usd)} />
      </div>
      <Composition r={r} />
      {/* Shown on every ending: "what did that cost" is the question after a
          SUCCESSFUL run too, and it was the one v1's surface could never
          answer. */}
      <CostBreakdown cost={readRunCost(r.cost)} units={r.kept} unitLabel="entity" />
    </>
  );
}

export function ResultPanel({
  result,
  errorText,
}: {
  result: RunResult | null;
  errorText: string | null;
}) {
  if (errorText || !result) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.04] p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-rose-300">
            failed
          </span>
          <span className="text-sm text-slate-300">the run did not finish</span>
        </div>
        {errorText && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950/60 p-3 font-mono text-xs text-rose-200/90">
            {errorText}
          </pre>
        )}
      </div>
    );
  }

  // A run that came back with nothing is NOT a failure and must not wear the
  // failure colour — but it must be unmistakable, because an empty map with a
  // green badge reads as a quiet market rather than as a sweep that missed.
  if ((result.kept ?? 0) === 0) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-300">
            empty map
          </span>
          <span className="tnum text-sm text-slate-300">
            {result.hosts ?? 0} hosts came back and none survived classification
          </span>
        </div>
        <ResultStats r={result} />
        <p className="mt-3 text-[11px] text-slate-500">
          Either the catalog asked the wrong questions or the market genuinely
          has no other named players. The queries above are the thing to read.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/[0.04] p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-300">
          mapped
        </span>
        <span className="text-sm text-slate-300">
          {result.domain}
          {result.sells ? ` — ${result.sells}` : ""}
        </span>
      </div>
      <ResultStats r={result} />
    </div>
  );
}
