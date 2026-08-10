/**
 * Map many markets in a row, and stop before the money runs out.
 *
 * Everything measured so far comes from two companies, both of which publish an
 * llms.txt and both of which sell developer tools. Every number in this repo's
 * comments is therefore a number about brightdata.com and resend.com, and the
 * tool is supposed to map an industrial pump manufacturer just as well.
 *
 * This runs the real pipeline across a deliberately awkward spread and writes
 * one row per run, so the next morning's question is "which markets does it
 * fail on and how" rather than "how did it feel".
 *
 * It is budget-capped, not time-capped. The cap is read from OpenRouter before
 * every run and the loop stops while there is still headroom, because a run cut
 * off by a 402 mid-classification wastes everything it already bought.
 */
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * The spread. Chosen so failure is informative rather than flattering:
 * companies with no llms.txt, non-developer markets, physical goods, regulated
 * industries, single-product firms and sprawling multi-product ones.
 */
const TARGETS = [
  // developer tools, the case already known to work. The control.
  { domain: "resend.com", why: "single product, small llms.txt, known-good control" },
  { domain: "clerk.com", why: "single product, crowded market, many near-identical rivals" },
  { domain: "temporal.io", why: "OSS core with a paid cloud, substitute-heavy" },

  // developer tools that broke discovery in an earlier probe
  { domain: "figma.com", why: "no llms.txt: catalog lives in embedded page JSON" },
  { domain: "airtable.com", why: "no root llms.txt, sitemap signal inverted, slugs are not product names" },

  // sprawling multi-product, where capability grouping earns or fails
  { domain: "cloudflare.com", why: "very many products, several distinct markets" },
  { domain: "twilio.com", why: "2.2MB llms.txt, tests condense() at the top end" },

  // AI-native, where the demand-wave angle should light up
  { domain: "langchain.com", why: "agent harness: should surface as a distribution channel, not a rival" },
  { domain: "modal.com", why: "young market, little settled comparison content" },

  // NOT developer tools. The real test of generality.
  { domain: "gusto.com", why: "payroll: business software, non-technical buyer" },
  { domain: "toast.com", why: "restaurant POS: hardware plus software, local market" },
  { domain: "flexport.com", why: "freight forwarding: logistics, regulated, no dev docs" },
  { domain: "grundfos.com", why: "industrial pumps: physical goods, no developer surface at all" },
  { domain: "zoll.com", why: "medical devices: regulated, gatekeeper is a certifying body" },
  { domain: "mcmaster.com", why: "industrial distribution: catalog is the product" },
]

const OUT = "runs/overnight"
const LOG = `${OUT}/results.jsonl`

/** Stop while there is still room for a whole run. A sweep cut off by a 402
 *  mid-classification has bought every search and kept none of them. */
const RESERVE_USD = 3

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

async function headroom(): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  })
  if (!res.ok) throw new Error(`could not read key limit: ${res.status}`)
  const { data } = (await res.json()) as { data: { limit: number | null; usage: number } }
  return data.limit === null ? Number.POSITIVE_INFINITY : data.limit - data.usage
}

async function main() {
  const budget = Number(process.argv[2] ?? 15)
  const queries = Number(process.argv[3] ?? 30)
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

  const startUsage = await keyUsage()
  const left = await headroom()
  console.log(`hard ceiling $${budget} · ${queries} queries per map · ${TARGETS.length} targets`)
  if (Number.isFinite(left) && left < RESERVE_USD) {
    console.log(`the key has $${left.toFixed(2)} of its own headroom, below the $${RESERVE_USD} reserve. stopping.`)
    return
  }
  console.log(`key has spent $${startUsage.toFixed(2)} before this batch\n`)

  let spent = 0
  for (const t of TARGETS) {
    // The key's own count, so an under-reporting run still hits the ceiling.
    const real = (await keyUsage()) - startUsage
    if (real >= budget) {
      console.log(`\nstopping: the key has spent $${real.toFixed(2)} of the $${budget} ceiling`)
      break
    }
    if (Number.isFinite(await headroom()) && (await headroom()) < RESERVE_USD) {
      console.log(`\nstopping: below the $${RESERVE_USD} reserve on the key itself`)
      break
    }

    const t0 = Date.now()
    console.log(`── ${t.domain}  (${t.why})`)
    let row: Record<string, unknown>
    try {
      const { stdout } = await run("pnpm", ["sweep", t.domain, String(queries)], {
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60_000,
      })
      // The CLI's own summary line is the contract: "$1.23 · 456s"
      const usd = Number(/\$([\d.]+) ·/.exec(stdout)?.[1] ?? 0)
      const secs = Number(/· (\d+)s/.exec(stdout)?.[1] ?? 0)
      const kept = Number(/(\d+) on the map/.exec(stdout)?.[1] ?? 0)
      const hosts = Number(/from (\d+) hosts/.exec(stdout)?.[1] ?? 0)
      const markets = Number(/→ (\d+) distinct markets/.exec(stdout)?.[1] ?? 0)
      const products = Number(/(\d+) products →/.exec(stdout)?.[1] ?? 0)
      const uncovered = /no queries for (\d+) of/.exec(stdout)?.[1] ?? "0"
      spent += usd
      row = { domain: t.domain, why: t.why, ok: true, usd, secs, kept, hosts, products, markets, uncovered: Number(uncovered) }
      console.log(`   ${kept} entities from ${hosts} hosts · ${products}p → ${markets} markets · $${usd.toFixed(2)} · ${secs}s`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      row = { domain: t.domain, why: t.why, ok: false, error: msg.slice(0, 400), secs: (Date.now() - t0) / 1000 }
      console.log(`   FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${msg.slice(0, 160)}`)
    }
    appendFileSync(LOG, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`)
  }

  console.log(`\nspent $${((await keyUsage()) - startUsage).toFixed(2)} by the key's own count. rows in ${LOG}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
