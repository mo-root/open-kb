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
 * runs found". Eight call sites across seven scripts made the same mistake:
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
 * None of the six can be imported directly in a test process — read.ts,
 * bench.ts, calibrate-kernel.ts, query-yield.ts, recall.ts and
 * corroboration-arrival.ts all act on real `process.argv` (or, for
 * calibrate-kernel.ts, fetch live pages) at module scope, the same reason
 * `tests/four-readers-refuse-a-non-run-file-with-one-sentence.test.ts`
 * checks its four by source text rather than by running them. Source text
 * proves the guard is present at all eight sites; the two subprocess runs
 * below prove the guard actually produces the intended message rather than
 * some other crash — run-doctor.ts's own `diagnose` is import-safe (it is
 * gated behind `invokedDirectly`, see run-doctor.test.ts), but the fixed
 * line lives in the CLI-only branch that guard exists to skip on import, so
 * it needs the same subprocess proof as the rest.
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
    ["query-yield.ts", "for (const f of (existsSync(runsDir) ? readdirSync(runsDir) : [])"],
    ["corroboration-arrival.ts", "for (const f of (existsSync(runsDir) ? readdirSync(runsDir) : [])"],
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
})
