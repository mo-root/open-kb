import Link from "next/link";
import { KbBrowser } from "@/components/kb/KbBrowser";
import { getStoredRun } from "@/lib/runs";
import { summaryOf, viewOf } from "@/lib/kb-from-run";

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

  if (!run) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16 text-center">
        <div className="mb-2 font-mono text-sm text-rose-300">
          Knowledge base not found
        </div>
        <div className="mb-6 font-mono text-xs text-slate-500">run {id}</div>
        <Link href="/kb" className="text-sm text-sky-400 hover:text-sky-300">
          ← All knowledge bases
        </Link>
      </div>
    );
  }

  const view = viewOf(run);
  const summary = summaryOf(run);

  return (
    <KbBrowser
      slug={view.slug}
      manifest={view.manifest}
      notes={view.notes}
      counts={view.counts}
      unplaced={summary.unplaced}
      noise={summary.noise}
      initialNote={typeof note === "string" ? note : undefined}
    />
  );
}
