/**
 * What each query actually bought.
 *
 * Every run file carries `searched`: one row per query fired, with its family,
 * intent, platform, cost and the hits it returned. Every run file also carries
 * the entities those hits became. Joining the two answers the question the
 * spend report cannot: not "what did search cost" but "what did each KIND of
 * query buy, and was it the market or the press?"
 *
 * Three measures, in increasing order of usefulness:
 *
 *   kept    — hosts that survived to the map. Nearly worthless as a signal:
 *             the gate is loose by design and ~90% of hosts survive whatever
 *             asked for them.
 *   fresh   — hosts this query was the FIRST in its run to surface. Measures
 *             redundancy. Also undramatic: only 5% of queries add nothing.
 *   market  — of those fresh hosts, the share that became a market entity
 *             (competitor, substitute, adjacent, dependency, integration,
 *             buyer, target, shaper) rather than a channel one (covers, lists,
 *             discusses) or noise. This is the one that separates families.
 *
 * Read the market column against POSITION, not in aggregate: later queries
 * face a fuller map, so a family that fires late looks worse than it is.
 * `--by position` controls for that.
 *
 *   npx tsx scripts/query-yield.ts               # by family
 *   npx tsx scripts/query-yield.ts --by position # family x position band
 *   npx tsx scripts/query-yield.ts --by intent
 *   npx tsx scripts/query-yield.ts --by platform   # what was ASKED for, see below
 *
 * WHAT IT SAID THE FIRST TIME, over the 26 runs on disk (2026-08-23):
 *
 *   family      queries   fresh   market   channel   $/market
 *   plain          1001   10197      50%       24%    $0.0011
 *   rival           263    1809      48%       35%    $0.0014
 *   branded         165    1580      41%       29%    $0.0015
 *   debranded      1374   13835      40%       31%    $0.0015
 *
 * `plain` is six hardcoded templates over a stripped term — the bare term,
 * `<term> alternatives`, `best <term>`, `<term> vs`, `top <term> companies`,
 * `open source <term>`. `debranded` is the model writing its own. The
 * templates buy market entities at fifty percent against the model's forty,
 * for two thirds of the price, and `--by position` shows the gap holding in
 * every band: 55/43 in the first twenty-five queries, 47/42, 46/38, 46/34.
 * It is not a saturation artifact.
 *
 * Some of that gap is the division of labour working as designed — one of
 * catalog.md's five debranded shapes goes looking for where buyers argue, and
 * a forum is a channel entity by definition (debranded/community: 36% market,
 * 35% channel). But not all of it: head to head on the SAME intent,
 * plain/evaluation buys 50% market where debranded/evaluation buys 35%.
 *
 * The platform column needs reading carefully, and the first draft of this
 * comment got it wrong. `platform` is what the catalog agent ASKED for, not
 * what went on the wire: `platformScope` defaults to 0, so no query is ever
 * rendered with its `site:` prefix (SweepOptions.platformScope carries the
 * measurement behind that default). Every row below is an ordinary web search
 * whose TEXT was written in a community register — a support-forum symptom, a
 * thread title — and that text is what these numbers are about:
 *
 *   asked-for platform   barren   market   $/market
 *   web                      3%      46%    $0.0013
 *   reddit                  20%      40%    $0.0020
 *   hackernews              21%      37%    $0.0026
 *   stackoverflow           10%      33%    $0.0020
 *
 * So: not "site: scoping is expensive" — it is already off. The finding is
 * that the community-shaped queries catalog.md's fourth shape asks for
 * ("where this product's buyers argue") go barren four to seven times more
 * often than a plain web query and buy market hosts at about twice the price.
 * Sampled, those queries read like `ipad POS offline mode not syncing` — narrow
 * enough that they land on the same handful of support hosts run after run.
 *
 * None of this is a reason to delete a family — every one of them buys market
 * hosts nothing else found, and the two weakest are aimed at the tail on
 * purpose. It is a reason to be deliberate about the MIX, and to measure a
 * change to it here rather than argue about it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const MARKET = new Set(["competitor", "substitute", "adjacent", "shaper", "dependency", "integration", "buyer", "target"])
const CHANNEL = new Set(["covers", "lists", "discusses"])

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
}

interface Cell { q: number; usd: number; fresh: number; market: number; channel: number; other: number; barren: number }
const cell = (): Cell => ({ q: 0, usd: 0, fresh: 0, market: 0, channel: 0, other: 0, barren: 0 })

/** Which position band a query sits in — the saturation control. */
const band = (i: number) => (i < 25 ? "  0-24" : i < 50 ? " 25-49" : i < 100 ? " 50-99" : i < 200 ? "100-199" : "   200+")

const runsDir = join(process.cwd(), "runs")
const by = process.argv.includes("--by") ? process.argv[process.argv.indexOf("--by") + 1] : "family"
const MIN_FRESH = 150

const tally: Record<string, Cell> = {}
let runs = 0

for (const f of readdirSync(runsDir).filter((f) => f.startsWith("sweep-") && f.endsWith(".json"))) {
  let r: { searched?: any[]; entities?: any[] }
  try { r = JSON.parse(readFileSync(join(runsDir, f), "utf8")) } catch { continue }
  if (!Array.isArray(r.searched) || !Array.isArray(r.entities)) continue
  runs++
  // A host's verdict, by domain. `noise` is a kind, not a relation, so it is
  // folded in here rather than left to look like a missing row.
  const verdict = new Map<string, string>(r.entities.map((e: any) => [e.domain, e.kind === "noise" ? "noise" : e.relation]))
  const seen = new Set<string>()
  r.searched.forEach((s: any, i: number) => {
    const hosts = [...new Set((s.hits ?? []).map((h: any) => hostOf(h.url)).filter(Boolean))] as string[]
    const fresh = hosts.filter((h) => !seen.has(h))
    hosts.forEach((h) => seen.add(h))
    const key =
      by === "position" ? `${band(i)} · ${s.family ?? "?"}`
      : by === "platform" ? (s.platform ?? "?")
      : by === "intent" ? (s.intent ?? "?")
      : (s.family ?? "?")
    const c = (tally[key] ??= cell())
    c.q++
    c.usd += s.usd ?? 0
    c.fresh += fresh.length
    if (fresh.length === 0) c.barren++
    for (const h of fresh) {
      const v = verdict.get(h)
      if (v && MARKET.has(v)) c.market++
      else if (v && CHANNEL.has(v)) c.channel++
      else c.other++
    }
  })
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—")
console.log(`\n${runs} runs in runs/ — what each query bought\n`)
console.log(
  "  " + "key".padEnd(24) + "queries".padStart(8) + "spend".padStart(9) + "fresh".padStart(8) +
  "market".padStart(9) + "channel".padStart(9) + "noise".padStart(8) + "barren".padStart(8) + "$/market".padStart(11),
)
const rows = Object.entries(tally).filter(([, c]) => c.fresh >= MIN_FRESH)
for (const [k, c] of by === "position" ? rows.sort((a, b) => a[0].localeCompare(b[0])) : rows.sort((a, b) => b[1].market / b[1].fresh - a[1].market / a[1].fresh)) {
  console.log(
    "  " + k.padEnd(24) + String(c.q).padStart(8) + `$${c.usd.toFixed(2)}`.padStart(9) + String(c.fresh).padStart(8) +
    pct(c.market, c.fresh).padStart(9) + pct(c.channel, c.fresh).padStart(9) + pct(c.other, c.fresh).padStart(8) +
    pct(c.barren, c.q).padStart(8) + `$${(c.usd / (c.market || 1)).toFixed(4)}`.padStart(11),
  )
}
console.log(`\n  market  = fresh hosts that became a market entity, not press or noise`)
console.log(`  barren  = queries that surfaced no host the run had not already seen`)
console.log(`  rows under ${MIN_FRESH} fresh hosts are omitted\n`)
