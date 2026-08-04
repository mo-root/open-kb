import Link from "next/link";
import { KbGallery } from "@/components/KbGallery";
import { listStoredRuns } from "@/lib/runs";
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
    kbs = (await listStoredRuns()).map(summaryOf);
  } catch (err) {
    // A registry that cannot be read is a different fact from a registry with
    // no runs in it, and telling a reader "nothing built yet" when the truth is
    // "the runs directory is unreadable" sends them off to re-buy a map that
    // already exists.
    error = err instanceof Error ? err.message : "could not read the run registry";
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

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">
        One knowledge base per completed run, read from the JSON each run wrote
        under <span className="font-mono text-slate-400">runs/</span>. Sweeps run
        from the command line (
        <span className="font-mono text-slate-400">scripts/sweep.ts</span>) write
        a different, envelope-less shape and are deliberately not listed — a
        gallery that half-reads a file it does not understand is worse than one
        that says it holds nothing.
      </p>
    </div>
  );
}
