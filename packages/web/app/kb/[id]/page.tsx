import Link from "next/link";
import { KbBrowser } from "@/components/kb/KbBrowser";
import { getStoredRun, listStoredRuns } from "@/lib/runs";
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

  if (!run) {
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
    try {
      const all = (await listStoredRuns()).map((r) => {
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
    } catch {
      // An unreadable registry is a different failure; the link out still works.
    }

    return (
      <div className="mx-auto max-w-2xl px-5 py-16">
        <div className="mb-1 font-mono text-sm text-rose-300">
          No knowledge base called <span className="text-rose-200">{id}</span>
        </div>
        <p className="mb-6 text-sm text-slate-400">
          {near.length > 0
            ? "Long run ids get truncated by the address bar. Did you mean one of these?"
            : "Nothing has been mapped yet."}
        </p>

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

  const view = viewOf(run);
  const summary = summaryOf(run);

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
