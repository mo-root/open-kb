import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync, existsSync } from "node:fs"

/* The guard that notices a suite going dark without anyone saying so.

   `pnpm check` runs three custom guards in order: check-core-purity.mjs,
   check-test-collection.mjs, check-skips.mjs (CONTRIBUTING.md's own
   description of the gate). The first two each have a dedicated test that
   plants a probe and watches the guard go red — tests/purity.test.ts and
   tests/collection.test.ts. This script had neither: its own doc comment
   describes a bidirectional check (a declared gate that vanished from the
   source, and a skip construct nobody declared) and nothing exercised
   either direction.

   Same technique as those two siblings, and the same reason for it: a
   census script that has never been watched failing is a census nobody can
   trust to fail. The probe is planted in the SHARED working tree rather
   than a temp dir, because check-skips.mjs — unlike check-core-purity.mjs's
   `--also` — takes no argument to redirect its scan; it always reads `git
   ls-files` against this repo. Process-pid-scoped, for the same collision
   reason tests/collection.test.ts gives: two runs sharing one filename
   would have one afterEach delete the other's probe mid-assertion. */

/* Placed at the repo root, matching tests/collection.test.ts's UNREACHABLE
   probe, and for the same reason: none of vitest.config.ts's four include
   globs reach the repo root, so this file is picked up by check-skips.mjs's
   own `git ls-files` scan (untracked files pass `--others
   --exclude-standard` same as tracked ones) without vitest itself ever
   trying to collect and run it — no nested-suite side effect to reason
   about. */
const PROBE = `__skip-probe-${process.pid}.test.ts`

const PROBE_BODY = `import { describe, it, expect } from "vitest"\ndescribe.skip("probe suite", () => {\n  it("x", () => expect(1).toBe(1))\n})\n`

function runChecker(): { status: number; output: string } {
  // stdio: "pipe" — same reason tests/purity.test.ts and
  // tests/collection.test.ts pipe: execFileSync's default echoes the
  // child's stderr to this process's own, which would spam expected
  // failures into the run.
  try {
    const output = execFileSync("node", ["scripts/check-skips.mjs"], { encoding: "utf8", stdio: "pipe" })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status, output: `${e.stdout}${e.stderr}` }
  }
}

describe("skip census", () => {
  afterEach(() => {
    if (existsSync(PROBE)) rmSync(PROBE)
  })

  it(
    "the repo's current skip census is clean",
    () => {
      // Only this branch shells out to `vitest list --json` over the whole repo
      // (the problems-found branch below exits before reaching it) — measured
      // at ~30s here, well past vitest's 5s default.
      const { status, output } = runChecker()
      expect(status).toBe(0)
      expect(output).toContain("skip census:")
      expect(output).not.toContain("undeclared skip")
      expect(output).not.toContain("declared gate not found")
    },
    60_000,
  )

  it("an undeclared skip turns the guard red, and is named", () => {
    writeFileSync(PROBE, PROBE_BODY)
    const { status, output } = runChecker()
    expect(status).not.toBe(0)
    // Naming the file and line is the whole product — the same reason
    // tests/collection.test.ts asserts its own probe's filename appears.
    expect(output).toContain("undeclared skip")
    expect(output).toContain(PROBE)
  })
})
