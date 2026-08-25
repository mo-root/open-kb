import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * `runs/` is gitignored, so a fresh clone — this branch's own sandboxed
 * overnight fires included, verified by running every script below from a
 * scratch directory with no `runs/` at all — has none. `readdirSync` throws
 * `ENOENT` on a MISSING directory, unlike an empty one, which returns `[]`
 * and falls through to whatever message the caller already wrote for "no
 * runs found". Nine call sites across eight scripts made the same mistake:
 * `readdirSync(runsDir)` unguarded, so the first thing a reader who clones
 * the repo and types `pnpm read some.com`, `npx tsx scripts/recall.ts`, or
 * any of the others — before ever running a sweep — saw was a raw Node
 * stack trace, "Error: ENOENT: no such file or directory, scandir 'runs'",
 * instead of the friendly message each script had already written for
 * "nothing to read yet".
 *
 * `scripts/audit.ts` and `scripts/diff-runs.ts` do not share the bug: both
 * take an explicit run-file path on argv rather than scanning the
 * directory, so a missing file there is the reader's own typo, named by
 * path, not this failure mode.
 *
 * `scripts/export-kb.ts --all` was the eighth script and was missed by the
 * pass that fixed the first seven — same `readdirSync("runs")` unguarded in
 * its own directory scan, found later sweeping `scripts/*.ts` for D-scope
 * coverage gaps. It carries a second, related crash the other seven do not:
 * with zero run files (a missing OR an empty `runs/`) the per-row export
 * loop that would otherwise create `runs/exports/` never runs, so the
 * unconditional `writeFileSync(.../INDEX.md, ...)` right after it threw its
 * own ENOENT on the missing PARENT directory — same failure class, one
 * script downstream of the first guard. Fixed with an unconditional
 * `mkdirSync(runs/exports, {recursive:true})` ahead of that write.
 *
 * `bench.ts` carried a THIRD, separate crash of its own, noted but not fixed
 * when the first seven were: its `readdirSync` guard above was always fine,
 * but with zero runs read its provenance footer computed
 * `Math.min(...ts)`/`Math.max(...ts)` over an empty array — `Infinity` and
 * `-Infinity` — and handed them to `new Date(...).toISOString()`, which
 * throws `RangeError: Invalid time value` on a non-finite input. Reproduced
 * from a scratch directory with no `runs/` at all before this fix: `pnpm
 * bench` crashed with that RangeError instead of printing its report.
 * `day()`, the same file's own helper for this exact shape of gap, already
 * reads `null` as "—"; the fix is passing it null when there are no
 * timestamps to span rather than teaching it a second empty-input shape.
 *
 * None of the seven can be imported directly in a test process — read.ts,
 * bench.ts, calibrate-kernel.ts, query-yield.ts, recall.ts,
 * corroboration-arrival.ts and export-kb.ts all act on real `process.argv`
 * (or, for calibrate-kernel.ts, fetch live pages) at module scope, the same
 * reason `tests/four-readers-refuse-a-non-run-file-with-one-sentence.test.ts`
 * checks its four by source text rather than by running them. Source text
 * proves the guard is present at every site; the subprocess runs below prove
 * the guard actually produces the intended message rather than some other
 * crash — run-doctor.ts's own `diagnose` is import-safe (it is gated behind
 * `invokedDirectly`, see run-doctor.test.ts), but the fixed line lives in
 * the CLI-only branch that guard exists to skip on import, so it needs the
 * same subprocess proof as the rest.
 */

const scriptPath = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url))
const source = (name: string) => readFileSync(scriptPath(name), "utf8")
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))

/** Runs a script from a scratch directory with no `runs/` inside it, and
 *  reports how it ended rather than throwing vitest's own diff on a
 *  non-zero exit — every script here is expected to exit non-zero except
 *  run-doctor.ts, and the assertion is about the MESSAGE, not the code. */
function runInEmptyClone(script: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "openkb-fresh-clone-"))
  try {
    try {
      const stdout = execFileSync(tsx, [scriptPath(script), ...args], { cwd: dir, encoding: "utf8" })
      return { status: 0, stdout, stderr: "" }
    } catch (e) {
      const err = e as { status: number | null; stdout?: string; stderr?: string }
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("a missing runs/ directory no longer crashes the scripts that scan it", () => {
  it.each([
    ["read.ts", 'const files = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json"))'],
    ["bench.ts", "const files = (existsSync(DIR) ? readdirSync(DIR) : [])"],
    ["run-doctor.ts", "const files = (existsSync(runsDir) ? readdirSync(runsDir) : [])"],
    ["calibrate-kernel.ts", 'for (const f of (existsSync("runs") ? readdirSync("runs") : []).filter('],
    ["query-yield.ts", "const files = (existsSync(runsDir) ? readdirSync(runsDir) : [])"],
    ["corroboration-arrival.ts", "for (const f of (existsSync(runsDir) ? readdirSync(runsDir) : [])"],
    ["export-kb.ts", 'const names = (existsSync("runs") ? readdirSync("runs") : []).filter('],
  ])("%s guards its readdirSync(runs) with existsSync", (file, guard) => {
    const src = source(file)
    expect(src).toContain(guard)
    expect(src).toMatch(/import \{[^}]*\bexistsSync\b[^}]*\} from "node:fs"/)
  })

  it("recall.ts guards BOTH of its readdirSync(runsDir) call sites", () => {
    const guarded = source("recall.ts").match(/existsSync\(runsDir\) \? readdirSync\(runsDir\) : \[\]/g) ?? []
    expect(guarded).toHaveLength(2)
  })

  it("read.ts: a fresh clone gets the 'no run matching' message, not a bare ENOENT stack", () => {
    const { status, stderr } = runInEmptyClone("read.ts", ["somedomain.com"])
    expect(status).not.toBe(0)
    expect(stderr).toContain('no run matching "somedomain.com"')
    expect(stderr).not.toContain("ENOENT")
  })

  it("run-doctor.ts: a fresh clone gets 'no runs in runs/' on stdout, exit 0", () => {
    const { status, stdout } = runInEmptyClone("run-doctor.ts")
    expect(status).toBe(0)
    expect(stdout.trim()).toBe("no runs in runs/")
  })

  it("export-kb.ts --all: a fresh clone writes an empty INDEX.md instead of throwing on either ENOENT", () => {
    const { status, stdout, stderr } = runInEmptyClone("export-kb.ts", ["--all"])
    expect(stderr).not.toContain("ENOENT")
    expect(status).toBe(0)
    expect(stdout.trim()).toBe("wrote runs/exports/INDEX.md (0 maps, 0 anchors)")
  })

  it("bench.ts: a fresh clone prints its report with '—' for the span, instead of throwing RangeError", () => {
    const { status, stdout, stderr } = runInEmptyClone("bench.ts")
    expect(stderr).not.toContain("RangeError")
    expect(status).toBe(0)
    expect(stdout).toContain("The runs span —; 0 carry the grounding meter")
  })
})
