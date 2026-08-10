import { DEMO_REFUSAL, isDemo } from "./demo"
import * as db from "./store/supabase"

/**
 * Whether a stranger may start a run here, and how many are left today.
 *
 * A public deployment pays for its visitors. Six real runs through the deployed
 * app cost $0.147 to $0.202 each and returned 197 to 275 entities in 166 to 255
 * seconds, so one curious stranger is about twenty cents and a hundred of them
 * is twenty dollars. That is a bill worth paying and not one worth leaving
 * unbounded, which is the entire subject of this file: one number decides both
 * whether the door is open and how far.
 */

/* -------------------------------------------------------------------- the flag
 *
 * WHY A SECOND VARIABLE AND NOT A NEW MEANING FOR `OPENKB_DEMO`.
 *
 * `OPENKB_DEMO` reads like one boolean and does three jobs, and only the first
 * is about spending:
 *
 *   1. `POST /api/map` refuses            — the door this file reopens
 *   2. the front page leads with the maps — app/page.tsx
 *   3. every run surface serves ONLY the committed `demo/maps/`, never the
 *      operator's own store — lib/runs.ts, `listStoredRuns` and `getStoredRun`
 *
 * The third is a privacy boundary, and it was measured the hard way: a demo
 * built against this repo listed fifteen maps rather than six, because
 * next.config.ts loads the repo's `.env` and `SUPABASE_URL` is in it. Nine of
 * those were real runs of real domains that nobody chose to publish, on a URL
 * whose whole purpose is being handed to strangers.
 *
 * So redefining the flag as "public: runs allowed" would open (1) and (3)
 * together with one edit, in an environment variable, on the deployment where
 * being wrong is most expensive. A separate variable can open exactly one door
 * — and this one does: the LISTING stays curated (see `listStoredRuns`), while
 * a run a visitor started becomes readable BY ITS OWN ID, which is the narrow
 * permission item 4 of the ask actually needs. See `servesOwnRuns` below.
 *
 * WHY THE SWITCH IS THE LIMIT ITSELF.
 *
 * "A deployment with no limits configured must not start spending because
 * somebody upgraded." A boolean plus a separate cap has a configuration that
 * violates that — `OPENKB_PUBLIC=1` with no cap set is an unbounded spending
 * door, one forgotten line away from a stranger's script. Making the cap the
 * switch removes that state from the space: there is no way to open the door
 * without saying how wide, because they are the same variable. Unset is zero is
 * closed, which is what every existing deployment and every clone already has.
 */

/** Spelled once, and exported so the docs, the tests and the refusal sentences
 *  cannot drift from what the code reads. */
export const RUNS_PER_DAY_VAR = "OPENKB_PUBLIC_RUNS_PER_DAY"

/**
 * How many runs this deployment will start for visitors in a day. 0 is closed.
 *
 * Read inside a function for lib/demo.ts's reason, which is worth repeating
 * because this one is more expensive than that one: Next inlines a statically
 * analysable `process.env.X` at build time, so a module-scope
 * `const LIMIT = Number(process.env.OPENKB_PUBLIC_RUNS_PER_DAY ?? 0)` becomes
 * `const LIMIT = 0` in an image built without the variable — and the deployment
 * that set it in its host dashboard would refuse every run while reporting that
 * it allows some. `ceilingUsd()` in the map route documents having shipped
 * exactly that bug in the other direction.
 *
 * Anything that is not a whole number of at least 1 is 0. A typo (`OPENKB_
 * PUBLIC_RUNS_PER_DAY=lots`) closing the door is a demo; a typo opening it is a
 * bill, and the tolerance runs one way on purpose — the same asymmetry
 * `truthy()` in lib/demo.ts is built on, pointing the same direction.
 */
export function publicRunsPerDay(): number {
  const raw = process.env[RUNS_PER_DAY_VAR]
  if (!raw) return 0
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 1) return 0
  return Math.floor(n)
}

/**
 * May this deployment serve a run out of its OWN store, asked by id?
 *
 * The narrow half of the privacy boundary above. A public visitor waits four
 * minutes for a map and is given its link before they need it; if they close
 * the tab, the link has to work, and their run lives in Postgres because
 * nothing else survives a serverless instance. `getStoredRun` in lib/runs.ts is
 * what would otherwise refuse it, and it refuses for a real reason — see the
 * fifteen maps above.
 *
 * What this opens is only the BY-ID read. `listStoredRuns` still serves the
 * committed six and nothing else, so a public deployment's gallery stays
 * curated: strangers do not see each other's runs, and they do not see the
 * owner's. The ids that become reachable are `crypto.randomUUID()`s minted by
 * `createRun`, so "unlisted" here means unguessable rather than merely
 * undisplayed.
 */
export function servesOwnRuns(): boolean {
  return !isDemo() || publicRunsPerDay() > 0
}

/* ---------------------------------------------------------------- the window
 *
 * WHY A UTC DAY AND NOT A ROLLING WINDOW OR A TOKEN BUCKET.
 *
 * The count has to be answerable by one stateless query against a table that
 * already exists, from any instance, with nothing to reset and no job to run.
 * `started_at >= today's midnight UTC` is that query. A rolling 24 hours is
 * equally stateless and strictly worse to explain — "3 left" would silently
 * become "5 left" as old runs age out, and the whole point of the number on the
 * front page is that a visitor can trust it before they type.
 *
 * UTC rather than the owner's timezone because the row is UTC, the sentence
 * says UTC, and a deployment does not know where its reader is.
 */

/** Midnight UTC of the day `now` falls in — the instant the day's count starts. */
export function dayStartedAt(now: number = Date.now()): Date {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** The next midnight UTC — when the count goes back to zero. */
export function dayEndsAt(now: number = Date.now()): Date {
  return new Date(dayStartedAt(now).getTime() + 86_400_000)
}

/** `3h 12m`, for the sentence a used-up visitor reads. Minutes only under an
 *  hour: "0h 7m" reads as a broken template. */
export function untilReset(now: number = Date.now()): string {
  const ms = Math.max(0, dayEndsAt(now).getTime() - now)
  const mins = Math.ceil(ms / 60_000)
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`
}

/* ------------------------------------------------------------- what a run is
 *
 * Measured on six real runs through the deployed app, not estimated from a rate
 * card. These are the numbers the front page quotes to a visitor, and they are
 * here rather than in the component so the box, the tests and this file's own
 * arithmetic cannot drift apart.
 *
 * The visitor is told the TIME and the SIZE, never the price. It costs them
 * nothing; quoting them a bill they are not paying invites them to decide
 * whether it is worth it on the owner's behalf, and the honest thing they
 * actually have to spend is four minutes of their attention.
 */
export const MEASURED = {
  /** how many hosted runs these figures come from */
  runs: 6,
  /** 166s to 255s — the box rounds this to "about four minutes" */
  seconds: [166, 255] as const,
  /** 197 to 275 on the map */
  entities: [197, 275] as const,
  /** $0.147 to $0.202 at the search and model providers, paid by the owner */
  usd: [0.147, 0.202] as const,
  /** what the box says, in the words it says them */
  aboutMinutes: 4,
  aboutEntities: 230,
} as const

/* ----------------------------------------------------------------- the gate */

export type GateReason =
  /** demo mode, no daily allowance configured: the read-only deployment */
  | "read-only"
  /** an allowance is configured and today's is spent */
  | "used-up"
  /** an allowance is configured and nothing can count against it */
  | "uncountable"

export type RunGate =
  | {
      open: true
      /** 0 when this deployment does not meter visitor runs at all. */
      limit: number
      /** null when unmetered — no count was taken, and none is claimed. */
      used: number | null
      remaining: number | null
    }
  | {
      open: false
      reason: GateReason
      /**
       * The status `POST /api/map` answers with.
       *
       * It lives here rather than in the route so the page and the endpoint
       * cannot disagree about the same refusal — one function decides, both
       * read it. 403 for read-only (nothing failed; the deployment is
       * configured to refuse, forever, which is what 403 means). 429 for a
       * spent allowance (a real rate limit, and "try tomorrow" is true). 503
       * for uncountable (the deployment intends to allow this and cannot
       * currently tell, which is the one case where coming back later helps).
       */
      status: 403 | 429 | 503
      /** One sentence for a human, in a body and on a page. */
      refusal: string
      limit: number
      remaining: number
    }

/**
 * Ask whether a run may start right now.
 *
 * FAILS CLOSED, on the same principle the spend ceiling in the map route
 * already states: a reading it could not take is not a licence to spend. If the
 * allowance is set and the store cannot be reached to count against it, this
 * refuses — which also means a public deployment REQUIRES Supabase, since an
 * in-process counter forgets every run started by another instance and resets
 * on every restart. DEPLOY.md already tells a Vercel operator that the store is
 * not optional; this is the second reason.
 *
 * Costs nothing on a deployment that does not meter. The count is taken only
 * when a limit is set, so the ordinary private deployment — the overwhelming
 * majority, including every clone and every dev server — reaches no network at
 * all on its way through here.
 */
export async function runGate(now: number = Date.now()): Promise<RunGate> {
  const limit = publicRunsPerDay()

  if (limit === 0) {
    // No allowance configured. Two deployments arrive here and they want
    // opposite answers: a demo is a closed door (today's behaviour, unchanged
    // and byte for byte the same refusal), and everything else is an ordinary
    // unmetered deployment behind a password (also unchanged). Neither reads
    // the store.
    if (!isDemo()) return { open: true, limit: 0, used: null, remaining: null }
    return {
      open: false,
      reason: "read-only",
      status: 403,
      refusal: DEMO_REFUSAL,
      limit: 0,
      remaining: 0,
    }
  }

  // COUNTS RUNS STARTED, not dollars spent, and not runs that succeeded.
  //
  // A run that failed at minute three still bought its searches, so counting
  // outcomes would let a bad afternoon spend several times the allowance. A run
  // is the unit the deployment actually controls — it sizes itself to the
  // function clock before it starts — and at $0.147 to $0.202 measured, N runs
  // is N × about twenty cents whatever happens to them. `OPENKB_CEILING_USD` is
  // still the backstop underneath in dollars; this is the one a visitor can be
  // told a number from.
  const used = await db.countRunsSince(dayStartedAt(now).toISOString())
  if (used === null) {
    return {
      open: false,
      reason: "uncountable",
      status: 503,
      refusal:
        `This deployment runs ${limit} ${limit === 1 ? "map" : "maps"} a day for visitors, but it ` +
        `cannot reach the database that counts them — so it is not starting one it could not count.`,
      limit,
      remaining: 0,
    }
  }

  const remaining = Math.max(0, limit - used)
  if (remaining === 0) {
    return {
      open: false,
      reason: "used-up",
      status: 429,
      refusal:
        `This deployment pays for ${limit} ${limit === 1 ? "map" : "maps"} a day and today's ` +
        `${limit === 1 ? "one is" : "are"} spent. The count resets at 00:00 UTC, in ${untilReset(now)}. ` +
        `Every map already here is a finished run and opens now.`,
      limit,
      remaining: 0,
    }
  }

  return { open: true, limit, used, remaining }
}

/* ------------------------------------------- the door that was NOT built here
 *
 * BRING YOUR OWN KEYS was considered for this and rejected, and the reasoning
 * belongs next to the thing it lost to.
 *
 * The pitch is unanswerable on cost: a visitor pastes their own credentials,
 * the run bills them, and the owner's exposure is zero — no allowance, no
 * counting, no store required, none of this file. What it needs from the
 * visitor is the part that kills it. A run reaches THREE credentials: a Bright
 * Data account with a SERP zone AND an Unlocker zone, plus an OpenRouter key.
 * Almost nobody who has just landed on a demo has one of those, let alone all
 * three, and the ones who do are the ones who would clone the repo anyway. A
 * try-it path that nobody can use is not a try-it path — it is a form that
 * refuses more politely.
 *
 * The door is left open. Nothing above assumes the owner's keys: `runGate` asks
 * whether THIS DEPLOYMENT may spend, which is exactly the question that answers
 * itself differently for a visitor who brought their own. When that day comes
 * it is a branch here and a credential source in the map route, not a rewrite.
 */
