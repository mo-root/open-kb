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
 *     growing transcript; its input price is what matters ($0.50/M measured
 *     at ~$0.10 per run in the design). Live run 3 (runs/swarm-brightdata-
 *     com-202608060151.json) watched this default sit 14 spawn-less,
 *     finish-less turns on a dry board with the scorecard armed — a
 *     stronger lead is this one env var away.
 *   OPENKB_SWARM_PEEK_MODEL   default deepseek/deepseek-v4-flash —
 *     verification and demotion, the cheapest honest look.
 *   OPENKB_SWARM_READ_MODEL   default OPENKB_MODEL, then deepseek/deepseek-v4-flash.
 *   OPENKB_SWARM_DIG_MODEL    default OPENKB_MODEL, then deepseek/deepseek-v4-flash.
 *
 * Pricing is accounting only — a wrong number makes the cost readout wrong,
 * never the run. Known ids take their row below; anything else takes the
 * default row (the read/dig model's prices, the conservative guess).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { openrouter } from "@openrouter/ai-sdk-provider"
import { SpanStream, composePrompt, type Span } from "../packages/core/src/index.js"
import { brightDataFetch, brightDataSearch } from "../packages/providers/src/index.js"
import {
  fromSweepArgv,
  runSwarm,
  serializeSwarmRun,
  validateSweepRun,
  type SweepRunLike,
} from "../packages/swarm/src/index.js"

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
const wallRaw = Number(process.env.OPENKB_SWARM_WALL ?? 600_000)
const wallClockMs = Number.isFinite(wallRaw) && wallRaw > 0 ? wallRaw : 600_000

/**
 * The family floor, from the environment. Undefined keeps the library default
 * (ON at 4); "0"/"off"/"false" disables; a number 1-5 sizes it (the library
 * clamps to its 5-template deck).
 */
const famRaw = (process.env.OPENKB_SWARM_FAMILIES ?? "").trim().toLowerCase()
const familyFloor: boolean | number | undefined =
  famRaw === ""
    ? undefined
    : famRaw === "off" || famRaw === "false"
      ? false
      : famRaw === "on" || famRaw === "true"
        ? true
        : Number.isFinite(Number(famRaw))
          ? Number(famRaw)
          : undefined

const LEAD = process.env.OPENKB_SWARM_LEAD_MODEL ?? "deepseek/deepseek-v4-flash"
const PEEK = process.env.OPENKB_SWARM_PEEK_MODEL ?? "deepseek/deepseek-v4-flash"
const READ = process.env.OPENKB_SWARM_READ_MODEL ?? process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash"
const DIG = process.env.OPENKB_SWARM_DIG_MODEL ?? process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash"

/** $/M tokens, checked against openrouter.ai/api/v1/models 2026-08-06. An
 *  unknown id prices at the table's most expensive row — the meter must never
 *  flatter a model it does not know. */
const PRICES: Record<string, { inUsdPerM: number; outUsdPerM: number }> = {
  "deepseek/deepseek-v4-flash": { inUsdPerM: 0.088, outUsdPerM: 0.176 },
  "google/gemini-3-flash-preview": { inUsdPerM: 0.5, outUsdPerM: 3.0 },
  "google/gemini-3.1-flash-lite": { inUsdPerM: 0.1, outUsdPerM: 0.4 },
  "google/gemini-3.5-flash": { inUsdPerM: 1.5, outUsdPerM: 9.0 },
}
const priceOf = (id: string) => PRICES[id] ?? { inUsdPerM: 1.5, outUsdPerM: 9.0 }

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

// The span stream, kept: run 1's spans died with the process, and "did the
// lead ever attempt a spawn" became unanswerable an hour later. Every span —
// model turns, SERP rows, fetches, tool calls with their why — collects here
// and writes beside the run JSON as JSONL.
const spanRows: Span[] = []
const spanPump = (async () => {
  for await (const s of spans.stream()) spanRows.push(s)
})()

// Every line wears the running total the span stream has actually billed —
// model turns via the runner's hooks, SERP rows and fetches at the port —
// so "did this just blow past the ceiling" is read off the screen, not
// guessed. The ledger enforces; this only shows.
const run = await runSwarm({
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
  pricing: { lead: priceOf(LEAD), peek: priceOf(PEEK), read: priceOf(READ), dig: priceOf(DIG) },
  spans,
  runId: `cli-${Date.now()}`,
  onLog: (line) => console.log(`$${spans.totalUsd().toFixed(3)}  ${line}`),
})
spans.close()

const out = serializeSwarmRun(run)
const { ending, finish } = run
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
mkdirSync("runs", { recursive: true })
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
const path = `runs/swarm-${domain.replace(/\W+/g, "-")}-${stamp}.json`
writeFileSync(path, JSON.stringify(out, null, 2))
console.log(`\nwrote ${path}`)

await spanPump
const spansPath = path.replace(/\.json$/, ".spans.jsonl")
writeFileSync(spansPath, spanRows.map((s) => JSON.stringify(s)).join("\n") + "\n")
console.log(`wrote ${spansPath} (${spanRows.length} spans)`)
