import Link from "next/link";
import { notFound } from "next/navigation";
import { getStoredRun } from "@/lib/runs";
import { summaryOf } from "@/lib/kb-from-run";
import { CostBreakdown } from "@/components/build/CostBreakdown";
import { formatDuration, formatUsd, readRunCost } from "@/components/build/types";
import { StatTile } from "@/components/viz";

/**
 * THE whole RUN, ON ONE page, after THE fact.
 *
 * Everything a run knows about itself used to live on the live stream and die
 * with the browser tab: close the page and there was nothing left. "What did
 * that map cost, and where did the time go?" had no answer an hour later.
 *
 * It is read from the JSON the run wrote when it returned (lib/runs.ts), so this
 * page needs no run to be alive, no stream to be connected and no platform
 * retention. That JSON carries the full itemised bill (`report.cost.byKind`,
 * `byAgent`), which is what makes the breakdown here identical to the one the
 * live view shows at the end.
 */
export const dynamic = "force-dynamic";

function Row({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/70 py-2 last:border-0">
      <span className="text-sm text-slate-400">
        {label}
        {hint && <span className="ml-2 text-xs text-slate-600">{hint}</span>}
      </span>
      <span className={`tnum font-mono text-sm ${tone ?? "text-slate-200"}`}>
        {value}
      </span>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/30 p-5">
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function RunReport({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getStoredRun(id);
  if (!run) notFound();

  const kb = summaryOf(run);
  const r = run.result;
  const s = r.stats;
  const cost = readRunCost((r.report as Record<string, unknown> | undefined)?.cost);
  const finishedAt = run.endedAt
    ? new Date(run.endedAt).toISOString().slice(0, 16).replace("T", " ")
    : "";
  const placed = s.kept - kb.unplaced;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <nav className="mb-4 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        <Link href="/runs" className="hover:text-sky-400">
          Runs
        </Link>
        <span className="mx-2 text-slate-700">/</span>
        <span className="text-slate-400">{run.domain}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
            {run.domain}
          </h1>
          <p className="mt-1 font-mono text-xs text-slate-500">
            run {run.id.slice(0, 8)}
            {finishedAt && <> · finished {finishedAt}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* The ending, said plainly. "complete" here means the sweep ran to
              the end and settled its bill — it is never dressed as a verdict on
              the map's quality, which nothing in this engine measures. */}
          <span
            className={`rounded px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide ${
              kb.unplaced > 0
                ? "bg-amber-500/15 text-amber-300"
                : "bg-sky-500/15 text-sky-300"
            }`}
          >
            {kb.unplaced > 0 ? `complete · ${kb.unplaced} unplaced` : "complete"}
          </span>
          <Link
            href={`/kb/${run.id}`}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-400"
          >
            Open map →
          </Link>
        </div>
      </header>

      {/* ------------------------------------------------------- headline -- */}
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="cost"
          value={formatUsd(s.usd)}
          hint={cost?.ceilingUsd == null ? "no ceiling" : `of ${formatUsd(cost.ceilingUsd)}`}
        />
        <StatTile
          label="took"
          value={formatDuration(s.seconds * 1000)}
          hint={cost ? `${cost.calls} calls` : undefined}
        />
        <StatTile
          label="on the map"
          value={String(s.kept)}
          hint={`${kb.unplaced} unplaced`}
        />
        <StatTile
          label="queries"
          value={String(s.queries)}
          hint="searches bought"
        />
        <StatTile
          label="per entity"
          value={s.kept > 0 ? formatUsd(s.usd / s.kept) : "—"}
          hint="unit cost"
        />
      </div>

      {/* ----------------------------------------------------------- bill -- */}
      {cost ? (
        <div className="mb-6 rounded-lg border border-slate-800 bg-slate-900/30 px-5 pb-5">
          <CostBreakdown cost={cost} units={s.kept} />
        </div>
      ) : (
        <p className="mb-6 rounded-lg border border-slate-800 bg-slate-900/30 p-5 text-sm text-slate-400">
          This run predates the itemised bill, so only its total was recorded:{" "}
          <span className="font-mono text-slate-200">{formatUsd(s.usd)}</span>.
          Re-run it to get the breakdown.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* --------------------------------------------------- what it found -- */}
        <Panel title="what it found">
          <Row label="Hosts returned" value={String(s.hosts)} hint="distinct domains" />
          <Row label="Search results" value={String(s.results)} />
          <Row label="On the map" value={String(s.kept)} />
          <Row
            label="Discarded as noise"
            value={String(kb.noise)}
            hint="judged unrelated to the market"
          />
          <Row
            label="Placed against the anchor"
            value={String(placed)}
            // Zero placements off a successful sweep is the signature of a
            // classifier that failed, not of an empty market. Flagged rather
            // than rendered as an ordinary count.
            tone={placed === 0 ? "text-rose-300" : undefined}
            hint={placed === 0 ? "none classified" : undefined}
          />
          <Row
            label="Seen, not placed"
            value={String(kb.unplaced)}
            tone={kb.unplaced > 0 ? "text-amber-300" : undefined}
            hint="no relation asserted"
          />
          <Row label="Players" value={String(kb.counts.player)} />
          <Row label="Venues" value={String(kb.counts.community)} />
          <Row label="Products" value={String(kb.counts.product)} />
        </Panel>

        {/* ------------------------------------------------------ how it ran -- */}
        <Panel title="how it ran">
          <Row
            label="What it read"
            value={r.decomposition.products.length ? "the company's own pages" : "—"}
            hint={`${r.decomposition.products.length} products named`}
          />
          <Row
            label="Coinages avoided"
            value={String(r.decomposition.coinages.length)}
            hint="words the catalog was forbidden to search"
          />
          <Row label="Queries planned" value={String(r.queries.length)} />
          {/* Result PAGES, not questions. The run bills `serpCalls += PAGES`
              per query, so this is several times the live console's "questions
              asked" — two true numbers that read as a contradiction while they
              shared the name "SERP calls". */}
          <Row label="SERP pages" value={String(s.serpCalls)} />
          <Row
            label="Unlocked fetches"
            value={String(s.unlockerCalls)}
            hint={s.unlockerCalls > 0 ? "the site refused an anonymous GET" : undefined}
          />
          <Row
            label="Tokens"
            value={`${s.tokIn.toLocaleString()} in / ${s.tokOut.toLocaleString()} out`}
          />
          <Row label="Requested" value={`${run.queries} queries`} />
        </Panel>
      </div>

      {/* --------------------------------------------------------- reading -- */}
      <section className="mt-4 rounded-lg border border-slate-800 bg-slate-900/30 p-5">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          what it understood before it searched
        </h2>
        <p className="text-sm leading-relaxed text-slate-300">
          {r.decomposition.sells}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            buyer
          </span>
          {r.decomposition.buyer}
        </p>
        {r.decomposition.coinages.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              never searched
            </span>
            {r.decomposition.coinages.map((c) => (
              <span
                key={c}
                className="rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
              >
                {c}
              </span>
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">
        Read from the JSON this run wrote when it returned, not from a live
        stream — so it survives the tab, the dev server and the process. One page
        per run, keyed by the run&apos;s own id: two sweeps of the same domain are
        two reports, and neither overwrites the other.
      </p>
    </main>
  );
}
