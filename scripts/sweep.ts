/**
 * The sweep, from a terminal.
 *
 * The pipeline itself lives in `packages/sweep` — this file is argv, credentials
 * and a console, nothing else. The web route drives the same function, so what
 * you see here is what the browser runs.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/sweep.ts resend.com [nQueries]
 */
import { openrouter } from "@openrouter/ai-sdk-provider"
import { SpanStream } from "../packages/core/src/index.js"
import { sweep } from "../packages/sweep/src/index.js"

const anchor = process.argv[2] ?? "resend.com"
const TARGET = Number(process.argv[3] ?? 40)
const MODEL = process.env.OPENKB_MODEL ?? "google/gemini-3.5-flash"

const spans = new SpanStream()

const out = await sweep({
  domain: anchor,
  queries: TARGET,
  spans,
  creds: {
    token: process.env.BRIGHTDATA_API_TOKEN!,
    serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
    unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
  },
  model: openrouter(MODEL),
  modelId: MODEL,
  runId: `cli-${Date.now()}`,
  onLog: (line) => console.log(line),
})
spans.close()

const { stats, entities } = out
const keep = entities.filter((e) => e.kind !== "noise")
const count = (arr: string[]) => arr.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})

console.log(`\n${"=".repeat(80)}`)
console.log(`${keep.length} on the map (${entities.length - keep.length} judged noise) from ${stats.hosts} hosts`)
console.log(`kinds     `, count(keep.map((e) => e.kind)))
console.log(`relations `, count(keep.map((e) => e.relation)))
console.log(`\n${stats.queries} queries · ${stats.serpCalls} SERP calls · ${stats.results} results`)
console.log(`tokens ${stats.tokIn.toLocaleString()} in / ${stats.tokOut.toLocaleString()} out`)
console.log(`$${stats.usd.toFixed(4)} · ${stats.seconds.toFixed(0)}s`)

const { writeFileSync, mkdirSync } = await import("node:fs")
mkdirSync("runs", { recursive: true })
const path = `runs/sweep-${anchor.replace(/\W+/g, "-")}.json`
writeFileSync(path, JSON.stringify(out, null, 2))
console.log(`\nwrote ${path}`)
