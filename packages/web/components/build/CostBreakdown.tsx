import { formatDuration, formatUsd, shareOf, type CostLineView, type RunCostView } from "./types";

/**
 * what THE RUN cost, AT THE END OF IT.
 *
 * The run used to finish with one number. "$1.30" answers "how much" and none of
 * the questions anyone asks next, was that the searches or the models, which
 * stage spent it, and what a single entity on the map ended up costing. Those
 * have different remedies: a bill that is mostly search is fixed by planning
 * fewer queries, a bill that is mostly one agent is fixed by changing that
 * agent's model, and neither is visible from a total.
 *
 * Three bands, in the order the questions get asked:
 *
 *   the headline    total · ceiling · duration · calls · tokens
 *   where it went   by tool kind, then by agent, each with its share of the bill
 * v1 carried a third band, the project ledger, because its runs were gated on
 * a project budget. Nothing here refuses a run, so there is no ledger to show.
 */

const KIND_LABEL: Record<string, string> = {
  serp: "search",
  unlocker: "unlocked page fetches",
  fetch: "direct page fetches",
  llm: "models",
};

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-slate-800">
      <div className={`h-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}

function Lines({
  title,
  rows,
  total,
  tone,
  max,
}: {
  title: string;
  rows: CostLineView[];
  total: number;
  tone: string;
  max: number;
}) {
  if (!rows.length) return null;
  const shown = rows.slice(0, max);
  const rest = rows.slice(max);
  const restUsd = rest.reduce((n, r) => n + r.usd, 0);
  const restCalls = rest.reduce((n, r) => n + r.calls, 0);
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        {title}
      </div>
      <ul className="space-y-2">
        {shown.map((r) => (
          <li key={r.label}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-slate-300">{KIND_LABEL[r.label] ?? r.label}</span>
              <span className="tnum shrink-0 text-slate-400">
                <span className="text-slate-200">{formatUsd(r.usd)}</span>
                <span className="ml-2 text-slate-500">{shareOf(r.usd, total)}%</span>
              </span>
            </div>
            <div className="mt-1">
              <Bar pct={shareOf(r.usd, total)} tone={tone} />
            </div>
            <div className="tnum mt-1 text-[10px] text-slate-500">
              {r.calls} call{r.calls === 1 ? "" : "s"}
              {/* A failed call is still a paid call on some of these paths, and a
                  sweep that half-failed looks identical to a healthy one from the
                  total alone. */}
              {r.failures > 0 && <span className="text-amber-400/80"> · {r.failures} failed</span>}
              {r.ms > 0 && <span> · {formatDuration(r.ms)} of tool time</span>}
            </div>
          </li>
        ))}
      </ul>
      {/* Never a silent cap: the tail is folded into a line that keeps the
          column summing to the total rather than quietly dropped. */}
      {rest.length > 0 && (
        <div className="tnum mt-2 text-[10px] text-slate-500">
          + {rest.length} more · {formatUsd(restUsd)} · {restCalls} calls
        </div>
      )}
    </div>
  );
}

function Head({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="tnum text-base font-semibold text-slate-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

export function CostBreakdown({
  cost,
  units,
  unitLabel = "entity",
}: {
  cost: RunCostView | null;
  /** What the run produced, for the unit cost. The one figure that compares two
   *  runs of different sizes: a run that cost twice as much for three times the
   *  map was cheaper, and the totals alone say the opposite. */
  units?: number;
  unitLabel?: string;
}) {
  if (!cost) return null;

  const uncapped = cost.ceilingUsd === null || cost.ceilingUsd === 0;

  return (
    <div className="mt-4 rounded-md border border-slate-800 bg-slate-950/40 p-4">
      <div className="mb-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        what it cost
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Head
          label="this run"
          value={formatUsd(cost.usd)}
          hint={uncapped ? "no ceiling" : `of ${formatUsd(cost.ceilingUsd ?? 0)} ceiling`}
        />
        <Head label="took" value={formatDuration(cost.elapsedMs)} />
        <Head label="tool calls" value={String(cost.calls)} />
        <Head label="tokens" value={cost.tokens.toLocaleString()} />
        <Head
          label={`per ${unitLabel}`}
          value={units && units > 0 ? formatUsd(cost.usd / units) : "—"}
          hint={units && units > 0 ? `${units} on the map` : undefined}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Lines title="by tool" rows={cost.byKind} total={cost.usd} tone="bg-sky-400" max={6} />
        <Lines title="by stage" rows={cost.byAgent} total={cost.usd} tone="bg-violet-400" max={8} />
      </div>

      {cost.partial && (
        <p className="mt-3 text-[10px] text-amber-400/80">
          The lines above cover part of the spend. The total is still exact.
        </p>
      )}

    </div>
  );
}
