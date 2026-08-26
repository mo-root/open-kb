/**
 * The swarm, from a terminal.
 *
 * The orchestrator lives in `packages/swarm`; this file is argv, credentials,
 * models and a console, nothing else — the sweep CLI's voice, pointed at the
 * swarm. What you see here is what any future web route will drive.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/swarm.ts brightdata.com [ceilingUsd] [--from-sweep runs/sweep-….json]
 *
 * Ceiling defaults to $1.50 — the design's reference budget, split at t=0
 * into the finish reserve and the work pool by the ledger itself. The wall
 * defaults to 600s, overridable via OPENKB_SWARM_WALL (ms) — reasons at the
 * constant below.
 *
 * Underneath the ledger's ceiling there is now a hard stop at TWICE it, watching
 * realized spend rather than reservations — the overruns the ledger structurally
 * cannot catch. `OPENKB_CLI_RUN_CAP_USD` overrides it, `off` removes it, and a
 * run stopped by it is written to `runs/stopped-<domain>-<stamp>.json` with its
 * spans and its ending. The watchdog below argues all of it.
 *
 * --from-sweep <path>: the sweep→swarm handoff. Loads a prior sweep run of
 * the SAME domain (validated; a different market is refused by name) and
 * seeds the board from it when orientation lands: peek missions that verify
 * the sweep's head on the vendors' own pages, read missions that chase what
 * the sweep left unknown, and a recall-gap mission when the sweep's own
 * probes say the map under-reached. The sweep run is context — the mission
 * brief — never imported claims: the swarm's map starts empty and re-proves
 * everything it keeps.
 *
 * The family floor (code-seeded family missions pushed when orientation
 * lands) defaults ON at 4; OPENKB_SWARM_FAMILIES sizes or disables it:
 * "0" / "off" / "false" disables, "1".."5" sizes, anything else keeps the
 * library default. Under --from-sweep the unset default flips OFF — the
 * sweep already asked the family questions; set OPENKB_SWARM_FAMILIES to
 * force it back on.
 *
 * Models come from OPENKB_MODEL-style envs, one per tier, ids as OpenRouter
 * spells them. The agents themselves never see these names — tiers are the
 * only words cost has inside the run:
 *
 *   OPENKB_SWARM_LEAD_MODEL   default deepseek/deepseek-v4-flash — the one
 *     growing transcript; its input price is what matters, and the design
 *     measured ~$0.10 per run on a lead model dearer than this default. Live
 *     run 3 (runs/swarm-brightdata-com-202608060151.json) watched this default
 *     sit 14 spawn-less, finish-less turns on a dry board with the scorecard
 *     armed — a stronger lead is this one env var away.
 *   OPENKB_SWARM_PEEK_MODEL   default deepseek/deepseek-v4-flash —
 *     verification and demotion, the cheapest honest look.
 *   OPENKB_SWARM_READ_MODEL   default OPENKB_MODEL, then deepseek/deepseek-v4-flash.
 *   OPENKB_SWARM_DIG_MODEL    default OPENKB_MODEL, then deepseek/deepseek-v4-flash.
 *
 * Pricing is accounting only — a wrong number makes the cost readout wrong,
 * never the run. Every tier is priced through `priceForModel` in
 * `@open-kb/providers`, which is the only table in the repo; an id it has not
 * met prices at the dearest row rather than a flattering guess.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { openrouter } from "@openrouter/ai-sdk-provider"
import {
  SpanStream,
  composePrompt,
  withSpendCap,
  type Span,
  type SpendTrip,
} from "../packages/core/src/index.js"
import { brightDataFetch, brightDataSearch, priceForModel } from "../packages/providers/src/index.js"
import {
  fromSweepArgv,
  runSwarm,
  serializeSwarmRun,
  validateSweepRun,
  type SweepRunLike,
} from "../packages/swarm/src/index.js"
import { EXIT, fatal } from "./fatal.js"
import {
  CLI_LIMIT_VARS,
  SWARM_CAP_HEADROOM,
  capUsdOrExit,
  cappedReason,
  stoppedRun,
} from "./spend-caps.js"

// The AI SDK's warning hook, installed as a function: real SDK warnings still
// print (prefixed, once per event), while the OpenRouter provider's per-turn
// "reasoning_details entries were removed" console spam — emitted only when NO
// custom logger is installed — stays off the run log. Live run 1 buried its 55
// useful lines under 32 copies of it. Errors are untouched; warnings reroute.
Object.assign(globalThis, {
  AI_SDK_LOG_WARNINGS: (o: { warnings: Array<{ message?: string }> }) => {
    for (const w of o.warnings) console.warn(`[ai-sdk] ${w.message ?? JSON.stringify(w)}`)
  },
})

/**
 * The wall clock, in ms, off `OPENKB_SWARM_WALL` — pulled out of the inline
 * `Number(...) || fallback` the same way `readCapUsd`/`capUsdOrExit` split in
 * scripts/spend-caps.ts, so the fallback-on-non-positive arithmetic has a
 * place to be asserted without importing the whole module: at top level this
 * file reads credentials and spends real money, which is exactly what the
 * `invokedDirectly` guard below exists to keep out of a test process.
 */
export function wallClockMsFromEnv(raw: string | undefined): number {
  const n = Number(raw ?? 600_000)
  return Number.isFinite(n) && n > 0 ? n : 600_000
}

/**
 * The family floor, off `OPENKB_SWARM_FAMILIES` — same split as
 * `wallClockMsFromEnv` above. `undefined` keeps the library default (ON at
 * 4); "0"/"off"/"false" disables; "1"-"5" sizes it (the library clamps to its
 * 5-template deck); anything else unrecognised also keeps the library default.
 */
export function familyFloorFromEnv(raw: string | undefined): boolean | number | undefined {
  const s = (raw ?? "").trim().toLowerCase()
  if (s === "") return undefined
  if (s === "off" || s === "false") return false
  if (s === "on" || s === "true") return true
  return Number.isFinite(Number(s)) ? Number(s) : undefined
}

/* --------------------------------------------------------------------- main */

// Body left un-indented after the `invokedDirectly` guard, the same choice
// bench.ts/batch.ts made wrapping a pre-existing body: re-indenting the whole
// thing would bury this diff's real change (the extraction above) under a
// column shift on every line.
const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {

const argv = fromSweepArgv(process.argv.slice(2))
if (argv.problem) {
  console.error(argv.problem)
  process.exit(1)
}
const domain = argv.rest[0] ?? "resend.com"
const ceilingUsd = argv.rest[1] !== undefined ? Number(argv.rest[1]) : 1.5

/** The handoff's run file, loaded and validated here — the library never
 *  reads disk. A file that is not a sweep run of THIS domain is refused
 *  before any money moves. */
let fromSweep: SweepRunLike | undefined
if (argv.path) {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(argv.path, "utf8"))
  } catch (e) {
    console.error(`could not read ${argv.path}: ${(e as Error).message}`)
    process.exit(1)
  }
  const v = validateSweepRun(raw, domain)
  if (!v.ok) {
    console.error(`--from-sweep refused: ${v.reason}`)
    process.exit(1)
  }
  fromSweep = v.run
  console.log(`seeding from sweep ${argv.path}: ${fromSweep.entities.length} entities in the brief`)
}

/**
 * The wall: 600s default, overridable via OPENKB_SWARM_WALL (milliseconds).
 * The library default is still 300s; this CLI overrides it because the live
 * runs measured that wall as half a map: 300s with the old 45/90/150s tier
 * deadlines produced runs/swarm-brightdata-com-202608052348.json — 8 nodes at
 * 288s with $3.55 of $5.00 unspent — and 4 of the 5 read missions across both
 * live runs (that file and runs/swarm-resend-com-202608052353.json) died
 * `timeout` at their deadline. Measured investigator turns run 2-20s of model
 * latency with 25-40s SERP waves inside them; the measured tier deadlines
 * (60/180/300s) need a wall that can hold a dig plus the lead's own closing.
 */
const wallClockMs = wallClockMsFromEnv(process.env.OPENKB_SWARM_WALL)

/**
 * The family floor, from the environment. Undefined keeps the library default
 * (ON at 4); "0"/"off"/"false" disables; a number 1-5 sizes it (the library
 * clamps to its 5-template deck).
 */
const familyFloor = familyFloorFromEnv(process.env.OPENKB_SWARM_FAMILIES)

const LEAD = process.env.OPENKB_SWARM_LEAD_MODEL ?? "deepseek/deepseek-v4-flash-0731"
const PEEK = process.env.OPENKB_SWARM_PEEK_MODEL ?? "deepseek/deepseek-v4-flash-0731"
const READ = process.env.OPENKB_SWARM_READ_MODEL ?? process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash-0731"
const DIG = process.env.OPENKB_SWARM_DIG_MODEL ?? process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash-0731"

const skill = readFileSync(new URL("../prompts/swarm/skill.md", import.meta.url), "utf8")

// The harvest tier's doctrine: the SAME classify.md the sweep renders,
// composed here and handed in as text the way the skill is — the library
// never reads disk. This is what arms the investigators' harvest tool.
const promptsDir = fileURLToPath(new URL("../prompts", import.meta.url))
const classifyPrompt = composePrompt("classify", join(promptsDir, "agents"), join(promptsDir, "doctrine"))

const creds = {
  token: process.env.BRIGHTDATA_API_TOKEN!,
  serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
  unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
}

const spans = new SpanStream()
const startedAt = Date.now()

// The span stream, kept: run 1's spans died with the process, and "did the
// lead ever attempt a spawn" became unanswerable an hour later. Every span —
// model turns, SERP rows, fetches, tool calls with their why — collects here
// and writes beside the run JSON as JSONL.
const spanRows: Span[] = []
const spanPump = (async () => {
  for await (const s of spans.stream()) spanRows.push(s)
})()

/**
 * THE CAP THE LEDGER CANNOT BE.
 *
 * `ceilingUsd` above is real and the `Ledger` is not decoration — it reserves
 * every mission's allowance out of the pool before the mission runs, and it
 * refuses the ones that do not fit. What it cannot do is enforce, because it
 * only ever sees money that has ALREADY BEEN PAID: `overrunAbort` is consulted
 * at a tool boundary with the caller's own figure, so by its own comment it
 * "stops the NEXT call, never the increment that crossed". Measured across the
 * 44 missions in the swarm runs in `runs/`: 24 settled above their allowance,
 * the worst at 2.17×. And `ledger.spentUsd()` — the realized total — is read in
 * exactly three places in this codebase, all three of them reporting.
 *
 * So this watches realized spend and the ledger plans against reservations.
 * They catch different failures and neither replaces the other.
 *
 * DERIVED FROM THE CEILING, not from the flat CLI default: a run told to spend
 * $1.50 and a run told to spend $5.00 are different sizes of run, and only this
 * ceiling knows which one this is. `SWARM_CAP_HEADROOM` in scripts/spend-caps.ts
 * argues the multiple. `OPENKB_CLI_RUN_CAP_USD` overrides it outright.
 */
const RUN_CAP_USD = capUsdOrExit(CLI_LIMIT_VARS.runCap, SWARM_CAP_HEADROOM * ceilingUsd)
const abort = new AbortController()
/** A holder, not a bare `let`: the only writer is the watchdog's callback and
 *  the compiler cannot see into it. */
const capStop: { trip: SpendTrip | null; ending: unknown } = { trip: null, ending: undefined }
/** A run that is already over must not be stopped; scripts/sweep.ts carries the
 *  argument. It matters more here, because this run ends by DRAINING — every
 *  in-flight mission is awaited and settled after the last decision — so the
 *  gap between "the orchestrator has finished" and "the spans have stopped
 *  arriving" is wider than a sweep's. */
const engine = { running: true }

console.log(
  RUN_CAP_USD === null
    ? `spend cap off (${CLI_LIMIT_VARS.runCap}); the ledger's $${ceilingUsd.toFixed(2)} ceiling is the only bound`
    : `spend cap $${RUN_CAP_USD.toFixed(2)} on a $${ceilingUsd.toFixed(2)} ceiling (${CLI_LIMIT_VARS.runCap})`,
)

// Every line wears the running total the span stream has actually billed —
// model turns via the runner's hooks, SERP rows and fetches at the port —
// so "did this just blow past the ceiling" is read off the screen, not
// guessed. The ledger plans; the cap above enforces; this shows.
const run = await withSpendCap(
  runSwarm({
    domain,
    ceilingUsd,
    wallClockMs,
    // Lane count. Six was the design's number; the env widens the pool when the
    // model provider's rate allows — an idle lane costs nothing, a missing one
    // queues work behind the clock.
    lanes: Number(process.env.OPENKB_SWARM_LANES ?? 0) || undefined,
    ...(familyFloor === undefined ? {} : { familyFloor }),
    ...(fromSweep === undefined ? {} : { fromSweep }),
    skill,
    classifyPrompt,
    search: brightDataSearch(creds),
    fetch: brightDataFetch(creds),
    models: { lead: openrouter(LEAD), peek: openrouter(PEEK), read: openrouter(READ), dig: openrouter(DIG) },
    pricing: {
      lead: priceForModel(LEAD),
      peek: priceForModel(PEEK),
      read: priceForModel(READ),
      dig: priceForModel(DIG),
    },
    spans,
    runId: `cli-${Date.now()}`,
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
    announce: (trip) => console.error(`\n${cappedReason(trip, "swarm")}`),
    record: (trip) => {
      capStop.trip = trip
    },
  },
).catch((e: unknown) => {
  if (!capStop.trip) return fatal(e, "swarm")
  // THE ORCHESTRATOR'S OWN ENDING, off the error it threw. `abortedEnd()` closes
  // the books before it rejects — in-flight missions settle, every claim is
  // closed, and the `SwarmEnding` it attaches carries the node and edge counts,
  // the realized spend and the full residue: precisely what would have been done
  // next, ranked. Dropping that on the floor would throw away the most useful
  // thing a stopped swarm produces.
  capStop.ending = (e as { ending?: unknown }).ending
  return null
})
spans.close()
await spanPump

/**
 * THE ENDING OF A SWARM STOPPED AT ITS CAP.
 *
 * The orchestrator's abort path rejects rather than returning, so there is no
 * map to serialize — `abortedEnd()` is the one ending of the seven that does not
 * produce a renderable artifact, and that is its behaviour, not something this
 * cap introduced. What it does produce is the ending above and the spans below,
 * and both are written: the run cost real money and must not vanish because it
 * was stopped on purpose. Its own filename prefix, so nothing reads a stopped
 * swarm as an empty map.
 */
if (run === null && capStop.trip) {
  mkdirSync("runs", { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
  const path = `runs/stopped-${domain.replace(/\W+/g, "-")}-${stamp}.json`
  writeFileSync(
    path,
    JSON.stringify(
      stoppedRun({
        engine: "swarm",
        domain,
        trip: capStop.trip,
        finalUsd: spans.totalUsd(),
        seconds: (Date.now() - startedAt) / 1000,
        spans: spanRows,
        ending: capStop.ending,
      }),
      null,
      2,
    ),
  )
  console.log(`\n${"=".repeat(80)}`)
  console.log(cappedReason(capStop.trip, "swarm"))
  console.log(
    `\n$${spans.totalUsd().toFixed(4)} spent in total against a $${ceilingUsd.toFixed(2)} ledger ceiling — ` +
      `$${(spans.totalUsd() - capStop.trip.spentUsd).toFixed(4)} of it by calls already in flight when the ` +
      `cap fired, which is what the reserve is for.`,
  )
  console.log(`\nwrote ${path} (${spanRows.length} spans)`)
  // Nothing failed; the run cost what it was allowed to cost. See EXIT.capped.
  process.exit(EXIT.capped)
}

const out = serializeSwarmRun(run!)
const { ending, finish } = run!
const count = (arr: string[]) => arr.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})

console.log(`\n${"=".repeat(80)}`)
console.log(ending.humanReason)
if (finish) {
  console.log(`\n${finish.summary}`)
  for (const u of finish.unresolved) console.log(`  unresolved: ${u}`)
}
console.log(`\n${out.entities.length} on the map · ${out.edges.length} edges between them`)
console.log(`kinds     `, count(out.entities.map((e) => e.kind)))
console.log(`relations `, count(out.entities.map((e) => e.relation)))
const recall = out.report.recall as { pooled: number | null; probes: unknown[] }
console.log(
  `recall    `,
  recall.pooled === null ? "no probe page qualified" : `${(recall.pooled * 100).toFixed(1)}% over ${recall.probes.length} probe page(s)`,
)
console.log(`\n${out.stats.queries} queries · ${out.stats.serpCalls} SERP calls · ${out.stats.results} results`)
console.log(`tokens ${out.stats.tokIn.toLocaleString()} in / ${out.stats.tokOut.toLocaleString()} out`)
console.log(`$${out.stats.usd.toFixed(4)} · ${out.stats.seconds.toFixed(0)}s · ${ending.residue.length} residue`)

// Stamped, for the same reason the sweep stamps: a second run of the same
// company must never silently destroy the first — maps cost real dollars.
// Seconds-wide since minute-wide was measured one fast pair away from colliding;
// scripts/sweep.ts carries the arithmetic, and the reader in
// packages/web/lib/runs.ts that this width has to stay legible to.
mkdirSync("runs", { recursive: true })
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
const path = `runs/swarm-${domain.replace(/\W+/g, "-")}-${stamp}.json`
writeFileSync(path, JSON.stringify(out, null, 2))
console.log(`\nwrote ${path}`)

// `spanPump` is already drained: it is awaited beside `spans.close()`, above,
// because the stopped-run branch there needs every span too.
const spansPath = path.replace(/\.json$/, ".spans.jsonl")
writeFileSync(spansPath, spanRows.map((s) => JSON.stringify(s)).join("\n") + "\n")
console.log(`wrote ${spansPath} (${spanRows.length} spans)`)

}
