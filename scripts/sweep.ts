/**
 * The sweep, from a terminal.
 *
 * The pipeline itself lives in `packages/sweep`, this file is argv, credentials
 * and a console, nothing else. The web route drives the same function, so what
 * you see here is what the browser runs.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/sweep.ts resend.com [nQueries]
 *         npx tsx scripts/sweep.ts resend.com --quick   # a bounded first look
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

/** `"0"`/`"false"` (case-insensitive) reads as an explicit disable; unset or
 *  anything else leaves a default-on flag standing. Mirrors the "0"/"off"/
 *  "false" disable shape `OPENKB_SWARM_FAMILIES` already uses in swarm.ts. */
const disablesFlag = (raw: string | undefined) => {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "0" || v === "false"
}

// P1-7 (docs/overnight-backlog.md): a user's first run is currently a
// ~28-minute wait (runs/sweep-cursor-com-20260821105321.json) before they see
// anything. `--quick` is argv, not an env var — it is a one-time human choice
// for a first look, not a standing shell setting like the OPENKB_* guards
// below. It is filtered out of argv here so it can sit anywhere on the command
// line without shifting the two positional args past it.
const QUICK = process.argv.includes("--quick")
const positional = process.argv.slice(2).filter((a) => a !== "--quick")

const anchor = positional[0] ?? "resend.com"
// Unset unless a third arg is given — the normal case, and now the same
// default the web route already used (`route.ts`: "undefined is not a bad
// value, it is the normal one now"). Left as a hardcoded `?? 40` here, every
// CLI run silently reactivated the old fixed-quota catalog and the run this
// script exists to validate — every product dealt its own opening hand, the
// spend ceiling as the only brake — could never actually be exercised from a
// terminal. A numeric third arg still bounds a probe exactly as before.
const TARGET = positional[1] !== undefined ? Number(positional[1]) : undefined
const MODEL = process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash-0731"

/**
 * `--quick`'s preset, over `SweepOptions` fields that already exist — no new
 * engine capability, per the backlog item. Both levers are chosen from the
 * SAME measured run the backlog cites:
 *
 *   - `maxHosts` is the estimation stop that ends both the search-widening
 *     loop and the fetch/classify phase early (`HOST_CEILING`, sweep.ts). The
 *     cursor run bought 926 hosts against a default sizing of 900; capping at
 *     a tenth of that cuts the two phases that were 26% + 25% of its wall
 *     time (search+widening, classify) roughly proportionally.
 *   - `skipModelLinking: true` drops the paid link pass entirely — 43% of
 *     that same run's wall time (12.3 of 28.5 minutes), the single biggest
 *     phase. The free naming pass (pages that name another player outright)
 *     still runs, so a quick map still carries edges, just fewer of them.
 *
 * An explicit `OPENKB_MAX_HOSTS`/`OPENKB_SKIP_MODEL_LINKING` still wins over
 * this preset below — `--quick` fills gaps, it does not override a setting
 * the operator already made.
 */
const QUICK_MAX_HOSTS = 90

if (QUICK) {
  console.log(
    `--quick: capping this run at ~${QUICK_MAX_HOSTS} hosts and skipping the paid link pass ` +
      `— a smaller, faster-linked map for a first look. Drop --quick for the full run.`,
  )
}

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
    // UNSET BY DEFAULT, and that is the whole point since variable page depth
    // landed. The engine opens a query at SHALLOW_PAGES (2) and moves a product
    // to DEEP_PAGES (4) only once `assess` has per-page-yield evidence for it —
    // but `DEEP_PAGES` is floored at `SHALLOW_PAGES`, so passing 4 here
    // collapsed the pair and every CLI run bought four pages on everything.
    // MEASURED: both runs on 2026-08-21 recorded `deepenedProducts: []` — the
    // deepen verdict had nothing left to buy, and the feature was inert on the
    // one path a cloner actually uses. Unset restores 2→4.
    //
    // `|| undefined` like the guards below, not `?? undefined` alone:
    // OPENKB_PAGES=abc is NaN and would reach the SERP call as a page count;
    // 0 falls back too, exactly as OPENKB_MAX_HOSTS=0 means "unset".
    pages: Number(process.env.OPENKB_PAGES ?? 0) || undefined,
    // The width floor: rounds before the model's "enough" is accepted. The
    // CLI defaults to 3 — one 'enough' after the opening hand ended a run at
    // 36 queries where its twin ran 87 — because the shipped terminal run is
    // what a cloner judges the tool by. OPENKB_MIN_WAVES=0 restores the
    // model's own judgement.
    minWaves: Number(process.env.OPENKB_MIN_WAVES ?? 3) || undefined,
    // The estimation stop: ~900 distinct hosts lands near ~700 kept nodes,
    // which is already a big map. OPENKB_MAX_HOSTS resizes it; `--quick`
    // fills in a smaller one (QUICK_MAX_HOSTS above) when the env var is
    // unset.
    maxHosts: Number(process.env.OPENKB_MAX_HOSTS ?? 0) || (QUICK ? QUICK_MAX_HOSTS : undefined),
    // Search-wave width. The provider adapter obeys retry-afters, so pushing
    // this is observable-safe: too wide answers as 429s and pacing, never loss.
    concurrency: Number(process.env.OPENKB_SEARCH_CONCURRENCY ?? 0) || undefined,
    skipModelLinking: process.env.OPENKB_SKIP_MODEL_LINKING === "1" || QUICK,
    // `OPENKB_DISCOVERY=agent` runs phase one as the discovery agent instead of
    // the single call — the A/B this flag exists for. Anything else, including
    // unset, is the unchanged default.
    discovery: process.env.OPENKB_DISCOVERY === "agent" ? "agent" : undefined,
    // `triage`, `secondLook` and `listicleHarvest` DEFAULT ON as of
    // 2026-08-22 — each survived the A/B its doc comment describes (see
    // `SweepOptions` in `packages/sweep/src/sweep.ts` for the measured
    // numbers) — so the env var now DISABLES rather than enables:
    // `OPENKB_TRIAGE=0` (or `false`) turns it off, anything else, unset
    // included, leaves the new default standing. `dropConfirm` did not
    // survive its own A/B and stays the odd one out: opt-in,
    // `OPENKB_DROP_CONFIRM=1` still the only way to turn it on.
    triage: disablesFlag(process.env.OPENKB_TRIAGE) ? false : undefined,
    secondLook: disablesFlag(process.env.OPENKB_SECOND_LOOK) ? false : undefined,
    dropConfirm: process.env.OPENKB_DROP_CONFIRM === "1" ? true : undefined,
    listicleHarvest: disablesFlag(process.env.OPENKB_LISTICLE_HARVEST) ? false : undefined,
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

const { writeFileSync, mkdirSync, existsSync } = await import("node:fs")
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
// Narrowed, then closed at the write, and this is the site the other three defer
// to so it says so here. Sixty seconds of exposure became one, which no sweep can
// hit — the shortest on record is 771s — but a time-only stamp cannot do better
// than its resolution, and pretending otherwise is how the minute version read as
// safe for as long as it did. So both writes below now ask `freshStampedPath` for
// a name that does not exist yet, instead of handing `writeFileSync` a taken one
// to overwrite with no error and no log. The other three writers still carry the
// one-second hole; this file no longer does.
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")

// The close itself. packages/web/lib/runs.ts parses the 12-or-14-digit tail of
// these filenames back into `endedAt`, so a taken name must not grow a `-2`
// suffix or a wider stamp — it re-formats one whole second later, same fourteen
// digits, until the name is free. Bounded at 60: past a minute of bumps
// something other than timing owns these names, and the last candidate
// overwrites exactly as every write here did before the loop existed.
const freshStampedPath = (path: string): string => {
  // `toISOString` above wrote the stamp in UTC, so `Z` parses it back exactly.
  const at = Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z"))
  let candidate = path
  for (let bump = 1; existsSync(candidate) && bump <= 60; bump++) {
    const later = new Date(at + bump * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, "")
    // Anchored to the tail, not `replace(stamp, …)`: the slug keeps digits
    // (`\W+` spares them), so a first-occurrence swap could hit the domain.
    candidate = path.replace(/\d{14}(?=\.json$)/, later)
  }
  return candidate
}

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
  const stampedPath = `runs/stopped-${anchor.replace(/\W+/g, "-")}-${stamp}.json`
  const path = freshStampedPath(stampedPath)
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

/**
 * WHERE THE MONEY WENT, and what it was refused by on the way.
 *
 * The headline above is one number; this is the sentence a person needs to
 * decide what to change. On the run that argued for it, SERP was 82% of the
 * bill and the model 18% — so the cost lever is pages and queries, not the
 * model — and 28% of the SERP requests were retries of a refused page, a fact
 * that appeared in no number the run printed.
 */
{
  const report = out!.report as Record<string, unknown>
  const cost = report.cost as { usd: number; byKind: { label: string; calls: number; failures: number; usd: number; ms: number }[] }
  const serp = report.serp as
    | { requests: number; retries: number; pagesPerQuery: number; blocked: Record<string, number>; failed?: Record<string, number> }
    | undefined
  const kernel = report.kernel as { fetched: number; unreadable: number; unreadableByReason: Record<string, number>; unlocked?: number; serpJudged?: number } | undefined
  const pct = (n: number) => `${((100 * n) / (cost.usd || 1)).toFixed(1)}%`

  console.log(`\nspend`)
  for (const l of cost.byKind) {
    console.log(
      `  ${l.label.padEnd(9)} $${l.usd.toFixed(4).padStart(8)}  ${pct(l.usd).padStart(6)}  ` +
        `${String(l.calls).padStart(5)} calls${l.failures ? `, ${l.failures} failed` : ""}`,
    )
  }

  if (serp) {
    // `stats.queries` is the OPENING hand; the widening loop fires more, and
    // `serpCalls` is the only count that already includes them — pricing the
    // ask off the opening said "258 asked for" on a run that asked for 570.
    const asked = stats.serpCalls
    console.log(
      `\nsearch  ${serp.requests} billable requests against ${asked} pages asked for` +
        ` (${Math.round(asked / serp.pagesPerQuery)} queries × ${serp.pagesPerQuery})` +
        (serp.retries ? ` — ${serp.retries} retries, ${((100 * serp.retries) / (serp.requests || 1)).toFixed(0)}% overhead` : ""),
    )
    const blocks = Object.entries(serp.blocked).sort((a, b) => b[1] - a[1]).slice(0, 6)
    for (const [reason, n] of blocks) console.log(`  ${String(n).padStart(4)} × ${reason}`)
    // Retries are the provider letting a query in on the second ask; these
    // are the queries it never let in at all. Printed apart so an account
    // suspension — which is not retried, and so never appears above — is
    // the first line a reader sees rather than a number in the JSON.
    const failed = Object.entries(serp.failed ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
    if (failed.length) {
      const total = failed.reduce((n, [, c]) => n + c, 0)
      console.log(`  ${total} queries failed outright:`)
      for (const [reason, n] of failed) console.log(`  ${String(n).padStart(4)} × ${reason}`)
    }
  }

  // Which upstream hosts answered for the model id, and how often each
  // refused. One model id, ~30 hosts of very different discipline: the
  // host is the first thing to read when refusals climb.
  const model = report.model as { id: string; ignored: string[]; servedBy: Record<string, { calls: number; refused: number }> } | undefined
  if (model && Object.keys(model.servedBy).length) {
    const rows = Object.entries(model.servedBy).sort((a, b) => b[1].calls - a[1].calls)
    console.log(`\nmodel   ${model.id}` + (model.ignored.length ? ` — never routed to ${model.ignored.join(", ")}` : ""))
    for (const [host, r] of rows) {
      console.log(
        `  ${host.padEnd(16)} ${String(r.calls).padStart(5)} calls` +
          (r.refused ? `, ${r.refused} refused (${((100 * r.refused) / r.calls).toFixed(0)}%)` : ""),
      )
    }
  }

  if (kernel) {
    console.log(
      `\nfetch   ${kernel.fetched} hosts read, ${kernel.unreadable} unreadable (${((100 * kernel.unreadable) / (kernel.fetched || 1)).toFixed(1)}%)` +
        (kernel.unlocked ? `, ${kernel.unlocked} escalated to the unlocker` : "") +
        (kernel.serpJudged ? `, ${kernel.serpJudged} judged from their search results instead` : ""),
    )
    for (const [reason, n] of Object.entries(kernel.unreadableByReason).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(n).padStart(4)} × ${reason}`)
    }
  }
}

const stampedPath = `runs/sweep-${anchor.replace(/\W+/g, "-")}-${stamp}.json`
const path = freshStampedPath(stampedPath)
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
