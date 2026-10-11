/**
 * The model bake-off: one anchor, several model configs, identical probe
 * runs, one table. The default model becomes a measured choice with a
 * published receipt instead of an argument.
 *
 * Runs are SEQUENTIAL on purpose — concurrent runs share the SERP zone and
 * a saturated wave reads as a mysteriously empty round (measured 2026-08-06).
 *
 * Usage:
 *   pnpm run bakeoff <domain> [queries=10]
 *
 * Each contestant is a child `scripts/sweep.ts` run with env overrides; the
 * numbers come from the run files' own reports (the honest meter), plus
 * per-phase wall clock parsed from the log. Output:
 *   runs/experiments/bakeoff-<domain>-<stamp>.md  — the table
 *   an audit packet per run (deal only)           — quality scored separately
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { EXIT } from "./fatal.js"

export interface Contestant {
  key: string
  model: string
  env?: Record<string, string>
  note: string
}

export const CONTESTANTS: Contestant[] = [
  { key: "deepseek-off", model: "deepseek/deepseek-v4-flash-0731", note: "reasoning off, fast hosts (current default)" },
  {
    key: "deepseek-think",
    model: "deepseek/deepseek-v4-flash-0731",
    env: { OPENKB_DEEPSEEK_REASONING: "bounded" },
    note: "bounded reasoning — does thinking earn its latency?",
  },
  { key: "flash-lite", model: "google/gemini-3.1-flash-lite", note: "the speed reference" },
  { key: "gemini-35", model: "google/gemini-3.5-flash", note: "the old default — quality baseline holder" },
  { key: "gemini-3p", model: "google/gemini-3-flash-preview", note: "the design doc's lead model" },
]

export interface Row {
  key: string
  model: string
  usd: number
  seconds: number
  entities: number
  hosts: number
  competitors: number
  unknowns: number
  recall: string
  groundingMean: string
  file: string
}

/** One contestant's row, from its already-parsed run file. Pure — the only
 *  disk access (`readFileSync`) stays in the `invokedDirectly` body below, so
 *  this can be tested against a fixture object without a real run on disk. */
export function rowFromRun(
  c: Contestant,
  file: string,
  r: {
    stats: { usd: number; seconds: number; hosts: number }
    report: {
      entities: number
      relations?: { competitor?: number; unknown?: number }
      recall?: { pooled?: number | null }
      kernel?: { groundingMean?: number | null }
    }
  },
): Row {
  return {
    key: c.key,
    model: c.model,
    usd: r.stats.usd,
    seconds: Math.round(r.stats.seconds),
    entities: r.report.entities,
    hosts: r.stats.hosts,
    competitors: r.report.relations?.competitor ?? 0,
    unknowns: r.report.relations?.unknown ?? 0,
    recall: r.report.recall?.pooled != null ? r.report.recall.pooled.toFixed(2) : "no probe",
    groundingMean: r.report.kernel?.groundingMean != null ? String(r.report.kernel.groundingMean) : "-",
    file,
  }
}

/** The row a contestant gets when its child sweep threw or left no new run
 *  file behind — `usd`/`seconds` are `NaN` so the table's own `FAILED` check
 *  (in `renderTable` below) fires instead of printing a bogus dollar figure. */
export function failedRow(c: Contestant, recall: "run failed" | "no file"): Row {
  return { key: c.key, model: c.model, usd: NaN, seconds: NaN, entities: 0, hosts: 0, competitors: 0, unknowns: 0, recall, groundingMean: "-", file: "-" }
}

/**
 * True when `e` — a thrown `execFileSync` error — means the child died
 * because the operator pressed Ctrl+C, not because it crashed. `scripts/
 * interrupt.ts` (SELF-695) gave `scripts/sweep.ts` its own SIGINT/SIGTERM
 * handler, which catches the signal and exits through `EXIT.interrupted`
 * (`.status`) rather than dying by the signal itself — the common case here,
 * since a bake-off's child IS that same `sweep.ts`. A child with no such
 * handler (or one killed before its handler could run) instead dies BY the
 * signal, which Node reports as `.signal` with `.status` left `null`; both
 * are checked.
 *
 * `.signal` alone is not enough: the SAME field is set when the
 * `execFileSync` call's own `timeout` (30 min, below) kills a hung child —
 * confirmed directly (`node -e` against a `sleep` child with a short
 * `timeout`) — `.signal` reads `"SIGTERM"` there too, but Node also sets
 * `.code` to `"ETIMEDOUT"` in exactly that case and only that case, so excluding
 * it is what keeps a genuine hang from being misread as a deliberate stop.
 *
 * Residual, stated rather than fixed: `sweep.ts`'s own interrupt handling
 * (scripts/sweep.ts:453) only reaches `EXIT.interrupted` while it has no map
 * yet. Caught late enough that one already exists, it writes the thinner map
 * it has and exits 0 — a real, intentional choice in `sweep.ts`, not a bug —
 * so `execFileSync` never throws at all and this function is never asked.
 * The loop below reads that contestant as an ordinary success and moves on
 * to the next (paid) one. Catching that case would mean teaching `sweep.ts`
 * to say "finished, but stopped early" as a THIRD outcome distinct from both
 * "ran to completion" and "interrupted with nothing to show" — out of scope
 * for a bake-off-only fix.
 */
export function wasInterrupted(e: unknown): boolean {
  const err = e as { signal?: string | null; status?: number | null; code?: string }
  if (err.code === "ETIMEDOUT") return false
  return err.signal === "SIGINT" || err.signal === "SIGTERM" || err.status === EXIT.interrupted
}

/** The markdown table, given the rows already collected. Pure — `dateIso` is
 *  a parameter rather than a `new Date()` call in here, on purpose: the
 *  `invokedDirectly` body below takes that reading itself, separately from
 *  the file-stamp reading it takes afterward, exactly as the comment below
 *  (on the stamp) describes. Folding both into one `Date` here would remove
 *  the (deliberately tolerated) gap that comment is about. */
export function renderTable(domain: string, queries: string, rows: Row[], dateIso: string): string {
  return [
    `# Bake-off — ${domain}, ${queries} queries each, sequential, ${dateIso}`,
    "",
    "Quality (wrong-rate) is scored separately: fill each run's audit packet with the",
    "symmetric workflow, then `pnpm run audit --score` — a model is not a winner until",
    "its packet is.",
    "",
    "| config | model | $ | wall s | hosts | entities | competitor | unknown | recall | grounding |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      // `failedRow` is the only source of `Number.isNaN(r.usd)`, and it is
      // also the only row that leaves `hosts`/`entities` at their sentinel 0
      // ("never ran") rather than a measured count. A `rowFromRun` row for a
      // genuinely dead anchor reports both as a real, informative 0 — the
      // exact case this table exists to surface — so gating the dash on
      // `Number.isNaN(r.usd)` (already the $ column's failure signal) rather
      // than each field's own falsiness keeps that 0 visible instead of
      // reading identically to a contestant that never produced a run file.
      const failed = Number.isNaN(r.usd)
      return `| ${r.key} | ${r.model} | ${failed ? "FAILED" : "$" + r.usd.toFixed(2)} | ${failed ? "-" : r.seconds} | ${failed ? "-" : r.hosts} | ${failed ? "-" : r.entities} | ${r.competitors} | ${r.unknowns} | ${r.recall} | ${r.groundingMean} |`
    }),
    "",
    ...rows.filter((r) => r.file !== "-").map((r) => `- ${r.key}: runs/${r.file}`),
    "",
  ].join("\n")
}

// Body left un-indented after the `invokedDirectly` guard, the same choice
// run-doctor.ts made wrapping a pre-existing body: re-indenting the whole
// thing would bury this diff's real change (the extraction above) under a
// column shift on every line, and `runs.test.ts`'s "one spelling of the
// stamp across all five writers" reads this file's `const stamp = new Date`
// line by its exact column — indented, it silently drops out of that count.
const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {

const [domain, queriesArg] = process.argv.slice(2)
if (!domain) {
  console.error("usage: pnpm run bakeoff <domain> [queries=10]")
  process.exit(1)
}
const queries = queriesArg ?? "10"

const rows: Row[] = []
mkdirSync("runs/experiments", { recursive: true })

// A bake-off is several sequential, real-money sweeps, and `execFileSync`
// below does not `detached` its child — unlike scripts/batch.ts's concurrent
// children — so it shares THIS process's own process group. A terminal's
// Ctrl+C reaches both at once. Without a handler here, Node's default
// SIGINT/SIGTERM disposition kills this process the instant that happens,
// mid-`execFileSync`, discarding every row already collected from earlier
// contestants along with the table that would have reported them — the same
// "silent death" scripts/interrupt.ts's own header documents for sweep.ts,
// swarm.ts and batch.ts before SELF-695/696/697. Confirmed directly
// (`node -e`, a handled child, SIGINT sent to the shared process group):
// registering ANY handler is enough to stop the default kill, even though
// the handler's own body never gets to run before the blocked `execFileSync`
// call returns — Node has no event-loop tick free to run it until then, and
// by that point `wasInterrupted` below already has everything it needs,
// straight off the error `execFileSync` throws. So the handler here does
// nothing beyond existing.
process.on("SIGINT", () => {})
process.on("SIGTERM", () => {})

for (const c of CONTESTANTS) {
  console.log(`\n=== ${c.key} (${c.model}) — ${c.note}`)
  const before = new Set(readdirSync("runs").filter((n) => n.startsWith(`sweep-${domain.replace(/\W+/g, "-")}`)))
  try {
    execFileSync("npx", ["tsx", "scripts/sweep.ts", domain, queries], {
      stdio: "inherit",
      env: { ...process.env, OPENKB_MODEL: c.model, ...c.env },
      timeout: 30 * 60 * 1000,
    })
  } catch (e) {
    if (wasInterrupted(e)) {
      console.error(`\nstopped by Ctrl+C — writing the table for the ${rows.length} contestant${rows.length === 1 ? "" : "s"} that finished; no further contestant will start.`)
      break
    }
    console.error(`${c.key} FAILED: ${(e as Error).message} — recorded, moving on`)
    rows.push(failedRow(c, "run failed"))
    continue
  }
  const after = readdirSync("runs").filter(
    (n) => n.startsWith(`sweep-${domain.replace(/\W+/g, "-")}`) && !before.has(n),
  )
  const file = after.sort().pop()
  if (!file) {
    rows.push(failedRow(c, "no file"))
    continue
  }
  const r = JSON.parse(readFileSync(`runs/${file}`, "utf8"))
  rows.push(rowFromRun(c, file, r))
  // Deal the quality packet; scoring happens via the audit workflow later.
  try {
    execFileSync("npx", ["tsx", "scripts/audit.ts", `runs/${file}`, "--n", "15"], { stdio: "inherit", env: process.env })
  } catch (e) {
    if (wasInterrupted(e)) {
      console.error(`\nstopped by Ctrl+C — writing the table for the ${rows.length} contestant${rows.length === 1 ? "" : "s"} that finished; no further contestant will start.`)
      break
    }
    console.error("audit packet deal failed — quality leg missing for this run")
  }
}

const table = renderTable(domain, queries, rows, new Date().toISOString().slice(0, 10))

// Stamped, like the three CLIs — and for a reason none of them has. This table
// is the receipt README.md:74-77 points at when it explains the default
// model's cost/recall numbers as "not a claim that it finds the most", and
// that claim stays checkable only while the SERIES does: a bake-off is worth
// keeping precisely so the one taken before a model default changed can be
// read beside the one taken after, and unstamped, the re-run that would
// justify the new default was the very thing that erased the evidence for
// the old. It stamps where its neighbour audit.ts:100-104 refuses because
// that packet holds hand-filled verdicts and refusing protects unsaved human
// work; this table is machine-generated, so the answer is to keep every
// copy, not to block the second run. The heading's date,
// read where `renderTable` is called above, is an earlier, separate `new Date()`
// from the stamp below — but only by the microseconds between the two calls, both
// of which fire after the contestant loop — so the two can disagree only across a
// UTC midnight, and nothing parses this name, which leaves the heading the
// authoritative date of the table.
//
// Seconds, matching the other three writers exactly. This .md was never the file
// at risk — a real bake-off is several sequential sweeps and takes hours — but the
// SWEEPS this script spawns are, and they land under one domain back to back,
// which is precisely the case scripts/sweep.ts's note measures. Worth naming here
// because the damage surfaces in THIS file: a colliding second sweep reuses the
// first one's filename, so it is absent from the `before`/`after` diff in the
// loop above, and the contestant that actually finished is written into the
// table as "no file".
//
// The residual is stated rather than fixed, and it is narrower than it first
// looks. A bake-off whose contestants all throw — a bad key, an unreachable zone
// — writes a table of nothing but FAILED rows, but it cannot collide with the
// NEXT one: five sequential `npx tsx` spawns have a measured floor of 1.57s
// before any module graph, DNS or HTTP, so back-to-back runs always land on
// different seconds. What survives is the concurrent case — two bake-offs
// launched at once from two terminals, a trailing `&`, or a CI matrix — both
// all-throw, both finishing inside one second, the second table overwriting the
// first. A table of FAILED rows stays the right thing to lose. Seconds took the
// window from 60s to 1s without pretending to close it; a random suffix would
// close it and cost the sort — see packages/web/lib/runs.ts, and the `.sort()`
// in the loop above, which both read these names in order.
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
const out = `runs/experiments/bakeoff-${domain.replace(/\W+/g, "-")}-${stamp}.md`
writeFileSync(out, table)
console.log(`\n${table}\nwrote ${out}`)

}
