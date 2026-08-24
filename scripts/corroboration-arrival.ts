/**
 * WHEN DOES A HOST EARN ITS CORROBORATION?
 *
 * `seenIn` — how many distinct queries returned a host — is the run's only
 * measure of whether the market agrees a host belongs. Four separate gates
 * read it, and one of them is irreversible: triage votes a host off the map,
 * and `TRIAGE_KEEP_SEENIN` (5) overrules that vote for any host the search
 * kept returning. A host dropped by triage is never judged and never appears.
 *
 * That gate runs AFTER the search, when every query has landed and `seenIn`
 * is final. This script exists to price a change that would move it: judging
 * hosts while the search tail still drains, so that rank — 25% to 41% of a
 * run's wall clock — stops waiting for the last SERP call.
 *
 * The question that decides whether that is safe is not about concurrency. It
 * is: HOW LATE DOES CORROBORATION ARRIVE? If a host that ends at `seenIn` 6
 * was already at 6 by the halfway point, judging early costs nothing. If it
 * was at 2, judging early triages it out for good.
 *
 *   npx tsx scripts/corroboration-arrival.ts            # every run
 *   npx tsx scripts/corroboration-arrival.ts --threshold 3
 *   npx tsx scripts/corroboration-arrival.ts --runs shopify
 *
 * WHAT IT SAID THE FIRST TIME, over the 42 runs on disk (2026-08-24):
 *
 *   2,975 hosts reached seenIn >= 5.
 *   49% of them reached it AFTER half the search had been bought.
 *   25% of them reached it in the FINAL QUARTER.
 *
 * The spread is narrow and every one of the 42 runs agrees: the per-run share
 * arriving late runs 38% to 69%, on anchors from resend to cloudflare and on
 * runs from 36 to 199 queries. This is not an artifact of one anchor or one
 * size.
 *
 * Nor of the threshold: at `--threshold 3` the same 42 runs give 48% and 23%
 * over 6,342 hosts.
 *
 * SO THE NAIVE VERSION OF THE CHANGE IS UNSAFE, and by a wide margin.
 * Triaging at the halfway point would irreversibly drop about half the hosts
 * the exemption exists to protect — the change would buy 25-41% of wall clock
 * by silently deleting corroborated hosts from the map.
 *
 * WHAT SURVIVES THE MEASUREMENT. Triage is a COST optimisation, not a quality
 * gate: it only ever removes hosts from the judge list, so a run that judged
 * every host and applied triage's verdict at the END, against final `seenIn`,
 * produces the same map it does today. That version can overlap safely. Its
 * price is the judge calls spent on hosts triage would have skipped —
 * measured at 3% of hosts on the one run that reports the pair
 * (resend, 281 found / 273 judged), which is a single small anchor and NOT a
 * number to build on. Instrumenting `hostsFound` against `hostsJudged` on a
 * large anchor is what that design needs next, and it costs one run.
 *
 * Rank is model-bound, not fetch-bound, so there is no cheaper version that
 * merely prefetches pages: cloudflare's 337-second rank made 0 unlocker calls
 * against 4.2M input tokens.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { registrableHost } from "../packages/core/src/index.js"

const arg = (name: string, fallback: string) =>
  process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] ?? fallback) : fallback

const THRESHOLD = Number(arg("--threshold", "5")) || 5
const ONLY = arg("--runs", "")
const runsDir = join(process.cwd(), "runs")

const hostOf = (u: string): string => {
  try { return registrableHost(new URL(u).hostname.toLowerCase()) } catch { return "" }
}

interface Row { run: string; queries: number; hosts: number; reached: number; late: number; veryLate: number }
const rows: Row[] = []

for (const f of readdirSync(runsDir).filter((f) => f.startsWith("sweep-") && f.endsWith(".json"))) {
  if (ONLY && !f.includes(ONLY)) continue
  let r: { searched?: { hits?: { url: string }[] }[] }
  try { r = JSON.parse(readFileSync(join(runsDir, f), "utf8")) } catch { continue }
  const searched = r.searched
  // A run too short to have a first and second half says nothing about when
  // corroboration arrives.
  if (!Array.isArray(searched) || searched.length < 20) continue

  const seen = new Map<string, number>()
  /** The fraction of the search bought when this host first hit THRESHOLD. */
  const reachedAt = new Map<string, number>()

  searched.forEach((s, i) => {
    // Distinct hosts per query: `seenIn` counts QUERIES that returned a host,
    // not hits, so two hits from one host on one query count once.
    const hosts = new Set((s.hits ?? []).map((h) => hostOf(h.url)).filter(Boolean))
    for (const h of hosts) {
      const n = (seen.get(h) ?? 0) + 1
      seen.set(h, n)
      if (n === THRESHOLD && !reachedAt.has(h)) reachedAt.set(h, i / searched.length)
    }
  })

  if (!reachedAt.size) continue
  const at = [...reachedAt.values()]
  rows.push({
    run: f.replace(/^sweep-|\.json$/g, ""),
    queries: searched.length,
    hosts: seen.size,
    reached: reachedAt.size,
    late: at.filter((x) => x > 0.5).length,
    veryLate: at.filter((x) => x > 0.75).length,
  })
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—")

console.log(`\n${rows.length} runs in runs/ — when hosts reach seenIn >= ${THRESHOLD}\n`)
console.log(
  "  " + "run".padEnd(32) + "queries".padStart(8) + "hosts".padStart(7) +
  `seenIn>=${THRESHOLD}`.padStart(11) + "after 50%".padStart(12) + "after 75%".padStart(12),
)
for (const r of rows.sort((a, b) => b.late / b.reached - a.late / a.reached)) {
  console.log(
    "  " + r.run.padEnd(32) + String(r.queries).padStart(8) + String(r.hosts).padStart(7) +
    String(r.reached).padStart(11) + pct(r.late, r.reached).padStart(12) + pct(r.veryLate, r.reached).padStart(12),
  )
}

const sum = (k: keyof Row) => rows.reduce((n, r) => n + (r[k] as number), 0)
const reached = sum("reached")
console.log(
  `\n  ${reached} hosts reached seenIn >= ${THRESHOLD} across ${rows.length} runs — ` +
  `${pct(sum("late"), reached)} of them after half the search, ${pct(sum("veryLate"), reached)} in the final quarter.`,
)
console.log(
  `\n  A gate that reads seenIn cannot be moved earlier than the share above\n` +
  `  without dropping those hosts. See the header for which version survives.\n`,
)
