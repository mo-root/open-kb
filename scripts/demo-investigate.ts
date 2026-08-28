/**
 * Run one investigator against a real company and print the map it built.
 * Spends real money. Usage:
 *   set -a && . ./.env && set +a && npx tsx scripts/demo-investigate.ts [domain]
 */
import { EvidenceStore, SpanStream, investigate } from "../packages/core/src/index.js"
import { brightDataSearch, brightDataFetch, priceForModel } from "../packages/providers/src/index.js"
import { openrouter } from "@openrouter/ai-sdk-provider"

/** The run record written to `runs/demo-<slug>-<stamp>.json`, pulled out of
 *  the `investigate()` call it used to sit directly after so it can be
 *  exercised without one — this whole file ran at import time (a live
 *  BrightData/OpenRouter call via top-level `await investigate`), so nothing
 *  in it was reachable from a test process, the same gap discover.ts's
 *  costBreakdown and the rest of `scripts/*.ts beyond sweep.ts` were already
 *  swept for. No disk access here (that stays in the `invokedDirectly` body
 *  below, next to `writeFileSync`) — this only shapes what gets written.
 *  `stats` is a plain re-count of `spanLog`, not `out` itself, so an empty
 *  run (a refusal before any span lands) is all zeros here rather than the
 *  NaN-on-an-empty-population class discover.ts's costBreakdown was fixed
 *  for — there is no division here to produce one, and the test locks that
 *  it stays that way. */
export function demoRunRecord(opts: {
  anchor: string
  out: { nodes: number; edges: number; usd: number; summary: unknown }
  elapsed: number
  pagesFetched: number
  spanLog: readonly { kind: string; ok: boolean }[]
  nodes: unknown[]
  edges: unknown[]
}) {
  return {
    anchor: opts.anchor,
    stats: {
      nodes: opts.out.nodes,
      edges: opts.out.edges,
      usd: opts.out.usd,
      seconds: opts.elapsed,
      pagesFetched: opts.pagesFetched,
      spans: opts.spanLog.length,
      searches: opts.spanLog.filter((s) => s.kind === "search").length,
      fetches: opts.spanLog.filter((s) => s.kind === "fetch").length,
      failures: opts.spanLog.filter((s) => !s.ok).length,
    },
    nodes: opts.nodes,
    edges: opts.edges,
    spans: opts.spanLog,
    summary: opts.out.summary,
  }
}

// Body left un-indented after the `invokedDirectly` guard, the same choice
// batch.ts/bench.ts/bakeoff.ts made wrapping a pre-existing body: re-indenting
// the whole thing would bury this diff's real change (the demoRunRecord
// extraction above) under a column shift on every line — and packages/web/
// lib/runs.test.ts's writer-shape scan matches `const stamp = new Date` and
// the `outPath` template literal at column 0, so an indented copy would stop
// being the writer that guard finds.
const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {

const anchor = process.argv[2] ?? "resend.com"
const MODEL = process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash-0731"

const creds = {
  token: process.env.BRIGHTDATA_API_TOKEN!,
  serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
  unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
}

const ctx = {
  evidence: new EvidenceStore(),
  spans: new SpanStream(),
  search: brightDataSearch(creds),
  fetch: brightDataFetch(creds),
  runId: "demo",
  agentId: "inv1",
  parentId: null,
  graph: { nodes: new Map(), edges: [] as any[] },
}

// Watch the run as it happens, this is the stream the web surface will render.
const spanLog: any[] = []
const watcher = (async () => {
  for await (const s of ctx.spans.stream()) {
    spanLog.push(s)
    const mark = s.ok ? " " : "!"
    const cost = s.usd > 0 ? `$${s.usd.toFixed(4)}` : "free"
    console.log(`${mark} ${String(s.seq).padStart(2)} ${s.kind.padEnd(8)} ${cost.padStart(7)}  ${s.argsDigest.slice(0, 76)}`)
    if (!s.ok && s.error) console.log(`      └─ ${s.error}`)
  }
})()

const started = Date.now()
const out = await investigate({
  anchor,
  mission:
    `Map the whole ecosystem around ${anchor}, not just its rivals. Find the companies going head-on at the ` +
    `same buyer, the ones solving the same problem a completely different way, the big names and standards ` +
    `this market has to work around, what this kind of product is built on and what it plugs into, the ` +
    `individual products themselves and not only the companies selling them, and the places these buyers ` +
    `actually gather and talk — subreddits, forums, Slack and Discord groups, conferences, trade bodies, the ` +
    `newsletters and publications they read. Describe what the thing does to the search engine several ` +
    `different ways rather than naming it, cover as much ground sideways as you can, and record everything ` +
    `you can prove.`,
  ctx,
  model: openrouter(MODEL),
  maxSteps: 20,
  modelName: MODEL,
  // Looked up here, not in core: the engine must not know which vendor it talks to.
  pricing: priceForModel(MODEL),
})
ctx.spans.close()
await watcher

console.log(`\n${"=".repeat(90)}\nMAP OF ${anchor}\n${"=".repeat(90)}`)

for (const n of ctx.graph.nodes.values()) {
  console.log(`\n[${n.kind}] ${n.name}`)
  console.log(`  what      ${n.what}`)
  console.log(`  why here  ${n.whyHere}`)
  console.log(`  found by  ${n.howFound}`)
  for (const e of n.evidence) {
    console.log(`  evidence  ${e.url}`)
    console.log(`            "${e.quote.slice(0, 100)}"`)
  }
}

if (ctx.graph.edges.length) {
  console.log(`\n${"-".repeat(90)}\nRELATIONS\n${"-".repeat(90)}`)
  for (const e of ctx.graph.edges) {
    console.log(`\n${e.from}  --[${e.relation}]-->  ${e.to}`)
    console.log(`  why  ${e.whyHere}`)
  }
}

const elapsed = (Date.now() - started) / 1000
console.log(`\n${"=".repeat(90)}`)
console.log(`${out.nodes} nodes · ${out.edges} edges · $${out.usd.toFixed(4)} · ${elapsed.toFixed(0)}s`)
console.log(`pages fetched: ${ctx.evidence.size()}`)

// Persist the whole run so a surface can render it without paying for it again.
const { writeFileSync, mkdirSync } = await import("node:fs")
mkdirSync("runs", { recursive: true })
// Stamped, for the same reason the sweep stamps — scripts/sweep.ts tells the
// story of the overwritten brightdata.com map in full. This was the last of the
// three CLIs to get the treatment, and the unstamped output is still on disk:
// runs/resend-com.json and runs/stripe-com.json came out of here, and are the
// only two files in runs/ the web gallery cannot even list. `demo-` so a demo
// run is never mistaken for a sweep at a glance.
//
// Seconds-wide, matching the other three exactly; scripts/sweep.ts has the
// measurement. That `demo-` prefix means this file is the one output whose stamp
// nobody parses — packages/web/lib/runs.ts lists only `sweep-` and `swarm-`, so
// the gallery never adopts a demo run and never reads a date out of this name.
// Uniqueness is all it needs. Kept identical anyway: four writers spelling the
// stamp the same way is worth more than a stamp tuned to one writer's needs.
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
const outPath = `runs/demo-${anchor.replace(/\W+/g, "-")}-${stamp}.json`
writeFileSync(
  outPath,
  JSON.stringify(
    demoRunRecord({
      anchor,
      out,
      elapsed,
      pagesFetched: ctx.evidence.size(),
      spanLog,
      nodes: [...ctx.graph.nodes.values()],
      edges: ctx.graph.edges,
    }),
    null,
    2,
  ),
)
console.log(`\nwrote ${outPath}`)

}
