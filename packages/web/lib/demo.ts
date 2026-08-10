/**
 * Read-only demo mode: the deployment serves maps it already has and buys none.
 *
 * WHAT IT IS FOR. A sweep takes four to nineteen minutes and costs $0.30-$5.00,
 * so a public URL with a working Map button is a public URL that spends the
 * owner's money once per curious stranger. The map itself — 2,551 entities
 * clustered by market, every node carrying its sources — is the thing worth
 * showing, and six of those are committed under `demo/maps/`. This flag serves
 * those and closes the one door that spends.
 *
 * WHAT IT IS NOT. Not auth, and not a spend cap. The middleware decides WHO
 * gets in and `OPENKB_CEILING_USD` decides HOW MUCH a deployment may spend;
 * this decides WHETHER there is a spending door at all. A demo deployment
 * wants all three — the flag is the only one of them that still leaves a
 * useful site behind when it is on.
 */

/**
 * Read inside a function, never at module scope, and for app/api/map/route.ts's
 * reason rather than lib/api-error.ts's.
 *
 * Next inlines a statically analysable `process.env.X` at build time, so
 * `const DEMO = process.env.OPENKB_DEMO === "1"` compiles to `const DEMO =
 * false` in an image built without the variable, and every branch below it is
 * tree-shaken away. The deployment would then report itself a demo, in the UI,
 * while the Map button still spent. That is the exact failure `ceilingUsd()`
 * documents having shipped once already — a guard that compiled to `if
 * (false)` — and this flag is more dangerous than that one, because it is also
 * a claim made to the reader.
 *
 * A function body defers the read to run time, which is when the host actually
 * sets the variable.
 */
export function isDemo(): boolean {
  return truthy(process.env.OPENKB_DEMO)
}

/**
 * What counts as on.
 *
 * `OPENKB_DEMO=1` is what the docs say and what a deployment should use. The
 * other spellings are here because the cost of being wrong is asymmetric: a
 * host that writes `true` into the variable and gets a live spending endpoint
 * has surprised its operator into a bill, while a host that writes `0` and gets
 * a live endpoint got what it asked for. So anything that plainly reads as
 * "yes" turns it on, and everything else — unset, empty, `0`, `false`, `no` —
 * leaves the app exactly as it was.
 *
 * Not "any non-empty string": `OPENKB_DEMO=false` is a real thing operators
 * type, and reading it as on would be a worse surprise than the one above.
 */
function truthy(v: string | undefined): boolean {
  if (!v) return false
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())
}

/**
 * What the map route answers ANYONE WHO ASKS IT FOR A RUN.
 *
 * IT IS NO LONGER ON THE PAGE, and that is the point of `DEMO_ASIDE` below.
 * This used to be printed above a disabled input, sixty words explaining an
 * absence to a visitor who had not asked for anything — the first thing a
 * stranger read was why they could not have the thing they had not requested.
 * The demo home shows the maps instead, so nobody meets a refusal by arriving,
 * and this string went back to being what it always was: the answer to a
 * request. `POST /api/map` returns it; nothing renders it.
 *
 * HONEST, which is the whole specification. It is not "something went wrong",
 * because nothing did — the deployment is behaving exactly as configured. It is
 * not "coming soon" or "temporarily disabled", because neither is true and both
 * invite the visitor to come back and try again. It says what this is, why the
 * button does not work, and the one thing a visitor who actually wants a map
 * can do about it. A refusal that leaves the reader with a next step is worth
 * more than an apology.
 */
export const DEMO_REFUSAL =
  "This is a read-only demo — the maps here are real runs, already paid for, and " +
  "you can open any of them. Building a new one takes several minutes and real " +
  "money at the search and model providers, so this deployment will not start " +
  "one. Clone the repo, bring your own keys, and it will."

/**
 * What the demo home says about itself, once, quietly, beside the clone link.
 *
 * A SECOND STRING, and the reason it is not `DEMO_REFUSAL` is that it is not a
 * refusal. Nobody reading this line asked for a run — there is no form on that
 * page to ask with. It is a footnote about what this deployment is, sitting
 * under six maps that have already answered the question of whether the thing
 * works. The refusal above answers a request; this answers a glance, and a
 * refusal used as a caption is how a demo ends up apologising for itself on
 * arrival.
 *
 * The two cannot contradict each other, because they make the same two claims
 * in the same order — these maps are paid-for runs, and new ones cost real
 * money at real providers — and lib/demo.test.ts holds them to it. What this
 * one drops is the part that only matters to someone who tried: the instruction
 * to clone. That is the link it sits next to, so the sentence does not need to
 * describe it.
 */
export const DEMO_ASIDE =
  "Every map here is a finished run, already paid for. A new one costs minutes and " +
  "real money at the search and model providers, so this deployment buys none."

/** Where a refused visitor is pointed. Read off package.json's `repository`
 *  by hand rather than fetched: this string ships in an API body, and a demo
 *  deployment should not be reading its own package metadata at request time
 *  to answer a refusal. */
export const DEMO_REPO = "https://github.com/mo-root/open-kb"
