import type { Span, SpendTrip } from "../packages/core/src/index.js"

/**
 * WHAT A RUN FROM A TERMINAL MAY COST, and what a night of them may cost.
 *
 * `packages/web/lib/spend-limits.ts` is this file's opposite number: it answers
 * the same question for the deployment, where a stranger is spending the owner's
 * money and four limits are claimed in one transaction before a run may start.
 * Nothing here is claimed against anything — a CLI run spends the operator's own
 * key, and the only failure being engineered against is the one where they walk
 * away. Both files hand their number to the same watchdog, `withSpendCap` in
 * `@open-kb/core`, which is what makes "the cap fired" mean the same thing on
 * every surface.
 *
 * WHAT WAS BROKEN, measured over the run files in `runs/`:
 *
 *   scripts/sweep.ts   no dollar bound of any kind. Its own comment said so:
 *                      "There is no live ceiling here… the CLI has nothing like
 *                      it at all." The worst single run on disk cost $6.83
 *                      (brightdata.com, 63 queries, on a dear model); the worst
 *                      at the current default model cost $3.74 (shopify.com, 251
 *                      queries, 1,599s).
 *   scripts/swarm.ts   a ceiling, frozen into the `Ledger` at `runSwarm` — and
 *                      realized spend was never once compared to it.
 *                      `ledger.spentUsd()` is read in three places and all three
 *                      are reporting.
 *   scripts/batch.ts   no bound, and it MULTIPLIES. `spent` was printed and
 *                      never compared, so a 50-domain list projected to $69 at
 *                      the median run and $187 at the worst, with nothing in the
 *                      file able to stop it.
 *
 * ─────────────────────────────────────────────────────────── what a run costs
 *
 * MEASURED, on the 11 runs in `runs/` that are both the current engine shape
 * (they carry `report.kernel`) and the current default model, ignoring one
 * 6-query smoke test:
 *
 *     median  $1.386   (figma.com, 52 queries)
 *     max     $3.736   (shopify.com, 251 queries, 1,599s)
 *
 * The spread is 27× from smallest to largest and that is the whole difficulty:
 * a CLI run has no query budget handed to it, because the engine deals its own
 * hand per product, so these runs range from 6 to 324 queries. The web route can
 * derive a tight cap because `maxDuration` tells it how big the run will be. No
 * such number exists here, so the cap has to clear the LARGEST healthy run
 * rather than a multiple of the median.
 *
 * Two projections that the cap also has to clear, because they are runs that
 * have not been recorded yet rather than runs that cannot happen:
 *
 *     ~$5.37   a cloudflare-shaped run after the product-funding fix. The
 *              measured cloudflare.com run cost $2.956 over 173 queries before
 *              every product the run finds started getting asked about.
 *     $5.15    a brightdata.com run that took 4,195 seconds on a dear model.
 */

/* ────────────────────────────────────────────────────────────── the per-run cap
 *
 * $8.00, AND IT IS DELIBERATELY LOOSE.
 *
 * A default that fires on a normal run is worse than no default, because the
 * operator disables it and then has nothing. Sized from the numbers above:
 *
 *     trip point           $6.00  (the cap less the reserve core holds back)
 *     worst measured run   $3.736 — the trip clears it by 61%
 *     worst projection     ~$5.37 — the trip clears it by 12%
 *
 * So no run this repo has recorded, and no run its measured trajectory predicts,
 * is stopped by this. What it stops is a run that has genuinely gone wrong: 2.1×
 * the worst healthy run.
 *
 * WHAT IT WOULD AND WOULD NOT HAVE CAUGHT, stated exactly, because the round
 * number invites a rounder claim than the data supports. The $6.83 run is
 * stopped at $6.00, with 12% of its bill unspent. The $5.15 run is NOT — and the
 * reason is worth more than the cap is. That run cost LESS than a healthy
 * big-market run is projected to cost ($5.15 against $5.37), so no dollar figure
 * separates the two: by the only measure a spend watchdog has, a dear model
 * doing a little work and the default model doing a lot are the same run. What
 * separates them is the price per call, which no cap can see. Hence the
 * paragraph below.
 *
 * WHY NOT TIGHTER. The obvious alternative is the web route's shape — 2× the
 * median, which is $2.77 — and it would have killed shopify.com at 74% done,
 * having spent $2.77 for nothing. That is the worst outcome this file can
 * produce, and it is strictly worse than not having a cap: an aborted run's
 * money is gone and buys no map, whereas an unbounded run at least produces
 * something for what it spent. The asymmetry is why every number here errs high.
 *
 * WHY NOT LOOSER, e.g. $10 or "off". The trip point has to stay under the worst
 * thing that has actually happened, and $6.83 is that. A $10 cap trips at $7.50
 * and every run on disk finishes underneath it, which is a cap that has never
 * bound anything.
 *
 * FOR A DEARER MODEL, RAISE IT. Two runs in `runs/` on a large model billed
 * $0.0837 and $0.0419 a query against the current default's ~$0.011, so
 * `OPENKB_MODEL` set to something big makes every number above wrong in the
 * expensive direction and this cap will fire on a healthy run. Set
 * `OPENKB_CLI_RUN_CAP_USD` to about 4× whatever you would otherwise expect, or
 * to `off`.
 */
export const DEFAULT_RUN_CAP_USD = 8

/* ───────────────────────────────────────────────────────────── the per-list cap
 *
 * $50.00, AND IT IS DELIBERATELY TIGHT — the opposite choice from the one above,
 * for one reason: STOPPING A LIST COSTS NOTHING AND STOPPING A RUN COSTS THE
 * RUN.
 *
 * A run aborted at its cap has spent its money and has no map to show for it, so
 * the per-run cap has to be sized never to fire on healthy work. A LIST stopped
 * between domains has lost nothing at all: every map already built is on disk,
 * every outcome is in the manifest, and `--resume <manifest>` picks up exactly
 * what is still owed. So the list cap is a budget rather than a brake, and the
 * right default for a budget is what an operator is willing to find already
 * spent when they wake up — not the largest number that cannot be wrong.
 *
 * $50 buys about 36 maps at the measured median and about 13 at the worst
 * measured run. Against the exposure it replaces — a 50-domain list projecting
 * to $69-$187, unbounded — it is between a quarter and a third of one night.
 *
 * WHAT TO SET IT TO FOR A BIG LIST. Budget the WORST measured run per domain,
 * because a list long enough to leave running unattended will contain one:
 *
 *     N domains × $3.74 + one run cap per worker
 *
 * `scripts/gallery-domains.txt` holds 79 domains, so a full gallery build wants
 * `OPENKB_BATCH_CAP_USD=310`. At the median it will cost about $110 of that. The
 * cheaper habit is to leave the default alone and resume: the batch stops
 * itself, prints the exact resume command, and the next $50 costs one more line
 * of typing.
 */
export const DEFAULT_LIST_CAP_USD = 50

/**
 * How far above the swarm's own ceiling its watchdog sits: 2.
 *
 * THE SWARM IS THE ONE ENTRYPOINT THAT ALREADY HAS A NUMBER, and this cap must
 * be derived from it rather than from the table above. `runSwarm` is handed a
 * `ceilingUsd` (the CLI defaults it to $1.50) and the `Ledger` splits it at t=0
 * into a finish reserve and a work pool. A flat $8 would never fire under a
 * $1.50 ceiling, which makes it decoration; a flat $2 would fire on every run of
 * a $5 ceiling, which makes it a bug. The ceiling is the only number that knows
 * how big this particular run was meant to be.
 *
 * WHY THE WATCHDOG IS NOT REDUNDANT WITH THE LEDGER, which is the obvious
 * objection. The ledger RESERVES before a call and the watchdog watches REALIZED
 * spend after it, so they fail in opposite directions. Measured on the 44
 * missions across the swarm runs in `runs/`: 24 settled ABOVE their allowance,
 * the worst at 2.17× — and the ledger cannot prevent that by construction,
 * because `overrunAbort` can only be consulted at a tool boundary with money the
 * caller has already paid. Its own comment says so: it "stops the NEXT call,
 * never the increment that crossed". The ledger keeps the plan honest; this
 * keeps the bill honest.
 *
 * 2, AND NOT LESS, because the ledger is supposed to spend the whole ceiling —
 * that is what a ceiling is for. Anything close to 1× would fire on a run that
 * was working exactly as designed. 2× the ceiling leaves the sum of every
 * mission overrun the run can accumulate ($0.03 to $0.45 an allowance, worst
 * case 2.17×) inside the cap, and still stops a swarm that has doubled its own
 * brief.
 */
export const SWARM_CAP_HEADROOM = 2

/** The variables an operator sets, spelled once. Quoted by the refusals below
 *  and by the comments in all three entrypoints; a limit whose name is written
 *  in five places is a limit that gets renamed in four. */
export const CLI_LIMIT_VARS = {
  runCap: "OPENKB_CLI_RUN_CAP_USD",
  listCap: "OPENKB_BATCH_CAP_USD",
} as const

/**
 * The one spelling that turns a cap off. A word, not a number, so that no typo,
 * empty string or stray space can produce it by accident.
 */
const OFF = "off"

export type CapReading = { ok: true; capUsd: number | null } | { ok: false; why: string }

/**
 * A cap from the environment: a number, deliberately off, or a value nobody can
 * act on.
 *
 * THE THIRD CASE IS THE POINT, and it is `lib/spend-limits.ts`'s argument
 * repeated here because the failure is identical on this side. `Number("$5")` is
 * `NaN`; `NaN > 0`, `NaN >= 0` and `NaN < 0` are all false, so every obvious
 * guard written against it waves the run through. A malformed cap is not a
 * missing cap — it is an operator who believes they set one — and the only safe
 * reading is to refuse and say so.
 *
 * DELIBERATELY NOT A SEPARATE NAME PER ENTRYPOINT. `OPENKB_CLI_RUN_CAP_USD`
 * covers the sweep, the swarm and every child the batch spawns, because "what
 * one run of anything may cost" is one idea. It is also deliberately NOT
 * `OPENKB_RUN_CAP_USD`, which the deployment reads: the documented way to run
 * any of these scripts is `set -a && . ./.env && set +a`, so a deployment's
 * $0.41 sitting in `.env` would silently abort every CLI run on its first
 * minute's spending.
 */
export function readCapUsd(name: string, fallback: number): CapReading {
  const raw = process.env[name]
  // Unset, empty or whitespace is the operator saying nothing, so the default
  // applies. `Number(" ")` is 0, which is why this test comes before any parse:
  // a stray space would otherwise read as "spend nothing" and abort instantly.
  if (raw === undefined || raw.trim() === "") return { ok: true, capUsd: fallback }
  const text = raw.trim()
  if (text.toLowerCase() === OFF) return { ok: true, capUsd: null }
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      why:
        `${name} is ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}, which is ` +
        `not an amount in dollars. Write a plain number, e.g. ${fallback} — no $ sign — or the ` +
        `word "${OFF}" to remove the cap.`,
    }
  }
  return { ok: true, capUsd: n }
}

/**
 * The cap, or a refusal printed and exited on.
 *
 * FAILS CLOSED, which for a CLI means refusing to start rather than starting
 * unbounded. Exit 2 is what every other argument-shaped refusal in `scripts/`
 * uses, so a wrapper can already tell it from a run that failed.
 */
export function capUsdOrExit(name: string, fallback: number): number | null {
  const reading = readCapUsd(name, fallback)
  if (!reading.ok) {
    console.error(reading.why)
    process.exit(2)
  }
  return reading.capUsd
}

/* ──────────────────────────────────────────────── how a capped run is recorded
 *
 * A RUN THAT IS STOPPED MUST END THE WAY A DELIBERATE STOP ENDS, and the failure
 * being fixed is a silent disappearance. The web route already had this: it
 * writes a failed row carrying an app-authored sentence, so a visitor sees a
 * partial map and an explanation rather than a spinner that never resolves. The
 * CLI equivalent is a file — the sweep and the swarm each write their run to
 * `runs/` and the operator reads it later — so a stop that wrote nothing would
 * be indistinguishable from a crash, from a `^C`, and from a machine that went
 * to sleep, having spent up to a full cap.
 *
 * WHY THIS IS BUILT HERE AND WRITTEN THERE, i.e. why `withSpendCap`'s `record`
 * callback in both scripts only remembers the trip instead of writing the file.
 * The engine is still unwinding when the watchdog fires. Its last spans have not
 * landed, its span stream is not closed, and — if the abort arrives during the
 * link phase, the one phase that skips rather than throws — it may yet return a
 * complete map. Writing at trip time would record a shorter run than the one
 * that actually happened, and would race the process's own tail. A CLI has no
 * platform about to kill it mid-write, which is the only thing that forces the
 * web route to record inside the watchdog; here the correct moment is after the
 * engine has finished unwinding, with every span in hand.
 *
 * DELIBERATELY NOT SHAPED LIKE A MAP. `adoptCliRun` in `packages/web/lib/runs.ts`
 * adopts any `runs/sweep-*.json` or `runs/swarm-*.json` carrying an `anchor` and
 * an `entities` array into the gallery. This record has neither field and its
 * own filename prefix, so no reader can mistake a stopped run for an empty map
 * of a market.
 */

/** What `runs/stopped-<domain>-<stamp>.json` holds. */
export interface StoppedRun {
  stopped: {
    by: "run-cap"
    /** The variable that would change this outcome. */
    setting: string
    capUsd: number
    tripUsd: number
    heldBackUsd: number
    spentUsd: number
    /** The sentence, so the file explains itself without this code. */
    reason: string
    at: string
  }
  engine: "sweep" | "swarm"
  domain: string
  /** Named `stats` because every other run file in `runs/` calls it that, and an
   *  operator grepping `stats.usd` across a night should find this one too.
   *
   *  `usd` is the FINAL total, which is not `stopped.spentUsd`: the reserve
   *  exists precisely because calls already in flight when the line was crossed
   *  still land and still bill. The gap between the two numbers is what the
   *  reserve was sized against, measured on a real run rather than argued. */
  stats: { usd: number; seconds: number; spans: number }
  /** Whatever the engine could still say about itself as it stopped. The swarm
   *  attaches a full `ending` to its abort — nodes, edges, residue, and what it
   *  would have done next — and throwing that away would be discarding the most
   *  useful thing in the file. */
  ending?: unknown
  /** Intact, and this is half the point of writing anything: the spans are the
   *  only record of what the money was actually spent on. */
  spans: Span[]
}

/** The sentence a stopped run carries, wherever it is read. It names the cap,
 *  what was spent, and the one setting that changes the outcome — the same three
 *  things `namedFaults.runCostCeiling` puts in front of a visitor on the web. */
export function cappedReason(trip: SpendTrip, engine: "sweep" | "swarm"): string {
  return (
    `the ${engine} was stopped at $${trip.spentUsd.toFixed(4)} because one run here may cost ` +
    `$${trip.capUsd.toFixed(2)} — it crossed the $${trip.tripUsd.toFixed(2)} trip point and ` +
    `$${trip.heldBackUsd.toFixed(2)} was held back so this ending could be written. Nothing is ` +
    `broken and the domain is not the problem: the cap is deliberate. Raise ` +
    `${CLI_LIMIT_VARS.runCap} or set it to "${OFF}" to run without one.`
  )
}

export function stoppedRun(opts: {
  engine: "sweep" | "swarm"
  domain: string
  trip: SpendTrip
  /** Everything the run had billed by the time it finished unwinding. */
  finalUsd: number
  seconds: number
  spans: readonly Span[]
  ending?: unknown
}): StoppedRun {
  return {
    stopped: {
      by: "run-cap",
      setting: CLI_LIMIT_VARS.runCap,
      capUsd: opts.trip.capUsd,
      tripUsd: opts.trip.tripUsd,
      heldBackUsd: opts.trip.heldBackUsd,
      spentUsd: opts.trip.spentUsd,
      reason: cappedReason(opts.trip, opts.engine),
      at: new Date().toISOString(),
    },
    engine: opts.engine,
    domain: opts.domain,
    stats: { usd: opts.finalUsd, seconds: opts.seconds, spans: opts.spans.length },
    ...(opts.ending === undefined ? {} : { ending: opts.ending }),
    spans: [...opts.spans],
  }
}

/**
 * May another run be STARTED against the list's budget?
 *
 * IT COUNTS RUNS IN FLIGHT AT THEIR CAP, and that is what makes the list cap a
 * ceiling rather than a hope. A run that started ninety seconds ago has spent
 * something and recorded nothing; counting it at zero is how two concurrent
 * runs walk a list's budget past its limit while both read as free. So a run in
 * flight is held against the budget at the most it can still become, and settles
 * to its real cost when it ends. This is `count()` and `claimInMemory()` from
 * `lib/spend-limits.ts` in eight lines instead of a Postgres transaction, and it
 * needs no lock for the same reason that function does not: there is no await
 * between the reading and the decision.
 *
 * THE COST OF BEING A CEILING is that it is pessimistic — the reservation is
 * $8.00 against a median run of $1.386 — so a $50 list stops after roughly $34
 * of settled spend with two workers. That is a fifth of a night held back
 * against runs that will not use it. The alternative is reserving at the median,
 * which is not a ceiling at all: it is a guess that the next run is average, and
 * the whole exposure here is the run that is not.
 *
 * With the run cap off there is nothing to reserve, and the list cap degrades to
 * a check between domains — still a bound, just one that can be overshot by
 * whatever the runs in flight turn out to cost. That is the honest consequence
 * of `OPENKB_CLI_RUN_CAP_USD=off` and the reason the two belong together.
 */
export function listRoom(opts: {
  /** What the runs that have ENDED actually cost. */
  settledUsd: number
  /** How many are running right now. */
  inFlight: number
  /** What one run may cost, or null if that cap is off. */
  runCapUsd: number | null
  /** What the whole list may cost, or null if that cap is off. */
  listCapUsd: number | null
}): { ok: true } | { ok: false; committedUsd: number } {
  if (opts.listCapUsd === null) return { ok: true }
  const reserve = opts.runCapUsd ?? 0
  const committedUsd = opts.settledUsd + opts.inFlight * reserve
  // A whole run's cap has to still fit, not merely a dollar of it — the same
  // test the day cap makes before admitting a run.
  if (committedUsd + reserve > opts.listCapUsd) return { ok: false, committedUsd }
  return { ok: true }
}
