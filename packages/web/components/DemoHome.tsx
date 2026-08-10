import { KbCard } from "@/components/KbCard";
import { manifestNum } from "@/components/kb/layerMeta";
import { formatDuration, formatUsd } from "@/components/build/types";
import { DEMO_ASIDE, DEMO_REPO } from "@/lib/demo";
import type { KbSummary } from "@/lib/viewTypes";

/**
 * The home page of a read-only deployment: the maps, first.
 *
 * WHAT IT REPLACES, and why the replacement is not a redesign. In demo mode
 * this route rendered the run-starter with a notice bolted on, and a stranger
 * met, in this order: a headline promising "Map a market", a paragraph
 * explaining why they could not, a greyed-out domain input they were invited to
 * look at and not use, a price list for the thing they could not buy, and then
 * two-thirds of an empty page. Six real maps were bundled — thousands of
 * entities, every one carrying its sources — and not one was on screen. The
 * page told a visitor they existed and made them go find them.
 *
 * So the maps moved up into the space the dead form was occupying. The headline
 * and the de-branding sentence stay exactly as they were, because they are the
 * pitch and they are true on any deployment; the form goes, because a disabled
 * input teaches a visitor nothing except that they are not welcome; and the
 * sixty-word refusal becomes one line at the bottom beside the clone link,
 * which is the action a convinced reader actually wants.
 *
 * BORROWED, NOT INVENTED. The cards are `KbCard` — the same component /kb
 * renders, in its `showcase` spelling — in the same `.stagger` grid at the same
 * three breakpoints, under a page shell with the same `max-w-6xl px-5 py-8` as
 * the run-starter it stands in for. A visitor who clicks a card lands on /kb/…
 * and should not be able to tell they crossed a seam, because there is not
 * really one: this is the gallery, given the front page.
 */

/** One row of arithmetic over the maps on screen. Every field is summed from
 *  what the runs recorded — nothing here is a rate card or an estimate. */
interface Ledger {
  maps: number;
  entities: number;
  edges: number;
  /** Undefined when any map on screen failed to record its cost: a partial sum
   *  presented as a total is a smaller number than the truth, and this line's
   *  whole job is being the honest one. */
  usd: number | undefined;
  seconds: number | undefined;
}

function ledgerOf(kbs: KbSummary[]): Ledger {
  let usd: number | undefined = 0;
  let seconds: number | undefined = 0;
  for (const kb of kbs) {
    const spent = manifestNum(kb.manifest, "usd");
    const took = manifestNum(kb.manifest, "seconds");
    usd = usd === undefined || spent === undefined ? undefined : usd + spent;
    seconds = seconds === undefined || took === undefined ? undefined : seconds + took;
  }
  return {
    maps: kbs.length,
    entities: kbs.reduce((n, kb) => n + kb.notes, 0),
    edges: kbs.reduce((n, kb) => n + kb.edges, 0),
    usd,
    seconds,
  };
}

const n = (v: number) => v.toLocaleString("en-US");

export function DemoHome({
  kbs,
  error = null,
  bare = false,
  notice = null,
}: {
  kbs: KbSummary[];
  /** Whatever `faultNotice` made of a registry that could not be read. A demo
   *  that cannot find the maps it ships with has one useful thing to say, and
   *  an empty page is not it — see the `OPENKB_DEMO is on` fault in
   *  lib/runs.ts, which names the directory and the variable that overrides it. */
  error?: string | null;
  /**
   * The same maps, as a section rather than as the page.
   *
   * A deployment with a daily allowance (lib/public-runs.ts) puts the run box
   * on top and these underneath, so the page shell, the headline and the
   * de-branding sentence all come from `BuildWorkflow` — which renders them
   * identically, because this component copied them from there in the first
   * place. Repeating them would give a visitor two "Map a market" headings and
   * two identical paragraphs, above and below one form.
   *
   * Default false, and every branch below it is the read-only page exactly as
   * it was. That is the load-bearing half: `OPENKB_PUBLIC_RUNS_PER_DAY` is
   * unset on every existing demo, and none of them may notice this prop exists.
   */
  bare?: boolean;
  /**
   * One line above the maps, when the deployment has something to say about why
   * there is no box today — today's allowance is spent, and when it resets.
   *
   * A SENTENCE AND NOT A DISABLED FORM. The alternative was to render the box
   * greyed out with the count at zero, and this codebase has already had that
   * argument once: a disabled input teaches a visitor nothing except that they
   * are not welcome. The maps are the thing worth showing either way, so a
   * refused day looks like the read-only demo plus one honest line.
   */
  notice?: string | null;
}) {
  /* Biggest first, which is the gallery's own "Biggest map" sort (KbGallery's
     `size`), applied here without its toolbar. Six cards need no filter and no
     sort control — the reader can see all of them — but they do need an order,
     and on a page whose job is to show what this thing produces, the largest
     map is the most convincing one to lead with. `notes` breaks nothing when
     two maps tie: `slug` is unique and settles it, so the order is stable
     across renders rather than dependent on the reader's sort. */
  const shown = [...kbs].sort((a, b) => b.notes - a.notes || a.slug.localeCompare(b.slug));
  const l = ledgerOf(shown);

  /* The old line in this slot was a price list: "a question reads 4 result
     pages at $0.0015 each", quoted at a reader who had no way to buy one. Same
     slot, same type, and now it is a fact about the six maps directly beneath
     it — what they hold and what they cost, all of it already spent. */
  const ledger = shown.length > 0 && (
    <p className="tnum mt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
      {l.maps} {l.maps === 1 ? "map" : "maps"} below · {n(l.entities)} entities
      · {n(l.edges)} edges
      {l.usd !== undefined && l.seconds !== undefined && (
        <>
          {" "}
          · {formatUsd(l.usd)} and {formatDuration(l.seconds * 1000)} of machine
          time, already spent
        </>
      )}
    </p>
  );

  const maps = error ? (
    <div className="rounded-lg border border-dashed border-slate-800 p-10 text-center text-sm text-rose-300">
      Could not read the maps this demo ships with
      <div className="mt-1 font-mono text-xs text-slate-500">{error}</div>
    </div>
  ) : shown.length === 0 ? (
    <div className="rounded-lg border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
      This deployment is a demo and is holding no maps to show.
    </div>
  ) : (
    <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((kb) => (
        <KbCard key={kb.slug} kb={kb} showcase />
      ))}
    </div>
  );

  /* The secondary action, and the whole of what used to be the page's opening
     paragraph. It sits under the maps because that is the order the reader
     needs it in: see the thing work, then learn how to have one. The link is
     the answer, so the sentence does not describe it.

     STILL HERE WHEN RUNS ARE ALLOWED, and it should be. `DEMO_ASIDE` says these
     maps are paid-for runs and that new ones cost minutes and real money —
     both true on a deployment that has decided to buy a few a day — and a
     reader who wants more than today's allowance still wants the repo. */
  const aside = (
    <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">
      {DEMO_ASIDE}{" "}
      <a
        href={DEMO_REPO}
        target="_blank"
        rel="noreferrer"
        className="whitespace-nowrap text-sky-400 hover:text-sky-300"
      >
        Clone the repo, bring your own keys →
      </a>
    </p>
  );

  /* The section under the run box. No page shell and no headline — the box
     above renders both — so this opens on a rule and a label that says what
     the reader is now looking at, which is the one thing the arrangement adds:
     these are not their run. */
  if (bare) {
    return (
      <section className="mt-12 border-t border-slate-800 pt-8">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
          maps already built here
        </h2>
        {ledger}
        <div className="mt-4">{maps}</div>
        {aside}
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Map a market
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          One domain in, everyone else in its market out. The catalog is written
          before any company name is known — so the queries cannot look this
          company up, and what comes back is the market rather than its press.
        </p>

        {notice && (
          <p className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs leading-relaxed text-slate-400">
            {notice}
          </p>
        )}

        {ledger}
      </div>

      {maps}

      {aside}
    </div>
  );
}
