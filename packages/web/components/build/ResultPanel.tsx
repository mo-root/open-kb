import { BarMeter, Donut } from "@/components/viz";
import { CostBreakdown } from "./CostBreakdown";
import { formatDuration, formatUsd, readRunCost } from "./types";

/* How a run ends. Ported from v1's ResultPanel, same badge-and-stat-grid
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
  /** Every search fired: the opening hand plus every widening round. Distinct
   *  from `opening`, which is the plan size before the run saw anything —
   *  reading the two as the same number understates what a run actually
   *  bought (63 opening vs 123 fired, measured). */
  queries?: number;
  /** The opening hand's size, before the run looked at what came back and
   *  decided whether to widen. */
  opening?: number;
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
   are a magnitude, not an identity.
 *
 * Hand-copied from `JUDGED_KINDS` (`@open-kb/core`), which has SEVEN members —
 * this used to list five. `noise` is rightly absent: `onMap()`
 * (packages/sweep/src/sweep.ts) filters `kind === "noise"` out of `keep`
 * before a report's `kinds` tally is built, so it can never reach this donut.
 * `unknown` is not filtered — `onMap`'s own doc comment says so ("NOT unknown
 * ... stays", a host the judge found but could not place) — and every kept
 * `unknown` fell through to the `?? "#7C8BA8"` fallback below, the exact
 * colour already spoken for by `directory`, so an unplaced host was
 * indistinguishable from a directory listing in the one chart meant to tell
 * a reader what kind of thing came back. Exported, and pinned by
 * ResultPanel.test.ts against the real union, the same fix as SELF-105's
 * `FAMILY_TONE` and B3's `RELATION_ORDER` — same shape of gap, a closed union
 * absorbed by a fallback instead of erroring. */
export const KIND_COLOR: Record<string, string> = {
  company: "var(--type-player, #EB368C)",
  product: "var(--type-product, #3D7FFC)",
  community: "var(--type-community, #D95926)",
  publisher: "var(--type-core, #9DB2D6)",
  directory: "#7C8BA8",
  unknown: "#64748B",
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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="on the map" value={r.kept ?? 0} />
        <Stat label="hosts seen" value={r.hosts ?? 0} />
        <Stat label="judged noise" value={r.noise ?? 0} />
        {/* Two counts, not one: "queries" is everything fired, opening hand
            plus every widening round; "opening" is the plan size before the
            run saw a single result. The two used to share one number and one
            label. */}
        <Stat label="queries asked" value={r.queries ?? 0} />
        <Stat label="opening hand" value={r.opening ?? 0} />
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
  stopped = false,
}: {
  result: RunResult | null;
  errorText: string | null;
  /** The reader pressed Stop. A different ending from a crash, and the surface
   *  was calling both "failed". */
  stopped?: boolean;
}) {
  /* THREE endings, not two.
     Pressing Stop makes the run emit `{kind:"error", message:"Stopped.
     Everything found before you stopped it is kept."}` (`failRun`, lib/runs.ts) —
     and this panel put that sentence inside a rose card headed "failed / the
     run did not finish". So the one place the product tells you your money
     bought something contradicted itself in the same box: the badge said the
     work was lost, the text said it was kept. A deliberate stop is an outcome,
     not a fault, and it wears the neutral chrome. */
  if (stopped && !result) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-slate-700/60 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-300">
            stopped
          </span>
          <span className="text-sm text-slate-300">
            you stopped the run — everything it had already found is kept
          </span>
        </div>
        <p className="text-xs text-slate-500">
          The map is written from what the sweep had paid for by then. Start
          again to go deeper; nothing you spent here is lost.
        </p>
      </div>
    );
  }

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
  // failure colour, but it must be unmistakable, because an empty map with a
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
