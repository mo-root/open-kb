/**
 * Run the same anchor several ways and compare, on quality first.
 *
 * Every choice in this engine so far was argued from one measurement or from
 * taste. The open ones are worth settling with a controlled comparison rather
 * than an opinion, because they pull in opposite directions: reading more of a
 * company's own documentation is slower and better, and skipping a model pass
 * is cheaper and may be no worse.
 *
 * Order of judgement, fixed: quality, then time, then cost. A cheaper arm that
 * maps the wrong market has not won anything.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const OUT = "runs/experiments"
const LOG = `${OUT}/arms.jsonl`

interface Arm {
  key: string
  what: string
  env: Record<string, string>
}

/**
 * Each arm changes ONE thing against the same anchor and query count, so a
 * difference is attributable. Anything needing a code change rather than an
 * env var is listed in the brief instead of pretended at here.
 */
const ARMS: Arm[] = [
  { key: "baseline", what: "as it ships: 4 pages per query, condensed docs, model linking on", env: {} },
  {
    key: "pages-2",
    what: "half the result pages. Tests whether depth per query is buying anything",
    env: { OPENKB_PAGES: "2" },
  },
  {
    key: "pages-6",
    what: "half again more pages. The other side of the same question",
    env: { OPENKB_PAGES: "6" },
  },
  {
    key: "no-model-links",
    what: "systematic linking only, no paid pass. Tests whether the model pass earns its cost",
    env: { OPENKB_SKIP_MODEL_LINKING: "1" },
  },
  {
    key: "cheap-classifier",
    what: "a smaller model throughout. Classification is a labelling task and most of the bill",
    env: { OPENKB_MODEL: "google/gemini-2.5-flash-lite" },
  },
]

/**
 * A hard ceiling that does not depend on the key having one.
 *
 * The key in use is uncapped and draws straight on an account holding $124, so
 * the key-level guard reads infinite headroom and stops nothing. Spend is
 * measured instead as the DELTA in the key's own usage since this process
 * started, which is the number that matters and is true whatever the key is
 * configured to allow.
 */
async function keyUsage(): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  })
  if (!res.ok) throw new Error(`could not read key usage: ${res.status}`)
  const { data } = (await res.json()) as { data: { usage: number } }
  return data.usage
}

/** Read back what the arm produced, from the file the run wrote. */
function measure(anchor: string): Record<string, unknown> {
  const dir = "runs"
  const slug = anchor.replace(/\W+/g, "-")
  const f = readdirSync(dir)
    .filter((x) => x.startsWith(`sweep-${slug}-`) && x.endsWith(".json"))
    .sort()
    .at(-1)
  if (!f) return {}
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as {
    decomposition: { products: unknown[]; capabilities?: unknown[] }
    entities: { kind: string; relation: string }[]
    edges?: { confidence: string }[]
    stats: Record<string, number>
  }
  const kept = r.entities.filter((e) => e.kind !== "noise")
  const rel = (k: string) => kept.filter((e) => e.relation === k).length
  return {
    file: f,
    products: r.decomposition.products.length,
    markets: r.decomposition.capabilities?.length ?? 0,
    entities: kept.length,
    noise: r.entities.length - kept.length,
    // Quality proxies, stated as proxies. A map that is all `competitor`
    // answered "who competes" when the question was "what is this market".
    competitors: rel("competitor"),
    substitutes: rel("substitute"),
    communities: rel("discusses"),
    directories: rel("lists"),
    unplaced: rel("none"),
    edges: r.edges?.length ?? 0,
    measuredEdges: (r.edges ?? []).filter((e) => e.confidence === "measured").length,
    usd: r.stats.usd,
    seconds: r.stats.seconds,
    tokIn: r.stats.tokIn,
    tokOut: r.stats.tokOut,
    reasoning: r.stats.tokReasoning ?? 0,
  }
}

async function main() {
  const anchor = process.argv[2] ?? "brightdata.com"
  const queries = Number(process.argv[3] ?? 20)
  const budget = Number(process.argv[4] ?? 12)
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

  const startUsage = await keyUsage()
  console.log(`${ARMS.length} arms against ${anchor}, ${queries} queries each, hard ceiling $${budget}`)
  console.log(`key has spent $${startUsage.toFixed(2)} before this run; nothing past $${budget} more\n`)
  let spent = 0

  for (const arm of ARMS) {
    // Measured from the key itself rather than from the arms' own reports, so a
    // run that under-reports its cost still counts against the ceiling.
    const real = (await keyUsage()) - startUsage
    if (real >= budget) {
      console.log(`stopping: the key has spent $${real.toFixed(2)} of the $${budget} ceiling`)
      break
    }
    if (spent >= budget) {
      console.log(`stopping: arms reported $${spent.toFixed(2)} of $${budget}`)
      break
    }

    console.log(`── ${arm.key}: ${arm.what}`)
    const t0 = Date.now()
    let row: Record<string, unknown>
    try {
      await run("pnpm", ["sweep", anchor, String(queries)], {
        env: { ...process.env, ...arm.env },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60_000,
      })
      const m = measure(anchor)
      spent += Number(m.usd ?? 0)
      row = { arm: arm.key, what: arm.what, env: arm.env, ok: true, ...m }
      console.log(
        `   ${m.products}p → ${m.markets}m · ${m.entities} entities ` +
          `(${m.competitors} rivals, ${m.substitutes} subs, ${m.communities} communities) · ` +
          `${m.edges} edges · $${Number(m.usd).toFixed(2)} · ${Math.round(Number(m.seconds))}s`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      row = { arm: arm.key, what: arm.what, env: arm.env, ok: false, error: msg.slice(0, 400) }
      console.log(`   FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${msg.slice(0, 140)}`)
    }
    appendFileSync(LOG, `${JSON.stringify({ ...row, anchor, queries })}\n`)
  }

  const finalUsage = await keyUsage()
  console.log(`\nspent $${(finalUsage - startUsage).toFixed(2)} by the key's own count. rows in ${LOG}`)
  console.log(`compare on QUALITY first (products, markets, substitutes, communities, unplaced),`)
  console.log(`then time, then cost. A cheap arm that mapped the wrong market has won nothing.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
