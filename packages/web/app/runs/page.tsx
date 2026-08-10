import Link from "next/link";
import { faultNotice } from "@/lib/api-error";
import { isCompleted, listStoredRuns, type StoredRun } from "@/lib/runs";
import { summaryOf } from "@/lib/kb-from-run";
import { formatDuration, formatUsd, readRunCost } from "@/components/build/types";
import { StatTile } from "@/components/viz";
import { DEMO_REPO, isDemo } from "@/lib/demo";

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

/**
 * A run that ended without a map.
 *
 * Seven dashes and not seven zeroes. Every numeric column on this table is a
 * measurement the sweep took, and this run took none of them — it stopped, or
 * it was stopped, or it hit the ceiling. "0 hosts, $0.00" would read as a
 * market that was searched and found empty, which is a claim, and the wrong
 * one; an em dash is the absence of a number and says so.
 *
 * The domain still links to `/runs/<id>`, because the run report is exactly
 * what a reader wants here: it is the page that prints the failure's own
 * sentence. It does NOT link to `/kb/<id>` — there is no map behind that link,
 * and a dangling link inside a knowledge-base product is the one class this
 * project refuses to ship.
 */
function FailedRow({
  run,
  built,
}: {
  run: StoredRun;
  built: string;
}) {
  return (
    <tr className="border-b border-slate-800/70 transition-colors duration-100 last:border-0 hover:bg-slate-800/30">
      <Cell>
        <Link
          href={`/runs/${run.id}`}
          className="font-medium text-sky-400 hover:text-sky-300"
        >
          {run.domain}
        </Link>
        <span className="ml-2 rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-rose-300">
          {run.status}
        </span>
      </Cell>
      <Cell>
        <span className="font-mono text-xs text-slate-400">{built}</span>
      </Cell>
      {/* The seven measured columns, spanned rather than filled with seven
          dashes. A row of dashes says "nothing here" seven times and answers
          nothing; the span has room for the run's own sentence, which is the
          only thing this row has that the reader actually wants.

          `run.error` is safe to print. It is the bounded notice both sources
          hand over — `faultNotice`'s output in memory, the notice half of the
          `error` column out of Postgres — and never the provider's words. See
          "the sentence a page may speak for" in lib/api-error.ts. */}
      <td className="px-3 py-2.5 text-slate-500" colSpan={7}>
        <span className="font-mono text-xs">
          no map — {run.error ?? "the run recorded no reason"}
        </span>
      </td>
    </tr>
  );
}

export default async function RunsPage() {
  // Not `.catch(() => [])`. A registry that cannot be read is a different fact
  // from a deployment that has not run anything, and "No runs yet" is a
  // confident lie to tell an operator who has pointed OPENKB_RUNS_DIR somewhere
  // unusable — it sends them off to re-buy maps they already paid for. The
  // gallery at /kb already draws this distinction; this page was the one place
  // a refusal could still arrive and be thrown away.
  let runs: StoredRun[] = [];
  let error: string | null = null;
  try {
    runs = await listStoredRuns();
  } catch (err) {
    // And bounded for the same reason /kb is, measured the same way: this page
    // shipped `OPENKB_RUNS_DIR is "/", which resolves to / …` into production
    // HTML at status 200. A named fault — one lib/api-error.ts wrote, which the
    // registry's refusal is — keeps its exact wording, since that sentence is
    // the operator's fix. Anything else becomes a fixed sentence and a ref the
    // server log carries the cause for. Never empty, so "could not read" stays
    // distinguishable from "no runs yet" below, which is the distinction this
    // catch exists for in the first place.
    error = faultNotice(err, "GET /runs");
  }
  /* A run with no map is a row too, and this is where the split lives.

     `summaryOf` reads `run.result` on its first line, so a failed run cannot
     have one — and must not be given a zeroed stand-in, which would put "0
     entities, $0.00" in the table as though the sweep had looked and found
     nothing. `kb: null` is the honest carrier: the cells that measure a map
     print a dash, and the ones that describe the RUN — domain, when it ended,
     that it failed — print what they know.

     Before this, a failed run reached the gallery from nowhere at all: the
     store dropped every row without a result, so the only runs this page could
     ever list were the ones that worked. A page called "Runs" that silently
     omits the ones that broke is the most expensive kind of quiet — the operator
     sees six successes and no sign of the four that burned money and died. */
  const rows = runs.map((run) => ({ run, kb: isCompleted(run) ? summaryOf(run) : null }));

  // Totals are of what was MEASURED. A failed run contributes nothing to them
  // rather than a zero, because a zero is a measurement and this is an absence.
  const demo = isDemo();
  const totalPlayers = rows.reduce((n, r) => n + (r.kb?.counts.player ?? 0), 0);
  const totalEntities = rows.reduce((n, r) => n + (r.kb?.notes ?? 0), 0);
  const failedCount = rows.filter((r) => r.kb === null).length;

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Runs
        </h1>
        {/* "Ended", not "finished". The page lists runs that failed as well
            now, and a failed run wrote no JSON — it is here from its row and
            its spans. The old sentence described only the half that worked,
            which is the same quiet this page was widened to end. */}
        <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-2xl text-sm text-slate-400">
            Every sweep this deployment ended, read from what each one recorded
            when it stopped. No live stream, no platform retention.
          </p>
          {/* THE WAY OUT OF A GALLERY. Every page here listed maps somebody
              else had already built and none of them said how to build one, so
              a visitor who wanted their own market had to guess. On a demo the
              answer is the repo, because this deployment refuses runs on
              purpose; anywhere else the answer is the box on the front page. */}
          {demo ? (
            <a
              href={DEMO_REPO}
              className="shrink-0 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:border-sky-400/60 hover:bg-sky-500/20"
            >
              Map your own domain →
            </a>
          ) : (
            <Link
              href="/"
              className="shrink-0 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:border-sky-400/60 hover:bg-sky-500/20"
            >
              Map a domain →
            </Link>
          )}
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-rose-300">
          Could not list runs
          <div className="mt-1 font-mono text-xs text-slate-500">{error}</div>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-400">
          No runs yet. Start one from the{" "}
          <Link href="/" className="text-sky-400 hover:text-sky-300">
            Map
          </Link>{" "}
          page.
        </p>
      ) : (
        <>
          {/* Four columns, or five when there is a fifth tile. A fixed four
              would put the Failed tile alone on a second row with three empty
              cells beside it — and the cells are not empty-looking, the grid
              paints its gaps, so three slate blocks would read as tiles whose
              numbers failed to load. */}
          <div
            className={`mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 ${
              failedCount > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3"
            }`}
          >
            {/* WHAT A READER WANTS FROM A ROW OF NUMBERS, which is not what an
                operator wants. `Spent` and `Unplaced` were the other two here,
                and both answered a question nobody visiting had asked: one is
                the owner's bill, the other is a count of things the engine
                could not place, which reads as a defect rate on the first
                screen. Both are still on the run's own page, where someone
                debugging a run goes looking. Up here the tiles say how much
                market is on the table. */}
            <StatTile label="Runs" value={String(rows.length)} />
            <StatTile label="Entities mapped" value={String(totalEntities)} />
            <StatTile label="Companies found" value={String(totalPlayers)} />
            {/* Only when there are any. A permanent "Failed 0" tile invites the
                eye to a number that is almost always zero and teaches it to
                stop looking; a tile that appears is a tile that is read. */}
            {failedCount > 0 && (
              <StatTile
                label="Failed"
                value={String(failedCount)}
                tone="text-rose-400"
                hint="ended without a map"
              />
            )}
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
                  <th className="px-3 py-2.5 font-medium" title="everything fired: the opening hand plus every widening round">
                    Queries
                  </th>
                  <th className="px-3 py-2.5 font-medium">Hosts</th>
                  <th className="px-3 py-2.5 font-medium">Took</th>
                  <th className="px-3 py-2.5 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {rows.map(({ run, kb }) => {
                  const s = run.result?.stats;
                  const built = run.endedAt
                    ? new Date(run.endedAt).toISOString().slice(0, 16).replace("T", " ")
                    : "—";
                  const reportObj = (run.result?.report as Record<string, unknown> | undefined) ?? {};
                  // The run's own itemised bill, when it carried one. Runs
                  // recorded before `report.cost` existed did not, and a dash is
                  // the honest answer for those.
                  const cost = readRunCost(reportObj.cost);
                  // Everything actually fired, opening hand plus every
                  // widening round — `stats.queries` alone is only the
                  // opening hand and understates what a run bought (63 vs 123,
                  // measured). Runs recorded before `report.queries` existed
                  // fall back to the one number they have.
                  const queriesAsked =
                    typeof reportObj.queries === "number" ? reportObj.queries : s?.queries;
                  /* A run with no map. Every measured cell is a dash rather
                     than a zero: this run did not count zero hosts, it never
                     got to count. The row still exists because the run did. */
                  if (!kb || !s) return <FailedRow key={run.id} run={run} built={built} />;
                  return (
                    <tr
                      key={run.id}
                      /* Row hover. Nine columns of tabular numbers is a lot of
                         horizontal distance to track with the eye — the tint
                         is what keeps "Cost" tied to the domain that spent it
                         while the cursor is out at the right-hand edge. */
                      className="border-b border-slate-800/70 transition-colors duration-100 last:border-0 hover:bg-slate-800/30"
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
                      <Cell>{queriesAsked}</Cell>
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
