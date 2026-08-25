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
import type { StepResult, ToolSet } from "ai"
import { SpanStream, discover, type ModelPricing } from "../packages/core/src/index.js"
import { brightDataFetch, priceForModel } from "../packages/providers/src/index.js"

/** Break the bill down: what each turn cost, and where the tokens went. Priced
 *  off the same two numbers the run was billed at rather than a second copy of
 *  them — the copy that used to sit here agreed perfectly with the headline
 *  above and both were twenty-fold wrong about the model actually being called.
 *
 *  Pulled out because the whole file ran at import time (top-level `await
 *  discover`, a live BrightData/OpenRouter call), so this arithmetic had no
 *  test anywhere and a real bug sat in it: `out._steps` is empty whenever
 *  discovery ends before any step lands usage (an immediate refusal, a
 *  provider error on turn one), so `ti` and `to` are both 0 and
 *  `100*0*IN/(0*IN+0*OUT)` divides zero by zero — the same NaN-on-an-empty-
 *  population class bench.ts's provenance footer and query-ratio sentence
 *  were already fixed for (1bf6be5, e6742e2). `inPct`/`outPct` are `null`
 *  rather than `NaN` when there is no spend to take a share of. */
export function costBreakdown(steps: StepResult<ToolSet>[] | undefined, pricing: ModelPricing) {
  const IN = pricing.inUsdPerM / 1e6, OUT = pricing.outUsdPerM / 1e6
  let ti = 0, to = 0
  const rows: { turn: number; inTok: number; outTok: number; usd: number }[] = []
  for (const s of steps ?? []) {
    const i = s.usage?.inputTokens ?? 0, o = s.usage?.outputTokens ?? 0
    ti += i; to += o; rows.push({ turn: rows.length + 1, inTok: i, outTok: o, usd: i * IN + o * OUT })
  }
  const spend = ti * IN + to * OUT
  const inPct = spend === 0 ? null : Math.round((100 * ti * IN) / spend)
  const outPct = spend === 0 ? null : Math.round((100 * to * OUT) / spend)
  return { IN, OUT, ti, to, rows, inPct, outPct }
}

const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {
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
  if (!out.finished) {
    console.log(`  did not call finish — ran out of turns; the list below may be incomplete\n`)
  }
  console.log(`${out.products.length} products, from ${out.pagesRead} pages read, ${out.steps} agent turns:\n`)
  for (const p of out.products) {
    console.log(`  ${p.name}`)
    console.log(`     ${p.does}`)
    console.log(`     ${p.foundAt}`)
  }
  if (out.integrations.length) {
    console.log(`\n${out.integrations.length} integrations, as the company's own docs state them:\n`)
    for (const i of out.integrations) {
      console.log(`  ${i.with}`)
      console.log(`     ${i.does}`)
      console.log(`     ${i.foundAt}`)
    }
  }
  if (out.coinages.length) console.log(`\ncoinages (never in a de-branded query): ${out.coinages.join(", ")}`)
  console.log(`\n$${out.usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s`)

  const { IN, OUT, ti, to, rows, inPct, outPct } = costBreakdown(out._steps, PRICING)
  console.log(`\n  ${out.steps} turns · ${ti.toLocaleString()} in / ${to.toLocaleString()} out`)
  console.log(`  input  $${(ti * IN).toFixed(3)}  (${inPct === null ? "—" : `${inPct}%`})   output $${(to * OUT).toFixed(3)}  (${outPct === null ? "—" : `${outPct}%`})`)
  console.log(`  a tool loop re-sends its whole transcript each turn, so input grows every step:`)
  for (const r of rows) console.log(`     turn ${String(r.turn).padStart(2)}  in ${String(r.inTok).padStart(6)}  out ${String(r.outTok).padStart(5)}  $${r.usd.toFixed(3)}`)
}

