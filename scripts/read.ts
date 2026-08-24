/**
 * Read a finished map, without opening the JSON.
 *
 * Writing the skill is what surfaced this. A skill can tell an agent to run a
 * sweep, and then the map is a 170KB file it has to parse before it can say
 * anything, which means every reader reinvents the same summary and an agent
 * burns context on a file format instead of on a market.
 *
 * So the run's own summary is a command. `--json` for a machine, plain text for
 * everyone else.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

interface Entity {
  name: string
  domain: string
  kind: string
  relation: string
  what: string
  why: string
}

interface Edge {
  from: string
  to: string
  relation: string
  why: string
  confidence: string
}

/** Accepts a domain, a run id, a filename or a path, because a reader who just
 *  ran `sweep brightdata.com` should not have to learn the file naming. */
function resolve(arg: string): string {
  if (arg.endsWith(".json")) return arg
  const dir = "runs"
  // `runs/` is gitignored, so a fresh clone — the exact moment a reader is
  // most likely to type `pnpm read <domain>` before ever running a sweep —
  // has none. readdirSync throws ENOENT on a MISSING directory (unlike an
  // empty one, which returns `[]` and falls through to the "no run matching"
  // message below, exactly as intended); this used to surface as a bare
  // stack trace instead of that message. Same mistake, same fix, in
  // bench.ts, run-doctor.ts, calibrate-kernel.ts, query-yield.ts, recall.ts
  // and corroboration-arrival.ts.
  const files = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json"))
  const slug = arg.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\W+/g, "-")
  const matches = files.filter((f) => f.includes(slug) || f.includes(arg))
  if (!matches.length) {
    throw new Error(`no run matching "${arg}". runs/ holds:\n  ${files.slice(-8).join("\n  ")}`)
  }
  // Newest wins: a domain mapped twice should read back as the latest attempt.
  // Run filenames end in a zero-padded timestamp (scripts/sweep.ts, scripts/swarm.ts),
  // so the lexical max of the filename IS the newest run — no file needs opening to
  // find it. (It used to open every match twice, once for a length and once for a
  // `mtime` built from `Date.parse("")`, always 0 — both discarded, never read.)
  const newest = [...matches].sort().at(-1)!
  return path.join(dir, newest)
}

const arg = process.argv[2]
if (!arg || arg === "--help") {
  console.log(`read a finished map

  pnpm read <domain|run-id|path>        the summary
  pnpm read <...> --entities            every entity, one per line
  pnpm read <...> --edges               how entities relate to each other
  pnpm read <...> --json                the whole thing, for a machine
`)
  process.exit(arg ? 0 : 1)
}

const file = resolve(arg)
const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
// Two shapes on disk: the CLI writes a bare result, the web writes an envelope.
const r = (parsed.result ?? parsed) as {
  anchor: string
  decomposition: { sells: string; buyer: string; capabilities?: { name: string; centrality?: string }[] }
  queries: { q: string; intent: string; market?: string }[]
  entities: Entity[]
  edges?: Edge[]
  stats: Record<string, number>
}

// `resolve` matches on substrings and gates on nothing but `.json`, so it can
// hand back a file that is not a map at all — an investigator run from
// demo-investigate.ts is {nodes, edges}, and `pnpm read demo` now reaches one.
// Without this the first use of `r.entities` was a bare TypeError; diff-runs.ts
// and audit.ts both refuse by name at this point, and this is their sentence.
if (!Array.isArray(r.entities)) {
  throw new Error(`${file}: no entities at the top level or under result — not a run file this reads`)
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}

const kept = r.entities.filter((e) => e.kind !== "noise")
const tally = (xs: string[]) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

if (process.argv.includes("--entities")) {
  for (const [rel] of tally(kept.map((e) => e.relation))) {
    console.log(`\n${rel}`)
    for (const e of kept.filter((x) => x.relation === rel)) {
      console.log(`  ${e.domain.padEnd(32)} ${e.kind.padEnd(10)} ${e.what.slice(0, 88)}`)
    }
  }
  process.exit(0)
}

if (process.argv.includes("--edges")) {
  const edges = r.edges ?? []
  if (!edges.length) {
    console.log("no entity-to-entity edges in this run.")
    process.exit(0)
  }
  for (const e of edges) {
    console.log(`  ${e.from.padEnd(28)} ${e.relation.padEnd(12)} ${e.to.padEnd(28)} [${e.confidence}] ${e.why.slice(0, 60)}`)
  }
  process.exit(0)
}

const s = r.stats
console.log(`${r.anchor}`)
console.log(`  sells   ${r.decomposition.sells}`)
console.log(`  buyer   ${r.decomposition.buyer}\n`)

if (r.decomposition.capabilities?.length) {
  console.log(`markets`)
  for (const c of r.decomposition.capabilities) {
    console.log(`  ${(c.centrality ?? "?").padEnd(9)} ${c.name}`)
  }
  console.log()
}

console.log(`the run`)
console.log(`  ${s.queries} queries → ${s.serpCalls} searches → ${s.results} results → ${s.hosts} hosts`)
console.log(`  ${kept.length} on the map, ${r.entities.length - kept.length} judged noise`)
console.log(`  $${(s.usd ?? 0).toFixed(2)} · ${Math.round(s.seconds ?? 0)}s\n`)

console.log(`by relation`)
for (const [k, n] of tally(kept.map((e) => e.relation))) console.log(`  ${String(n).padStart(4)}  ${k}`)
console.log(`\nby kind`)
for (const [k, n] of tally(kept.map((e) => e.kind))) console.log(`  ${String(n).padStart(4)}  ${k}`)

const edges = r.edges ?? []
console.log(`\n${edges.length} edges between entities` + (edges.length ? "" : "  (linking did not run)"))

console.log(`\nthe head of the map`)
for (const e of kept.filter((x) => x.relation === "competitor").slice(0, 12)) {
  console.log(`  ${e.domain.padEnd(30)} ${e.why.slice(0, 76)}`)
}
console.log(`\n  pnpm read ${arg} --entities   for all ${kept.length}`)
