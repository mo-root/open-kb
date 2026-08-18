/**
 * The sweep, from a terminal.
 *
 * The pipeline itself lives in `packages/sweep`, this file is argv, credentials
 * and a console, nothing else. The web route drives the same function, so what
 * you see here is what the browser runs.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/sweep.ts resend.com [nQueries]
 *
 * The run stops itself at $8.00 — see the watchdog below and the numbers behind
 * that figure in `scripts/spend-caps.ts`. `OPENKB_CLI_RUN_CAP_USD` changes it;
 * the word `off` removes it. A stopped run is written to
 * `runs/stopped-<domain>-<stamp>.json` with its spans, and exits 6.
 */
import { openrouter } from "@openrouter/ai-sdk-provider"
import { SpanStream, withSpendCap, type Span, type SpendTrip } from "../packages/core/src/index.js"
import { priceForModel } from "../packages/providers/src/index.js"
import { sweep, readUi, onMap } from "../packages/sweep/src/index.js"
import { EXIT, fatal } from "./fatal.js"
import {
  CLI_LIMIT_VARS,
  DEFAULT_RUN_CAP_USD,
  capUsdOrExit,
  cappedReason,
  stoppedRun,
} from "./spend-caps.js"

const anchor = process.argv[2] ?? "resend.com"
// Unset unless a third arg is given — the normal case, and now the same
// default the web route already used (`route.ts`: "undefined is not a bad
// value, it is the normal one now"). Left as a hardcoded `?? 40` here, every
// CLI run silently reactivated the old fixed-quota catalog and the run this
// script exists to validate — every product dealt its own opening hand, the
// spend ceiling as the only brake — could never actually be exercised from a
// terminal. A numeric third arg still bounds a probe exactly as before.
const TARGET = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined
const MODEL = process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash-0731"

const spans = new SpanStream()
const startedAt = Date.now()

/**
 * THE LIVE CEILING THIS FILE USED TO SAY IT DID NOT HAVE.
 *
 * The comment here read "There is no live ceiling here — the web route's
 * `OPENKB_CEILING_USD` guard is a pre-run refusal, not something that watches a
 * run already in flight, and the CLI has nothing like it at all", and printing
 * the running total on every log line was the whole of the remedy. It made a
 * runaway readable by someone watching the screen; the runs that cost $5.15 and
 * $6.83 both happened with that line in place.
 *
 * `withSpendCap` is the watchdog the web route already runs, lifted into
 * `@open-kb/core` so both surfaces enforce one thing. It subscribes to this
 * stream, and at the trip point it aborts the sweep and hands the trip back
 * here. `scripts/spend-caps.ts` chooses the $8.00 default and defends it against
 * the measured runs.
 */
const RUN_CAP_USD = capUsdOrExit(CLI_LIMIT_VARS.runCap, DEFAULT_RUN_CAP_USD)
const abort = new AbortController()
/** Set by the watchdog, read after the engine has unwound: a trip means this run
 *  has an ending already decided, and the tail of this file writes it. A holder
 *  rather than a bare `let` so that nothing here reads as narrowed to `null` —
 *  the only writer is a callback, and the compiler cannot see into it. */
const capStop: { trip: SpendTrip | null } = { trip: null }
/** A RUN THAT IS ALREADY OVER MUST NOT BE STOPPED. The watchdog reads the span
 *  log through its own cursor, so a span emitted in the run's last moments can
 *  still be waiting to be read when the engine returns — and closing the stream
 *  hands the loop whatever was buffered. Without this, a healthy run whose final
 *  total happens to sit above the trip point would be recorded as capped after
 *  it had already succeeded. Same guard as `record.status !== "running"` on the
 *  web route, spelled for a process that has no run registry. */
const engine = { running: true }

console.log(
  `sweep on ${anchor}: ` +
    (RUN_CAP_USD === null
      ? `no spend cap (${CLI_LIMIT_VARS.runCap} is off)`
      : `stopping at $${RUN_CAP_USD.toFixed(2)} (${CLI_LIMIT_VARS.runCap})`),
)

const out = await withSpendCap(
  sweep({
    domain: anchor,
    queries: TARGET,
    pages: Number(process.env.OPENKB_PAGES ?? 4),
    // The width floor: rounds before the model's "enough" is accepted. The
    // CLI defaults to 3 — one 'enough' after the opening hand ended a run at
    // 36 queries where its twin ran 87 — because the shipped terminal run is
    // what a cloner judges the tool by. OPENKB_MIN_WAVES=0 restores the
    // model's own judgement.
    minWaves: Number(process.env.OPENKB_MIN_WAVES ?? 3) || undefined,
    // Search-wave width. The provider adapter obeys retry-afters, so pushing
    // this is observable-safe: too wide answers as 429s and pacing, never loss.
    concurrency: Number(process.env.OPENKB_SEARCH_CONCURRENCY ?? 0) || undefined,
    skipModelLinking: process.env.OPENKB_SKIP_MODEL_LINKING === "1",
    // `OPENKB_DISCOVERY=agent` runs phase one as the discovery agent instead of
    // the single call — the A/B this flag exists for. Anything else, including
    // unset, is the unchanged default.
    discovery: process.env.OPENKB_DISCOVERY === "agent" ? "agent" : undefined,
    spans,
    creds: {
      token: process.env.BRIGHTDATA_API_TOKEN!,
      serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
      unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
    },
    model: openrouter(MODEL),
    modelId: MODEL,
    pricing: priceForModel(MODEL),
    runId: `cli-${Date.now()}`,
    // The running total still rides on every line. The cap makes it a bound
    // rather than a warning, but the operator watching a run still wants to see
    // where it is against that bound.
    onLog: (line) => console.log(`$${spans.totalUsd().toFixed(3)}  ${line}`),
    signal: abort.signal,
  }).finally(() => {
    engine.running = false
  }),
  {
    spans,
    capUsd: RUN_CAP_USD,
    abort,
    stillRunning: () => engine.running,
    announce: (trip) => console.error(`\n${cappedReason(trip, "sweep")}`),
    // Remembering, not writing. The engine is mid-unwind here and its last spans
    // have not landed; `scripts/spend-caps.ts` argues the timing where the
    // record's shape is defined.
    record: (trip) => {
      capStop.trip = trip
    },
  },
  // A cap stop arrives as the engine's own `aborted` throw. `fatal` would print
  // it as a mystery and exit 1, so this catch takes the stop before `fatal` can
  // have it — everything else is still a genuine failure and still goes there.
).catch((e: unknown) => (capStop.trip ? null : fatal(e, "sweep")))
spans.close()

// Every query the run actually fired, including whatever the widening loop
// drew from reserve or invented after the opening hand — `out.queries` only
// ever carries the OPENING batch (the shape the web route's "planned" panel
// wants), so it undercounts a widened run and there was previously no way to
// grep what a CLI run actually asked. The span log already has one
// "ui:results" span per query (`kind: "searched"`), emitted as the sweep runs
// and never read here before; walked once now that the run has finished and
// the stream is closed, so this drains the whole log instead of racing it.
const searched: Record<string, unknown>[] = []
const spanRows: Span[] = []
for await (const span of spans.stream()) {
  spanRows.push(span)
  const ui = readUi(span)
  if (ui?.ns === "results" && ui.frame.kind === "searched") searched.push(ui.frame)
}

const { writeFileSync, mkdirSync } = await import("node:fs")
mkdirSync("runs", { recursive: true })

// Stamped, because the filename used to be the domain alone and a second run of
// the same company silently destroyed the first. A 771-second, $1.26, 388-entity
// map of brightdata.com was overwritten by a 10-query smoke test that happened to
// name the same domain. Maps are expensive and slow; nothing that costs a dollar
// and thirteen minutes should be deleted by a command that does not say "delete".
//
// Seconds, not minutes, and the margin is why. `runs/` holds 53 stamped maps: the
// closest two of one domain landed 2 minutes apart, 11 of the 53 finished inside
// 2 minutes, and the fastest sweep on disk ran 49.6s. So a minute-wide stamp was
// one fast pair away from re-opening the hole it was added to close — and
// scripts/bakeoff.ts is the caller aimed straight at it, because it sweeps ONE
// domain once per contestant back to back. There the collision is worse than an
// overwrite: the second run reuses the first one's name, so it never appears in
// bakeoff's before/after diff of runs/ and lands in the results table as "no
// file" — a contestant that finished, reported as a contestant that produced
// nothing.
//
// Four scripts write the line below and all four must keep writing it
// byte-identically — swarm.ts, demo-investigate.ts and bakeoff.ts are the others,
// b6ffd99 and fbb67b9 both exist to keep them one spelling, and runs.test.ts now
// asserts it. Deliberately not quoting the grep that checks it: the pattern would
// match this comment and report the drift it was meant to catch.
//
// Widening it is also a change to a READER. packages/web/lib/runs.ts recovers a
// CLI run's end time from these digits and used to want exactly twelve of them,
// so fourteen would have matched nothing — not thrown, matched nothing — and
// silently dated every new run to whenever the gallery was loaded rather than
// when it ran. It takes both widths now, and the 53 stamped files already on disk
// still parse to the instant they always did.
//
// Narrowed, not closed, and this is the site the other three defer to so it says
// so here. Two writes inside one second still overwrite: `writeFileSync` with no
// existsSync check, no error, no log. Sixty seconds of exposure became one, which
// no sweep can hit — the shortest on record is 771s — but a time-only stamp
// cannot do better than its resolution, and pretending otherwise is how the
// minute version read as safe for as long as it did.
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")

/**
 * THE ENDING OF A RUN THAT WAS STOPPED AT ITS CAP.
 *
 * Written here rather than in the watchdog because the spans above are only
 * complete now — see `stoppedRun` in scripts/spend-caps.ts. Its own prefix, so
 * the gallery cannot read a stopped run as an empty map, and so a night's
 * `runs/` directory says at a glance which domains were cut off.
 *
 * `out` IS STILL CHECKED, and this is not belt-and-braces. The link phase skips
 * on an aborted signal instead of throwing — deliberately, because by then every
 * entity is found, judged and cited and the edges are an enrichment on top of a
 * map that already exists. So a cap that trips during linking gives back a real
 * map with fewer edges, and that map is worth writing as a map. Only a stop that
 * left nothing to write takes the branch below.
 */
if (out === null && capStop.trip) {
  const path = `runs/stopped-${anchor.replace(/\W+/g, "-")}-${stamp}.json`
  writeFileSync(
    path,
    JSON.stringify(
      stoppedRun({
        engine: "sweep",
        domain: anchor,
        trip: capStop.trip,
        finalUsd: spans.totalUsd(),
        seconds: (Date.now() - startedAt) / 1000,
        spans: spanRows,
      }),
      null,
      2,
    ),
  )
  console.log(`\n${"=".repeat(80)}`)
  console.log(cappedReason(capStop.trip, "sweep"))
  console.log(
    `\n$${spans.totalUsd().toFixed(4)} spent in total — $${(spans.totalUsd() - capStop.trip.spentUsd).toFixed(4)} ` +
      `of it by calls already in flight when the cap fired, which is what the reserve is for.`,
  )
  console.log(`\nwrote ${path} (${spanRows.length} spans, ${searched.length} queries logged)`)
  // Not `fatal`: nothing failed. A caller — scripts/batch.ts above all — needs to
  // tell "this run cost what it was allowed to cost" from "this run broke",
  // because the first must not be retried and the second should be.
  process.exit(EXIT.capped)
}

const { stats, entities } = out!
// The engine's own predicate, not a local guess: `relation: none` leaves the
// map exactly as `kind: noise` does, and a summary filtering only noise said
// "765 on the map" over a map that kept 531.
const keep = entities.filter(onMap)
const offMap = entities.length - keep.length
const noise = entities.filter((e) => e.kind === "noise").length
const count = (arr: string[]) => arr.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})

console.log(`\n${"=".repeat(80)}`)
console.log(
  `${keep.length} on the map from ${stats.hosts} hosts ` +
    `(${offMap} left it: ${noise} noise, ${offMap - noise} judged to be in a different market)`,
)
console.log(`kinds     `, count(keep.map((e) => e.kind)))
console.log(`relations `, count(keep.map((e) => e.relation)))
console.log(`\n${stats.queries} queries · ${stats.serpCalls} SERP calls · ${stats.results} results`)
console.log(`tokens ${stats.tokIn.toLocaleString()} in / ${stats.tokOut.toLocaleString()} out`)
console.log(`$${stats.usd.toFixed(4)} · ${stats.seconds.toFixed(0)}s`)

const path = `runs/sweep-${anchor.replace(/\W+/g, "-")}-${stamp}.json`
writeFileSync(path, JSON.stringify({ ...out, searched }, null, 2))
console.log(`\nwrote ${path} (${searched.length} queries logged)`)

// A MAP THAT WAS STILL STOPPED. Only reachable when the cap fired during the
// link phase, which skips on an aborted signal rather than throwing, so the
// engine returned everything it had found with some pairs left unlinked. The map
// above is real and is written as a map; this says why it has fewer edges than
// it would have had, and exits `capped` so a batch does not retry a domain that
// will cost the same cap again.
if (capStop.trip) {
  console.log(`\n${cappedReason(capStop.trip, "sweep")}`)
  console.log(`The map above is complete; the cap stopped it while it was linking.`)
  process.exit(EXIT.capped)
}
