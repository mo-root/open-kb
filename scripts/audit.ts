/**
 * The spot-audit, formalized. The 3.3% and 0% that gate this project were
 * minted by a one-off agent workflow whose second reviewer only ever re-read
 * "wrong" verdicts — a correction that can only lower the rate. This script
 * makes the audit a repeatable instrument (the same move calibrate-kernel.ts
 * made for the aggregator threshold: measured, not guessed): it deals a
 * deterministic sample as a fillable packet, and it scores a filled packet
 * only when the verdicts were reviewed symmetrically — printing the Wilson
 * interval beside the rate, always, because "3.3%" at n=30 is really
 * "0.6%-16.7%".
 *
 * The sample is seeded by the run id (the run file's basename — the CLI
 * stamps every run its own file, so the name IS the run's identity; run files
 * carry no id field). Same run, same N: same sample — re-audits must hit the
 * same entities to be comparable, and growing N only appends rows.
 *
 * All logic lives in packages/core/src/audit.ts (pure, purity-gated, tested);
 * this file is argv, JSON files and a console, the split diff-runs made.
 *
 * Usage:
 *   pnpm run audit runs/<run>.json [--n 30] [--relations competitor,substitute]
 *   pnpm run audit --score runs/experiments/audit-<run>-<N>.json
 *
 * It must be `pnpm run audit` — bare `pnpm audit` invokes pnpm's own
 * dependency auditor, not this script.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import { buildAuditPacket, scoreAuditPacket, type AuditEntityRow, type AuditPacket, type AuditPacketRow } from "../packages/core/src/index.js"

/** Sniff one already-parsed run file into rows: top-level entities (sweep,
 *  swarm) or the kernel wrapper's `result` — the same two shapes diff-runs
 *  and read.ts each sniff their own way. Pulled out of `readEntities` below
 *  the same way `parseRun` was pulled out of diff-runs.ts's CLI body: a pure
 *  function the `readFileSync` at the call site hands off to, so the shape
 *  check is reachable by a test process instead of only running at import
 *  time behind argv. Found sweeping `scripts/*.ts beyond sweep.ts` (D-scope:
 *  "areas nobody has swept") — this file had no test of its own; the packet
 *  builder/scorer it calls into (`packages/core/src/audit.ts`) already does. */
export function sniffEntities(path: string, json: { entities?: AuditEntityRow[]; result?: { entities?: AuditEntityRow[] } }): AuditEntityRow[] {
  const entities = Array.isArray(json.entities) ? json.entities : Array.isArray(json.result?.entities) ? json.result.entities : null
  if (!entities) throw new Error(`${path}: no entities at the top level or under result — not a run file this reads`)
  return entities
}

const args = process.argv.slice(2)
const usage = (): never => {
  console.error("usage: pnpm run audit <run.json> [--n 30] [--relations competitor,substitute]")
  console.error("       pnpm run audit --score <audit-packet.json>")
  process.exit(1)
}

const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

/** Read one run file off disk and sniff it. The `readFileSync` half of what
 *  used to be `readEntities` — kept behind the `invokedDirectly` guard below
 *  so nothing here touches disk at import time. */
function readEntities(path: string): AuditEntityRow[] {
  return sniffEntities(path, JSON.parse(readFileSync(path, "utf8")))
}

function printRow(row: AuditPacketRow, index: number): void {
  const e = row.entity
  const head = [e.relation ?? "?", e.kind, e.tier].filter(Boolean).join("  ")
  console.log(`${String(index + 1).padStart(3)}. ${e.name} (${e.domain ?? row.key})  ${head}`)
  if (e.what) console.log(`     what: ${e.what}`)
  if (e.why) console.log(`     why:  ${e.why}`)
  if (e.because) console.log(`     because: ${e.because}`)
  if (e.descSpans) console.log(`     descSpans: ${e.descSpans.verified}/${e.descSpans.claimed} verified`)
  if (e.spans?.length) for (const span of e.spans) console.log(`     span: "${span}"`)
  console.log(`     verdict: _  errorKind: _  evidence: _  reviewer: _`)
}

const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {
  if (args.includes("--score")) {
    const packetFile = args.filter((a) => a !== "--score")[0] ?? usage()
    const packet = JSON.parse(readFileSync(packetFile, "utf8")) as AuditPacket
    const out = scoreAuditPacket(packet)
    console.log(`${packetFile}  (run ${packet.runFile}, ${packet.rows.length} rows)`)
    console.log()
    if (!out.scored) {
      console.log(`refused to score — ${out.refusals.length} ${out.refusals.length === 1 ? "gap" : "gaps"}:`)
      for (const refusal of out.refusals) console.log(`  ${refusal}`)
      process.exit(1)
    }
    for (const line of out.sentences) console.log(line)
  } else {
    const runFile = args.find((a) => !a.startsWith("--") && a !== flag("n") && a !== flag("relations")) ?? usage()
    const n = Number(flag("n") ?? 30)
    if (!Number.isInteger(n) || n <= 0) usage()
    const relations = (flag("relations") ?? "competitor,substitute").split(",").map((r) => r.trim()).filter(Boolean)

    const runId = basename(runFile).replace(/\.json$/, "")
    const packet = buildAuditPacket({ entities: readEntities(runFile) }, { runFile, runId, n, relations })

    const outPath = `runs/experiments/audit-${runId}-${n}.json`
    if (existsSync(outPath)) {
      console.error(`${outPath} already exists — a packet may hold filled verdicts; score it or delete it first`)
      process.exit(1)
    }

    const byRelation = new Map<string, number>()
    for (const row of packet.rows) {
      const relation = row.entity.relation ?? "?"
      byRelation.set(relation, (byRelation.get(relation) ?? 0) + 1)
    }
    const split = [...byRelation.entries()].map(([relation, count]) => `${count} ${relation}`).join(", ")
    console.log(`${runFile}: sampled ${packet.rows.length} of ${n} requested (${split}) — seed ${runId}`)
    console.log()
    for (const [index, row] of packet.rows.entries()) printRow(row, index)

    mkdirSync("runs/experiments", { recursive: true })
    writeFileSync(outPath, JSON.stringify(packet, null, 2) + "\n")
    console.log()
    console.log(`packet written to ${outPath}`)
    console.log(`fill every row's verdict/reviewer (errorKind + evidence on wrongs), declare secondReview, then:`)
    console.log(`  pnpm run audit --score ${outPath}`)
  }
}
