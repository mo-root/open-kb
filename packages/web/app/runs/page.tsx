import Link from "next/link";
import { listStoredRuns } from "@/lib/runs";
import { summaryOf } from "@/lib/kb-from-run";
import { formatDuration, formatUsd, readRunCost } from "@/components/build/types";
import { StatTile } from "@/components/viz";

/**
 * The maps this deployment has bought.
 *
 * THE GAP this fills. `HeaderNav` carries a "Runs" item, and for a while there
 * was no page behind it, a 404 in our own navigation, which is exactly the
 * dangling-link class this project refuses to ship inside a knowledge base.
 *
 * port NOTE. v1 built this page from the KB manifests on disk, which meant one
 * row per knowledge base, its last build, and a long apology for the history
 * it could not show ("a run whose notes were overwritten by a later run of the
 * same subject is not recoverable from what we store"). That apology does not
 * apply here: a run is keyed by its own id and never overwrites another, so
 * every run this deployment finished is a row, including two runs of the same
 * domain an hour apart.
 */
export const dynamic = "force-dynamic";

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2.5 align-middle">{children}</td>;
}

export default async function RunsPage() {
  const runs = await listStoredRuns().catch(() => []);
  const rows = runs.map((run) => ({ run, kb: summaryOf(run) }));

  const totalUsd = rows.reduce((n, r) => n + (r.run.result.stats.usd || 0), 0);
  const totalEntities = rows.reduce((n, r) => n + r.kb.notes, 0);
  const totalUnplaced = rows.reduce((n, r) => n + r.kb.unplaced, 0);

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Runs
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Every sweep this deployment finished, read from the JSON each one wrote
          when it returned — no live stream, no platform retention.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-400">
          No runs yet. Start one from the{" "}
          <Link href="/" className="text-sky-400 hover:text-sky-300">
            Map
          </Link>{" "}
          page.
        </p>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-4">
            <StatTile label="Runs" value={String(rows.length)} />
            <StatTile label="Entities mapped" value={String(totalEntities)} />
            <StatTile label="Spent" value={formatUsd(totalUsd)} />
            <StatTile
              label="Unplaced"
              value={String(totalUnplaced)}
              tone={totalUnplaced > 0 ? "text-amber-400" : undefined}
              hint="seen, placed against nothing"
            />
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-left font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
                  <th className="px-3 py-2.5 font-medium">Domain</th>
                  <th className="px-3 py-2.5 font-medium">Finished</th>
                  <th className="px-3 py-2.5 font-medium">Entities</th>
                  <th className="px-3 py-2.5 font-medium">Players</th>
                  <th className="px-3 py-2.5 font-medium">Unplaced</th>
                  <th className="px-3 py-2.5 font-medium">Queries</th>
                  <th className="px-3 py-2.5 font-medium">Hosts</th>
                  <th className="px-3 py-2.5 font-medium">Took</th>
                  <th className="px-3 py-2.5 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {rows.map(({ run, kb }) => {
                  const s = run.result.stats;
                  const built = run.endedAt
                    ? new Date(run.endedAt).toISOString().slice(0, 16).replace("T", " ")
                    : "—";
                  // The run's own itemised bill, when it carried one. Runs
                  // recorded before `report.cost` existed did not, and a dash is
                  // the honest answer for those.
                  const cost = readRunCost(
                    (run.result.report as Record<string, unknown> | undefined)?.cost,
                  );
                  return (
                    <tr
                      key={run.id}
                      className="border-b border-slate-800/70 last:border-0"
                    >
                      <Cell>
                        {/* To the REPORT, not straight into the map: this page
                            is about runs, and the run is what the reader
                            clicked a row of. */}
                        <Link
                          href={`/runs/${run.id}`}
                          className="font-medium text-sky-400 hover:text-sky-300"
                        >
                          {run.domain}
                        </Link>
                        <Link
                          href={`/kb/${run.id}`}
                          className="ml-2 font-mono text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300"
                        >
                          kb →
                        </Link>
                      </Cell>
                      <Cell>
                        <span className="font-mono text-xs text-slate-400">
                          {built}
                        </span>
                      </Cell>
                      <Cell>{kb.notes}</Cell>
                      <Cell>{kb.counts.player}</Cell>
                      <Cell>
                        <span
                          className={
                            kb.unplaced > 0
                              ? "tnum text-amber-400"
                              : "tnum text-slate-400"
                          }
                        >
                          {kb.unplaced}
                        </span>
                        {kb.noise > 0 && (
                          <span
                            className="ml-1.5 font-mono text-xs text-slate-600"
                            title="hosts discarded as noise — no node on the map"
                          >
                            +{kb.noise} noise
                          </span>
                        )}
                      </Cell>
                      <Cell>{s.queries}</Cell>
                      <Cell>{s.hosts}</Cell>
                      <Cell>
                        <span className="font-mono text-xs text-slate-400">
                          {cost
                            ? formatDuration(cost.elapsedMs)
                            : formatDuration(s.seconds * 1000)}
                        </span>
                      </Cell>
                      <Cell>
                        <span className="font-mono text-xs">{formatUsd(s.usd)}</span>
                      </Cell>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-slate-500">
            One row per run, keyed by the run&apos;s own id — two sweeps of the
            same domain are two rows, not one overwriting the other. The unplaced
            column is the count of entities the classifier put on the map and
            would not connect to the anchor; it is a column rather than a
            footnote because it is often a large share of what a run returns.
          </p>
        </>
      )}
    </main>
  );
}
