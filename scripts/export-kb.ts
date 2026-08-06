/**
 * The knowledge lake leaves the app: a run file becomes a folder of markdown
 * an agent can walk and a person can read. The builder lives in core
 * (export-kb.ts) and is pure; this file is argv, mkdir and a console — the
 * split diff-runs and audit made.
 *
 * Usage:
 *   pnpm run export runs/<run>.json [outDir]
 *   pnpm run export --all           # every run in runs/, plus the lake INDEX
 *
 * Default outDir: runs/exports/kb-<anchor>-<stamp>/ (regenerated wholesale —
 * the export is a build artifact; edits belong upstream in the engine). The
 * lake INDEX links every exported map and pairs runs of one anchor with the
 * diff command that shows their drift.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exportKbFiles, type ExportRunLike } from "../packages/core/src/index.js"

function loadRun(p: string): (ExportRunLike & { anchor?: string }) | null {
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ExportRunLike & { result?: ExportRunLike }
    const run = Array.isArray(raw.entities) ? raw : raw.result
    return run && Array.isArray(run.entities) ? run : null
  } catch {
    return null
  }
}

function writeExport(run: ExportRunLike, outDir: string): number {
  rmSync(outDir, { recursive: true, force: true })
  const files = exportKbFiles(run)
  for (const f of files) {
    const p = join(outDir, f.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, f.content)
  }
  return files.length
}

const [runPath, outArg] = process.argv.slice(2)
if (!runPath) {
  console.error("usage: pnpm run export runs/<run>.json [outDir] | --all")
  process.exit(1)
}

if (runPath === "--all") {
  const names = readdirSync("runs").filter((n) => /^(sweep|swarm)-.*\.json$/.test(n) && !n.endsWith(".spans.jsonl"))
  const rows: Array<{ anchor: string; source: string; dir: string; entities: number }> = []
  for (const name of names.sort()) {
    const run = loadRun(join("runs", name))
    if (!run) continue
    const dir = join("runs", "exports", `kb-${name.replace(/\.json$/, "")}`)
    const n = writeExport(run, dir)
    rows.push({ anchor: run.anchor ?? "?", source: `runs/${name}`, dir, entities: run.entities.filter((e) => e.kind !== "noise").length })
    console.log(`${dir}  (${n} files)`)
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
const n = writeExport(run, outDir)
console.log(`wrote ${n} files to ${outDir}`)
console.log(`start at ${join(outDir, "README.md")}`)
