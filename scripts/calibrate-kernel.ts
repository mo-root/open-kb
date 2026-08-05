/**
 * Measure the aggregator threshold N from the maps this repo has already paid
 * for, before any code enforces it. Reads every runs/*.json, takes each host
 * the classifier labelled a company, fetches its front page once (direct,
 * free), and prints the distribution of distinct outbound registrable hosts —
 * competitor-labelled hosts against directory-labelled ones.
 *
 * If the two distributions do not separate, the aggregator rule ships disabled
 * (threshold null) rather than tuned into looking right. That outcome is a
 * finding, not a failure.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { outboundHosts, registrableHost } from "../packages/core/src/index.js"

const CONC = 8
const TIMEOUT_MS = 8_000

interface Row { host: string; kind: string; relation: string; outbound: number; ok: boolean }

const seen = new Map<string, { kind: string; relation: string }>()
for (const f of readdirSync("runs").filter((x) => x.endsWith(".json"))) {
  let j: { entities?: Array<{ domain?: string; name?: string; kind: string; relation: string }>; result?: { entities?: Array<{ domain?: string; name?: string; kind: string; relation: string }> } }
  try { j = JSON.parse(readFileSync(`runs/${f}`, "utf8")) } catch { continue }
  for (const e of j.entities ?? j.result?.entities ?? []) {
    const host = registrableHost(e.domain || e.name || "")
    if (!host || !host.includes(".")) continue
    if (e.kind === "company" || e.kind === "directory") seen.set(host, { kind: e.kind, relation: e.relation })
  }
}

console.log(`fetching ${seen.size} front pages, ${CONC} at a time, direct only`)
const rows: Row[] = []
const queue = [...seen.entries()]

async function worker(): Promise<void> {
  for (;;) {
    const next = queue.pop()
    if (!next) return
    const [host, meta] = next
    try {
      const res = await fetch(`https://${host}/`, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "Mozilla/5.0 (open-kb calibration)" },
      })
      const body = await res.text()
      rows.push({ host, ...meta, outbound: res.ok && body ? outboundHosts(body, `https://${host}/`).length : 0, ok: res.ok && body.length > 0 })
    } catch {
      rows.push({ host, ...meta, outbound: 0, ok: false })
    }
    if (rows.length % 25 === 0) console.log(`  ${rows.length}/${seen.size}`)
  }
}
await Promise.all(Array.from({ length: CONC }, worker))

const readable = rows.filter((r) => r.ok)
const companies = readable.filter((r) => r.kind === "company").map((r) => r.outbound).sort((a, b) => a - b)
const directories = readable.filter((r) => r.kind === "directory").map((r) => r.outbound).sort((a, b) => a - b)
const pct = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : NaN

console.log(`\ncompany-labelled   n=${companies.length}  p50=${pct(companies, 50)}  p90=${pct(companies, 90)}  p95=${pct(companies, 95)}`)
console.log(`directory-labelled n=${directories.length}  p10=${pct(directories, 10)}  p50=${pct(directories, 50)}`)

// Separation test: the companies' p95 must sit below the directories' p50.
const p95c = pct(companies, 95)
const p50d = pct(directories, 50)
const threshold = Number.isFinite(p95c) && Number.isFinite(p50d) && p95c < p50d
  ? Math.round((p95c + p50d) / 2)
  : null
const note = threshold
  ? `companies p95=${p95c} < directories p50=${p50d}; midpoint ${threshold}`
  : `no separation (companies p95=${p95c}, directories p50=${p50d}); ship the rule disabled`
console.log(`\nsuggestion: threshold=${threshold}  (${note})`)

mkdirSync("runs/experiments", { recursive: true })
writeFileSync("runs/experiments/kernel-calibration.json", JSON.stringify({ hosts: rows, suggestion: { threshold, note } }, null, 2))
