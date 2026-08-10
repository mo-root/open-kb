import { BuildWorkflow } from "@/components/build/BuildWorkflow";
import { DemoHome } from "@/components/DemoHome";
import { faultNotice } from "@/lib/api-error";
import { isDemo } from "@/lib/demo";
import { summaryOf } from "@/lib/kb-from-run";
import { isCompleted, listStoredRuns } from "@/lib/runs";
import type { KbSummary } from "@/lib/viewTypes";

/* The home page, which is one of two pages depending on what this deployment
   is allowed to do.
   ---------------------------------------------------------------------------
   ORDINARY DEPLOYMENT: the run surface, unchanged and untouched. It is a client
   component holding five live NDJSON readers, so this stays a thin shell around
   it, and `<BuildWorkflow />` is the whole of that branch — no props, nothing
   for a future edit here to get wrong about it.

   DEMO DEPLOYMENT: the maps this repo ships with, rendered as the page. That
   branch used to be a prop — the shell read `OPENKB_DEMO` and told the run
   surface to disable itself — which produced a form whose only function was
   refusing to work. Deciding here instead means the run surface is only ever
   mounted where it can actually run, and a visitor to the demo meets six
   finished maps instead of a locked door with a polite sign on it.

   `OPENKB_DEMO` lives in the server's environment and a client component cannot
   read it, so this shell is the only place the choice can be made. */

/* Not prerendered. `isDemo()` reads the environment at request time, and a
   statically rendered shell would bake one deployment's answer into the HTML at
   build time — the same class of mistake `ceilingUsd()` documents having
   shipped once, arriving through the renderer instead of the bundler. The demo
   branch needs it for a second reason: it reads the maps off disk, the same
   read /kb does for the same reason. */
export const dynamic = "force-dynamic";

export default async function Home() {
  /* First, and with nothing awaited above it. A live deployment must not pay a
     directory read to render its own front page, and this early return is what
     guarantees it never does. */
  if (!isDemo()) return <BuildWorkflow />;

  let kbs: KbSummary[] = [];
  let error: string | null = null;
  try {
    // The same three calls /kb makes, for the same reasons — completed runs
    // only, since a run that crashed produced no map to show. In demo mode
    // `listStoredRuns` serves the committed `demo/maps/` directory and nothing
    // else (see lib/runs.ts), so this is the bundled six and never an
    // operator's own runs.
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

  return <DemoHome kbs={kbs} error={error} />;
}
