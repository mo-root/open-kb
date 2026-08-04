/**
 * The sweep, from a terminal.
 *
 * The pipeline itself lives in `packages/sweep`, this file is argv, credentials
 * and a console, nothing else. The web route drives the same function, so what
 * you see here is what the browser runs.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/sweep.ts resend.com [nQueries]
 */
import { openrouter } from "@openrouter/ai-sdk-provider"
import { SpanStream } from "../packages/core/src/index.js"
import { sweep, readUi } from "../packages/sweep/src/index.js"

const anchor = process.argv[2] ?? "resend.com"
// Unset unless a third arg is given — the normal case, and now the same
// default the web route already used (`route.ts`: "undefined is not a bad
// value, it is the normal one now"). Left as a hardcoded `?? 40` here, every
// CLI run silently reactivated the old fixed-quota catalog and the run this
// script exists to validate — every product dealt its own opening hand, the
// spend ceiling as the only brake — could never actually be exercised from a
// terminal. A numeric third arg still bounds a probe exactly as before.
const TARGET = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined
const MODEL = process.env.OPENKB_MODEL ?? "google/gemini-3.5-flash"

const spans = new SpanStream()

// There is no live ceiling here — the web route's `OPENKB_CEILING_USD` guard
// is a pre-run refusal, not something that watches a run already in flight,
// and the CLI has nothing like it at all. `spans.totalUsd()` already tracks
// the running total as every span is billed, so the only missing piece was
// printing it. Prefixing every log line costs nothing and turns "did this
// just blow past $4" from a guess into something read off the screen.
const out = await sweep({
  domain: anchor,
  queries: TARGET,
  pages: Number(process.env.OPENKB_PAGES ?? 4),
  skipModelLinking: process.env.OPENKB_SKIP_MODEL_LINKING === "1",
  spans,
  creds: {
    token: process.env.BRIGHTDATA_API_TOKEN!,
    serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
    unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
  },
  model: openrouter(MODEL),
  modelId: MODEL,
  runId: `cli-${Date.now()}`,
  onLog: (line) => console.log(`$${spans.totalUsd().toFixed(3)}  ${line}`),
})
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
for await (const span of spans.stream()) {
  const ui = readUi(span)
  if (ui?.ns === "results" && ui.frame.kind === "searched") searched.push(ui.frame)
}

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
// Stamped, because the filename used to be the domain alone and a second run of
// the same company silently destroyed the first. A 771-second, $1.26, 388-entity
// map of brightdata.com was overwritten by a 10-query smoke test that happened to
// name the same domain. Maps are expensive and slow; nothing that costs a dollar
// and thirteen minutes should be deleted by a command that does not say "delete".
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
const path = `runs/sweep-${anchor.replace(/\W+/g, "-")}-${stamp}.json`
writeFileSync(path, JSON.stringify({ ...out, searched }, null, 2))
console.log(`\nwrote ${path} (${searched.length} queries logged)`)
