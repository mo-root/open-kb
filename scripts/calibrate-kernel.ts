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
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { outboundHosts, registrableHost } from "../packages/core/src/index.js"

const CONC = 8
const TIMEOUT_MS = 8_000

interface Row { host: string; kind: string; relation: string; outbound: number; ok: boolean }

/** One classified row, in either of the two shapes a map lands on disk in. */
interface Labelled { domain?: string; name?: string; kind: string; relation: string }
interface MapFile { entities?: Labelled[]; result?: { entities?: Labelled[] } }

/**
 * The three prefixes a market map can arrive under: `run-` from the browser,
 * `sweep-` and `swarm-` from the two CLIs. packages/web/lib/runs.ts admits exactly
 * these three, and this is that claim made a second time rather than a new one.
 *
 * This script was the only reader of `runs/` gating on nothing but `.json`, and the two
 * files that prove why that matters are still on disk: runs/resend-com.json and
 * runs/stripe-com.json are unstamped demo-investigate output, `{nodes, edges}` with
 * no entities at either level, and they were reaching the read below and contributing
 * nothing through a `?? []`. Silence is the specific hazard here — this script
 * CALIBRATES a threshold, so a map that quietly drops out of the sample moves the
 * number it prints and never says it did.
 */
const MAP_PREFIXES = ["run-", "sweep-", "swarm-"]

const seen = new Map<string, { kind: string; relation: string }>()
// `runs/` is gitignored, so a clean checkout has none — readdirSync throws
// ENOENT on a missing directory (unlike an empty one, which returns `[]`),
// which used to crash this script before it ever reached a file. Measured:
// scripts/read.ts, bench.ts, run-doctor.ts, query-yield.ts, recall.ts and
// corroboration-arrival.ts all made the identical mistake — see their own
// comments at the same fix.
for (const f of (existsSync("runs") ? readdirSync("runs") : []).filter(
  (x) => x.endsWith(".json") && MAP_PREFIXES.some((p) => x.startsWith(p)),
)) {
  // Past the name gate, a file that will not parse or carries no entities is an error
  // rather than a skip. diff-runs.ts:38 and audit.ts:51 refuse by name at exactly this
  // point, read.ts joined them in b6ffd99, and this is their sentence — the only
  // difference is that they judge the one file a reader asked for and this judges every
  // map in the directory.
  //
  // Measured before it was written, because a refusal added to a bulk reader is a way
  // to break a working script: all 69 prefixed files in `runs/` clear both checks, and
  // the only two in the directory that fail either are the two the prefix already
  // excludes.
  let j: MapFile
  try {
    j = JSON.parse(readFileSync(`runs/${f}`, "utf8")) as MapFile
  } catch (e) {
    throw new Error(`runs/${f}: ${(e as Error).message} — a named map that will not parse is a hole in the sample`)
  }
  const entities = j.entities ?? j.result?.entities
  if (!Array.isArray(entities)) {
    throw new Error(`runs/${f}: no entities at the top level or under result — not a run file this reads`)
  }
  for (const e of entities) {
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
