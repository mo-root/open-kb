/**
 * The knowledge lake leaves the app: a run file becomes a folder of markdown
 * an agent can walk and a person can read. The builder lives in core
 * (export-kb.ts) and is pure; this file is argv, mkdir and a console — the
 * split diff-runs and audit made.
 *
 * Usage:
 *   pnpm run export runs/<run>.json [outDir] [--force]
 *   pnpm run export --all           # every run in runs/, plus the lake INDEX
 *
 * Default outDir: runs/exports/kb-<anchor>/ (kb-<run> under --all). An export
 * is regenerated wholesale — it is a build artifact, so the target directory is
 * deleted before it is rewritten, and edits belong upstream in the engine. That
 * delete is only safe for a folder this tool wrote, so it is guarded: a target
 * that exists and is not a prior export is refused by name, and --force erases
 * it anyway. export-target.ts decides which is which, from what the exporter
 * writes. The lake INDEX links every exported map and pairs runs of one anchor
 * with the diff command that shows their drift.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exportKbFiles, type ExportRunLike, type ExportedFile } from "../packages/core/src/index.js"
import { exportTargetRefusal, judgeExportTarget } from "./export-target.js"

function loadRun(p: string): (ExportRunLike & { anchor?: string }) | null {
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ExportRunLike & { result?: ExportRunLike }
    const run = Array.isArray(raw.entities) ? raw : raw.result
    return run && Array.isArray(run.entities) ? run : null
  } catch {
    return null
  }
}

/** The command that would do what was just refused — the caller's own argv with
 *  the flag on the end, so the user reads back exactly what they typed. */
function retryWithForce(): string {
  const args = [...process.argv.slice(2), "--force"].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
  return `pnpm run export ${args.join(" ")}`
}

function writeExport(run: ExportRunLike, outDir: string, force: boolean): ExportedFile[] {
  // Guarded here rather than at the call sites: this is the line that deletes,
  // so every path into it — default, --all, or an argv the user typed — is
  // asked the same question, and a future caller cannot forget to ask it.
  const verdict = judgeExportTarget(outDir)
  if (!verdict.writable && !force) {
    for (const line of exportTargetRefusal(outDir, verdict, retryWithForce())) console.error(line)
    process.exit(1)
  }
  rmSync(outDir, { recursive: true, force: true })
  const files = exportKbFiles(run)
  for (const f of files) {
    const p = join(outDir, f.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, f.content)
  }
  return files
}

/**
 * How many entities a folder actually SHIPPED — the number its own README.md
 * opens with, read off the files that were written.
 *
 * The INDEX used to re-derive this as `run.entities` minus noise, and that is
 * the crawl, not the map. `exportKbFiles` gates seven classes (see
 * `DropReason`: noise, silent, withdrawn, unrelated, commentary, personal,
 * unexplained) and only the first was being subtracted here, so every row
 * overstated the folder it links to. Measured by running `exportKbFiles` over
 * the twelve maps in `demo/`: clerk 445 against 197 pages, supabase 1478
 * against 541, vercel 2333 against 968, cursor 881 against 379, and the
 * narrowest gap, shopify, still 1251 against 1065. Not one of the twelve
 * agreed. A reader clicked a "445 entities" row into a README that opens
 * "197 entities".
 *
 * Counted rather than re-derived because a re-derivation is a second copy of
 * the gate rules, kept in a file that does not own them — which is how this
 * drifted in the first place.
 */
const entityPages = (files: readonly ExportedFile[]): number =>
  files.filter((f) => f.path.startsWith("entities/")).length

const argv = process.argv.slice(2)
const force = argv.includes("--force")
// Only --force is filtered out of the positionals: --all is flag-shaped but
// arrives as runPath, and a blanket "drop anything starting with --" would eat it.
const [runPath, outArg] = argv.filter((a) => a !== "--force")
if (!runPath) {
  console.error("usage: pnpm run export runs/<run>.json [outDir] [--force] | --all")
  process.exit(1)
}

if (runPath === "--all") {
  const names = readdirSync("runs").filter((n) => /^(sweep|swarm)-.*\.json$/.test(n) && !n.endsWith(".spans.jsonl"))
  const rows: Array<{ anchor: string; source: string; dir: string; entities: number }> = []
  for (const name of names.sort()) {
    const run = loadRun(join("runs", name))
    if (!run) continue
    const dir = join("runs", "exports", `kb-${name.replace(/\.json$/, "")}`)
    const written = writeExport(run, dir, force)
    rows.push({ anchor: run.anchor ?? "?", source: `runs/${name}`, dir, entities: entityPages(written) })
    console.log(`${dir}  (${written.length} files)`)
  }
  const byAnchor = new Map<string, typeof rows>()
  for (const r of rows) byAnchor.set(r.anchor, [...(byAnchor.get(r.anchor) ?? []), r])
  const sections = [...byAnchor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([anchor, list]) => {
      const items = list.map((r) => `- [${r.source}](${r.dir.replace("runs/exports/", "")}/README.md) — ${r.entities} entities`)
      const drift =
        list.length > 1
          ? `\nDrift between runs: \`pnpm run diff ${list[list.length - 2]!.source} ${list[list.length - 1]!.source}\`\n`
          : ""
      return `## ${anchor}\n\n${items.join("\n")}\n${drift}`
    })
  writeFileSync(
    join("runs", "exports", "INDEX.md"),
    `# The knowledge lake\n\nEvery exported map, newest last. Each folder is self-describing: start at its\nREADME.md, or hand its SKILL.md to an agent.\n\n${sections.join("\n")}`,
  )
  console.log(`wrote runs/exports/INDEX.md (${rows.length} maps, ${byAnchor.size} anchors)`)
  process.exit(0)
}

const run = loadRun(runPath)
if (!run) {
  console.error(`${runPath} does not look like a run file (no entities array)`)
  process.exit(1)
}

const anchorSlug = (run.anchor ?? "map").replace(/\W+/g, "-")
const outDir = outArg ?? join("runs", "exports", `kb-${anchorSlug}`)
const exported = writeExport(run, outDir, force)
console.log(`wrote ${exported.length} files to ${outDir}`)
console.log(`start at ${join(outDir, "README.md")}`)
