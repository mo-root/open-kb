/**
 * The knowledge lake leaves the app: a run file becomes a folder of markdown
 * an agent can walk and a person can read. The builder lives in core
 * (export-kb.ts) and is pure; this file is argv, mkdir and a console — the
 * split diff-runs and audit made.
 *
 * Usage:
 *   pnpm run export runs/<run>.json [outDir]
 *
 * Default outDir: runs/exports/kb-<anchor>/ (regenerated wholesale — the
 * export is a build artifact; edits belong upstream in the engine).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exportKbFiles, type ExportRunLike } from "../packages/core/src/index.js"

const [runPath, outArg] = process.argv.slice(2)
if (!runPath) {
  console.error("usage: pnpm run export runs/<run>.json [outDir]")
  process.exit(1)
}

const raw = JSON.parse(readFileSync(runPath, "utf8")) as ExportRunLike & { result?: ExportRunLike }
const run = Array.isArray(raw.entities) ? raw : raw.result // kernel wrapper shape
if (!run || !Array.isArray(run.entities)) {
  console.error(`${runPath} does not look like a run file (no entities array)`)
  process.exit(1)
}

const anchorSlug = (run.anchor ?? "map").replace(/\W+/g, "-")
const outDir = outArg ?? join("runs", "exports", `kb-${anchorSlug}`)
rmSync(outDir, { recursive: true, force: true })

const files = exportKbFiles(run)
for (const f of files) {
  const p = join(outDir, f.path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, f.content)
}
console.log(`wrote ${files.length} files to ${outDir}`)
console.log(`start at ${join(outDir, "README.md")}`)
