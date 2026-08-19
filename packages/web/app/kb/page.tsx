import Link from "next/link";
import { KbGallery } from "@/components/KbGallery";
import { faultNotice } from "@/lib/api-error";
import { isCompleted, listStoredRuns } from "@/lib/runs";
import { summaryOf } from "@/lib/kb-from-run";
import type { KbSummary } from "@/lib/viewTypes";

// The gallery reads the registry on every request: a run that finished a second
// ago must appear immediately, and the registry is not something Next can
// prerender.
export const dynamic = "force-dynamic";

export default async function KbIndex() {
  let kbs: KbSummary[] = [];
  let error: string | null = null;
  try {
    // Completed runs only. A failed run is listed by /runs, which is about
    // runs; this page is about knowledge bases, and a run that crashed produced
    // none. See the same filter's reasoning in app/api/kb/route.ts.
    kbs = (await listStoredRuns()).filter(isCompleted).map(summaryOf);
  } catch (err) {
    // A registry that cannot be read is a different fact from a registry with
    // no runs in it, and telling a reader "nothing built yet" when the truth is
    // "the runs directory is unreadable" sends them off to re-buy a map that
    // already exists.
    //
    // BOUNDED, because this catch is not. It rendered `err.message`, and on a
    // `next start` with OPENKB_RUNS_DIR=/ that put the variable, its value and
    // two filesystem paths into production HTML at status 200 — React redacts a
    // Server Component error, but not one the component catches itself. Nor is
    // the registry all it covers: the try wraps `.map(summaryOf)` too, so any
    // future throw out of kb-from-run rendered here as well. `faultNotice`
    // prints the message when lib/api-error.ts wrote it — the OPENKB_RUNS_DIR
    // refusal is the one that qualifies, and it keeps every word, because
    // naming the variable and the remedy is the whole value of it — and a fixed
    // sentence with a grep-able ref for anything else. Non-empty either way, so
    // the branch below still separates unreadable from empty.
    error = faultNotice(err, "GET /kb");
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <div className="mb-6 flex items-baseline justify-between border-b border-slate-800/80 pb-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Knowledge bases
        </h1>
        {/* The count lives on the gallery's own toolbar, where it tracks the
            filter. Two counts in one header — one live, one frozen at the full
            set — read as a discrepancy rather than as two facts. */}
      </div>
      {error ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-10 text-center text-sm text-rose-300">
          Could not list knowledge bases
          <div className="mt-1 font-mono text-xs text-slate-500">{error}</div>
        </div>
      ) : kbs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
          Nothing mapped yet.{" "}
          <Link href="/" className="text-sky-400 hover:text-sky-300">
            Map a domain →
          </Link>
        </div>
      ) : (
        <KbGallery kbs={kbs} />
      )}

      {/* One line. The paragraph that stood here explained CLI file shapes
          to visitors who came to browse markets. */}
      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">
        One knowledge base per finished map, with every claim cited to the page
        it came from.
      </p>
    </div>
  );
}
