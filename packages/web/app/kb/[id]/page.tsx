import Link from "next/link";
import { KbBrowser } from "@/components/kb/KbBrowser";
import { faultNotice } from "@/lib/api-error";
import { getStoredRun, isCompleted, listStoredRuns } from "@/lib/runs";
import { summaryOf, viewOf } from "@/lib/kb-from-run";
import { manifestStr, builtAtOf } from "@/components/kb/layerMeta";

// A KB is a completed run, and the registry is not prerenderable.
export const dynamic = "force-dynamic";

export default async function KbPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ note?: string | string[] }>;
}) {
  const { id } = await params;
  const { note } = await searchParams;

  const run = await getStoredRun(id);

  /* A run that FAILED reaches here now, where it used to be a null out of the
     store, and it is deliberately routed into the same branch. There is no map
     to draw and there never will be, so this page has nothing more to offer
     than the miss below — what it can do, and does, is say which of the two
     happened instead of implying the id was mistyped. `/runs/<id>` is where the
     failure itself is reported.

     `kb` rather than a boolean beside `run`, because the branch has to narrow:
     everything past it reads `run.result`, and only `isCompleted` can promise
     it is there. */
  const kb = run && isCompleted(run) ? run : null;
  const failed = run !== null && kb === null;

  if (!kb) {
    /* A dead end is a bug, not an outcome.
       The commonest way to land here is a TRUNCATED url — the address bar
       autocompletes `/kb/brightdata-com-202608042230` down to `/kb/br`, and the
       old page answered with the bare fact that `br` does not exist plus a link
       back to the gallery, making the reader start over. The id they typed is
       almost always a prefix of the one they wanted, so it is used as one: any
       run whose slug or brand contains it is offered directly. Failing that,
       the most recent runs are, because "there is nothing here" is far more
       often "I mistyped" than "the registry is empty". */
    const q = id.toLowerCase();
    let near: { slug: string; label: string; built?: string }[] = [];
    let error: string | null = null;
    try {
      // Completed runs only: this list is "did you mean one of these maps?",
      // and offering a run that failed would be offering another dead end.
      const all = (await listStoredRuns()).filter(isCompleted).map((r) => {
        const kb = summaryOf(r);
        return {
          slug: kb.slug,
          label: manifestStr(kb.manifest, "brand", "root", "input") ?? kb.slug,
          built: builtAtOf(kb.manifest),
        };
      });
      const sorted = all.sort((a, b) => (b.built ?? "").localeCompare(a.built ?? ""));
      const matches = sorted.filter(
        (k) => k.slug.toLowerCase().includes(q) || k.label.toLowerCase().includes(q),
      );
      near = (matches.length > 0 ? matches : sorted).slice(0, 8);
    } catch (err) {
      // The line that stood here named this failure — "an unreadable registry is
      // a different failure" — and then dropped it on the floor, so the page fell
      // through to `near.length === 0` and printed "Nothing has been mapped yet."
      // That is the sentence /kb, /runs and lib/runs.ts were each changed to stop
      // printing, surviving on the one page still saying it. Measured on a
      // production build, OPENKB_RUNS_DIR at a chmod-000 directory holding nine
      // readable maps: GET /kb/some.thing answered 200 with "No knowledge base
      // called some.thing / Nothing has been mapped yet."
      //
      // 9504685 did not write that bug, it made it reachable. Before it, every
      // errno but the filesystem root was swallowed inside `listStoredRuns`, so
      // this catch saw almost nothing; now EACCES, ENOTDIR, ELOOP and
      // ENAMETOOLONG all arrive here, which is the whole class an operator
      // actually hits.
      //
      // `faultNotice` and never `err.message`, the same deal /kb and /runs take —
      // see "the sentence a page may speak for" in lib/api-error.ts. The
      // registry's refusal is a NamedFault and keeps every word, because naming
      // the directory and the remedy is the value of it; anything else becomes a
      // fixed sentence and a grep-able ref. Worth saying that the try above is
      // wider than the read: `summaryOf` and the two manifest readers are inside
      // it, so the day kb-from-run throws, that message would have shipped too.
      //
      // The route pattern rather than `/kb/${id}`: the id is a URL segment Next
      // hands over undecoded, and this string is concatenated into a server log
      // line. The ref is what joins the reader's screen to that line; the id
      // would only be a second, forgeable way to spell it.
      error = faultNotice(err, "GET /kb/[id]");
    }

    return (
      <div className="mx-auto max-w-2xl px-5 py-16">
        <div className="mb-1 font-mono text-sm text-rose-300">
          {failed ? (
            <>
              Run <span className="text-rose-200">{id}</span> failed, so it built no map
            </>
          ) : (
            <>
              No knowledge base called <span className="text-rose-200">{id}</span>
            </>
          )}
        </div>
        {/* The reader asked for a map by id and the id was RIGHT — telling them
            "no knowledge base called <id>" would send them off to check their
            typing over a run that in fact happened and cost money. The failure
            itself is reported one page over, where the run lives. */}
        {failed && (
          <p className="mb-6 mt-2 text-sm text-slate-400">
            The run exists and its ending was recorded.{" "}
            <Link href={`/runs/${id}`} className="text-sky-400 hover:text-sky-300">
              See what happened →
            </Link>
          </p>
        )}
        {/* THE ORDER, which is not the two list pages'. /kb and /runs have one
            thing to say, so a fault takes the whole page from them. This page
            was asked about ONE id, and that id is still not there — so the
            answer to the question asked stays the headline above, and the fault
            explains only why nothing is offered in its place.

            The 404 is not in doubt when it prints, which is what makes that
            ordering honest rather than merely tidy. `getStoredRun` touches disk
            only inside `isRunId` or `isCliRunId`: an id satisfying NEITHER — a
            dot, a space, over 250 characters — never reads anything, so a null
            from it is the alphabet's answer and not the filesystem's; an id that
            satisfies one either read its file or threw, and a throw never
            reaches this branch at all, it goes to app/error.tsx. Both measured.
            So the page states the answer it has, then the fact it is missing,
            instead of burying a true 404 under a directory's permission bits.

            Certain with respect to the FILESYSTEM, and that qualifier is load
            bearing. `getStoredRun` ends at `db.getRunRow`, and `quiet` in
            lib/store/supabase.ts swallows a store that is unreachable — measured
            with SUPABASE_URL pointed at a closed port, this page answered a
            confident 404 while stderr carried the connection error. A store that
            is down is indistinguishable here from a store that does not hold the
            id, so the 404 is only as certain as the store is up. That is a gap in
            the store's reporting rather than in this ordering, but the sentence
            above would be false without this one.

            Exclusive in practice — `near` is assigned last inside the try, so a
            throw leaves it empty — and `error` is still tested first, matching
            the siblings and keeping a fault from ever hiding behind a list. */}
        <p className="mb-6 text-sm text-slate-400">
          {error
            ? "Nothing to suggest instead: the other knowledge bases could not be listed, which is not the same as there being none."
            : near.length > 0
              ? failed
                /* Not "did you mean one of these?" — the id was right. The list
                   below is other maps, offered as an alternative to a map that
                   was never built, not as a correction to a typo. */
                ? "Other knowledge bases this deployment holds:"
                : "Long run ids get truncated by the address bar. Did you mean one of these?"
              : failed
                ? "Nothing else has been mapped either."
                : "Nothing has been mapped yet."}
        </p>

        {error && (
          <div className="mb-6 rounded-lg border border-dashed border-slate-800 p-4 font-mono text-xs leading-relaxed text-slate-500">
            {error}
          </div>
        )}

        {near.length > 0 && (
          <ul className="mb-6 divide-y divide-slate-800/70 rounded-lg border border-slate-800">
            {near.map((k) => (
              <li key={k.slug}>
                <Link
                  href={`/kb/${k.slug}`}
                  className="flex items-baseline justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-slate-800/40"
                >
                  <span className="truncate text-sm text-slate-200">{k.label}</span>
                  <span className="tnum shrink-0 font-mono text-[11px] text-slate-500">
                    {k.built ? k.built.slice(0, 10) : k.slug.slice(0, 8)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Link href="/kb" className="text-sm text-sky-400 hover:text-sky-300">
          ← All knowledge bases
        </Link>
      </div>
    );
  }

  const view = viewOf(kb);
  const summary = summaryOf(kb);

  return (
    <KbBrowser
      slug={view.slug}
      manifest={view.manifest}
      brand={view.brand}
      notes={view.notes}
      counts={view.counts}
      unplaced={summary.unplaced}
      noise={summary.noise}
      catalog={view.catalog}
      markets={view.markets}
      readPages={view.readPages}
      strips={view.strips}
      initialNote={typeof note === "string" ? note : undefined}
    />
  );
}
