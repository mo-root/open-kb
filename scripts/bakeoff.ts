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
 *   runs/experiments/bakeoff-<domain>.md   — the table
 *   an audit packet per run (deal only)    — quality scored separately
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"

interface Contestant {
  key: string
  model: string
  env?: Record<string, string>
  note: string
}

const CONTESTANTS: Contestant[] = [
  { key: "deepseek-off", model: "deepseek/deepseek-v4-flash", note: "reasoning off, fast hosts (current default)" },
  {
    key: "deepseek-think",
    model: "deepseek/deepseek-v4-flash",
    env: { OPENKB_DEEPSEEK_REASONING: "bounded" },
    note: "bounded reasoning — does thinking earn its latency?",
  },
  { key: "flash-lite", model: "google/gemini-3.1-flash-lite", note: "the speed reference" },
  { key: "gemini-35", model: "google/gemini-3.5-flash", note: "the old default — quality baseline holder" },
  { key: "gemini-3p", model: "google/gemini-3-flash-preview", note: "the design doc's lead model" },
]

const [domain, queriesArg] = process.argv.slice(2)
if (!domain) {
  console.error("usage: pnpm run bakeoff <domain> [queries=10]")
  process.exit(1)
}
const queries = queriesArg ?? "10"

interface Row {
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

const rows: Row[] = []
mkdirSync("runs/experiments", { recursive: true })

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
    console.error(`${c.key} FAILED: ${(e as Error).message} — recorded, moving on`)
    rows.push({ key: c.key, model: c.model, usd: NaN, seconds: NaN, entities: 0, hosts: 0, competitors: 0, unknowns: 0, recall: "run failed", groundingMean: "-", file: "-" })
    continue
  }
  const after = readdirSync("runs").filter(
    (n) => n.startsWith(`sweep-${domain.replace(/\W+/g, "-")}`) && !before.has(n),
  )
  const file = after.sort().pop()
  if (!file) {
    rows.push({ key: c.key, model: c.model, usd: NaN, seconds: NaN, entities: 0, hosts: 0, competitors: 0, unknowns: 0, recall: "no file", groundingMean: "-", file: "-" })
    continue
  }
  const r = JSON.parse(readFileSync(`runs/${file}`, "utf8"))
  rows.push({
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
  })
  // Deal the quality packet; scoring happens via the audit workflow later.
  try {
    execFileSync("npx", ["tsx", "scripts/audit.ts", `runs/${file}`, "--n", "15"], { stdio: "inherit", env: process.env })
  } catch {
    console.error("audit packet deal failed — quality leg missing for this run")
  }
}

const table = [
  `# Bake-off — ${domain}, ${queries} queries each, sequential, ${new Date().toISOString().slice(0, 10)}`,
  "",
  "Quality (wrong-rate) is scored separately: fill each run's audit packet with the",
  "symmetric workflow, then `pnpm run audit --score` — a model is not a winner until",
  "its packet is.",
  "",
  "| config | model | $ | wall s | hosts | entities | competitor | unknown | recall | grounding |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.key} | ${r.model} | ${Number.isNaN(r.usd) ? "FAILED" : "$" + r.usd.toFixed(2)} | ${r.seconds || "-"} | ${r.hosts || "-"} | ${r.entities || "-"} | ${r.competitors} | ${r.unknowns} | ${r.recall} | ${r.groundingMean} |`,
  ),
  "",
  ...rows.filter((r) => r.file !== "-").map((r) => `- ${r.key}: runs/${r.file}`),
  "",
].join("\n")

const out = `runs/experiments/bakeoff-${domain.replace(/\W+/g, "-")}.md`
writeFileSync(out, table)
console.log(`\n${table}\nwrote ${out}`)
