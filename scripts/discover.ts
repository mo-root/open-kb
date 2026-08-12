/**
 * Run ONLY discovery on one company, and print what it found.
 *
 * This exists so discovery's quality can be judged in isolation, cheaply,
 * without paying for a whole map. Point it at a domain, read the product list,
 * decide if it is right. That is the loop for tuning phase one.
 *
 *   pnpm discover brightdata.com
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { SpanStream, discover } from "../packages/core/src/index.js"
import { brightDataFetch, priceForModel } from "../packages/providers/src/index.js"

const anchor = process.argv[2] ?? "resend.com"
const MODEL = process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash-0731"
const PRICING = priceForModel(MODEL)

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })
const fetcher = brightDataFetch({
  token: process.env.BRIGHTDATA_API_TOKEN!,
  serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
  unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
})
const spans = new SpanStream()

const started = Date.now()
const out = await discover({
  anchor,
  model: openrouter(MODEL),
  modelName: MODEL,
  fetch: fetcher,
  spans,
  pricing: PRICING,
})
spans.close()

console.log(`\n${anchor}`)
console.log(`  sells   ${out.sells}`)
console.log(`  buyer   ${out.buyer}\n`)
console.log(`${out.products.length} products, from ${out.pagesRead} pages read, ${out.steps} agent turns:\n`)
for (const p of out.products) {
  console.log(`  ${p.name}`)
  console.log(`     ${p.does}`)
  console.log(`     ${p.foundAt}`)
}
if (out.coinages.length) console.log(`\ncoinages (never in a de-branded query): ${out.coinages.join(", ")}`)
console.log(`\n$${out.usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s`)

// Break the bill down: what each turn cost, and where the tokens went. Priced
// off the same two numbers the run was billed at rather than a second copy of
// them — the copy that used to sit here agreed perfectly with the headline
// above and both were twenty-fold wrong about the model actually being called.
const IN=PRICING.inUsdPerM/1e6, OUT=PRICING.outUsdPerM/1e6
let ti=0,to=0
const rows:{turn:number;inTok:number;outTok:number;usd:number}[]=[]
for (const s of out._steps ?? []) {
  const i=s.usage?.inputTokens??0, o=s.usage?.outputTokens??0
  ti+=i; to+=o; rows.push({turn:rows.length+1,inTok:i,outTok:o,usd:i*IN+o*OUT})
}
console.log(`\n  ${out.steps} turns · ${ti.toLocaleString()} in / ${to.toLocaleString()} out`)
console.log(`  input  $${(ti*IN).toFixed(3)}  (${Math.round(100*ti*IN/(ti*IN+to*OUT))}%)   output $${(to*OUT).toFixed(3)}  (${Math.round(100*to*OUT/(ti*IN+to*OUT))}%)`)
console.log(`  a tool loop re-sends its whole transcript each turn, so input grows every step:`)
for (const r of rows) console.log(`     turn ${String(r.turn).padStart(2)}  in ${String(r.inTok).padStart(6)}  out ${String(r.outTok).padStart(5)}  $${r.usd.toFixed(3)}`)

