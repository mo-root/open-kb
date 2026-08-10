import { BuildWorkflow, type RunInvite } from "@/components/build/BuildWorkflow";
import { DemoHome } from "@/components/DemoHome";
import { faultNotice } from "@/lib/api-error";
import { isDemo } from "@/lib/demo";
import { summaryOf } from "@/lib/kb-from-run";
import { MEASURED, publicRunsPerDay, runGate } from "@/lib/public-runs";
import { isCompleted, listStoredRuns } from "@/lib/runs";
import type { KbSummary } from "@/lib/viewTypes";

/* The home page, which is one of three pages depending on what this deployment
   is allowed to do.
   ---------------------------------------------------------------------------
   ORDINARY DEPLOYMENT: the run surface, unchanged and untouched. It is a client
   component holding five live NDJSON readers, so this stays a thin shell around
   it, and `<BuildWorkflow />` is the whole of that branch — no props, nothing
   for a future edit here to get wrong about it.

   READ-ONLY DEMO: the maps this repo ships with, rendered as the page. That
   branch used to be a prop — the shell read `OPENKB_DEMO` and told the run
   surface to disable itself — which produced a form whose only function was
   refusing to work. Deciding here instead means the run surface is only ever
   mounted where it can actually run, and a visitor to the demo meets six
   finished maps instead of a locked door with a polite sign on it.

   PUBLIC DEMO WITH A DAILY ALLOWANCE: both. The box on top, with the count of
   runs left today in it, and the finished maps underneath — because a stranger
   who has not decided to wait four minutes still deserves to see what four
   minutes buys, and the six maps are the argument for typing anything at all.
   `OPENKB_PUBLIC_RUNS_PER_DAY` is what puts a deployment here; the reasoning
   for it being a second variable, and a number rather than a boolean, is in
   lib/public-runs.ts.

   Both flags live in the server's environment and a client component cannot
   read either, so this shell is the only place the choice can be made. */

/* Not prerendered. `isDemo()` reads the environment at request time, and a
   statically rendered shell would bake one deployment's answer into the HTML at
   build time — the same class of mistake `ceilingUsd()` documents having
   shipped once, arriving through the renderer instead of the bundler. Two more
   reasons now: the demo branch reads the maps off disk, and the allowance
   branch counts today's runs, and a cached copy of either is a wrong number
   told confidently. */
export const dynamic = "force-dynamic";

export default async function Home() {
  const demo = isDemo();

  /* First, and with nothing awaited above it. A live deployment must not pay a
     directory read to render its own front page, and this early return is what
     guarantees it never does — `publicRunsPerDay()` is an environment read, not
     a query, so the unmetered majority still reaches no store and no disk. */
  if (!demo && publicRunsPerDay() === 0) return <BuildWorkflow />;

  const gate = await runGate();
  const invite: RunInvite | undefined = gate.open && gate.remaining !== null
    ? {
        limit: gate.limit,
        remaining: gate.remaining,
        minutes: MEASURED.aboutMinutes,
        entities: MEASURED.aboutEntities,
      }
    : undefined;

  /* A metered deployment that is NOT a demo: the run surface with the count in
     it, and no gallery — this is somebody's own instance behind a password, and
     /kb is where they browse what it has built. */
  if (!demo) return <BuildWorkflow invite={invite} />;

  let kbs: KbSummary[] = [];
  let error: string | null = null;
  try {
    // The same three calls /kb makes, for the same reasons — completed runs
    // only, since a run that crashed produced no map to show. In demo mode
    // `listStoredRuns` serves the committed `demo/maps/` directory and nothing
    // else (see lib/runs.ts), so this is the bundled six and never an
    // operator's own runs — and that stays true with an allowance on, which is
    // the deliberate half: a visitor's run is reachable by its link, not by
    // appearing in a gallery of everything strangers typed today.
    kbs = (await listStoredRuns()).filter(isCompleted).map(summaryOf);
  } catch (err) {
    /* A demo that cannot find the maps it ships with has exactly one useful
       thing to say, and `listStoredRuns` says it: the `OPENKB_DEMO is on` fault
       names `demo/maps` and the variable that overrides it. `faultNotice`
       prints a named fault verbatim and reduces anything else to a grep-able
       ref, which is the same bound /kb renders under — see the long note there
       for what happened when a page printed a raw `err.message`. */
    error = faultNotice(err, "GET /");
  }

  /* Runs are open: the box, then the maps under it. */
  if (invite) {
    return (
      <BuildWorkflow invite={invite}>
        <DemoHome kbs={kbs} error={error} bare />
      </BuildWorkflow>
    );
  }

  /* Closed. Today's page is yesterday's page plus, when there is one, the
     sentence that explains the missing box.

     ONLY FOR "used-up". The other two refusals are not the visitor's business:
     `read-only` is a deployment that never had a box, and its page already says
     what it is beside the clone link; `uncountable` is a store outage, which
     the visitor can do nothing about and which resolves itself. Both render
     exactly the page they rendered before this feature existed. */
  return (
    <DemoHome
      kbs={kbs}
      error={error}
      notice={!gate.open && gate.reason === "used-up" ? gate.refusal : null}
    />
  );
}
