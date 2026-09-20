import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"

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
    "the repo's current skip census is clean, and reads a leaf-test gate as open once it genuinely is",
    () => {
      // Only this branch shells out to `vitest list --json` over the whole repo
      // (the problems-found branch below exits before reaching it) — measured
      // at ~30s on the machine this comment was written on, well past vitest's
      // 5s default. Measured again directly (`time node scripts/check-skips.mjs`,
      // no vitest harness around it) at ~70-72s across repeated runs on a
      // 4-vCPU, ~2GB-free sandbox — the CPU/memory-constrained kind this suite
      // also runs in unattended overnight. 60_000 was already tight against the
      // 30s it was set for; it was flaking outright here. 150_000 keeps better
      // than 2x headroom over the slower measurement instead of matching it.
      //
      // The `runs/` fixtures below fold a second scenario into this same,
      // already-expensive call rather than paying for `vitest list --json`
      // over ~3300 tests a second time in its own test: two of those back to
      // back tripped vitest's own worker RPC heartbeat ("[vitest-worker]:
      // Timeout calling 'onTaskUpdate'") with a real, reproducible failure —
      // neither call ever yields the event loop for the ~30-70s
      // `execFileSync` blocks it, and the second one pushed the file's total
      // blocked stretch past whatever this vitest version's own internal,
      // non-configurable heartbeat tolerates. One call, two assertions, same
      // cost as before.
      const dir = "runs"
      // Gitignored — a fresh checkout has no `runs/` directory at all, not
      // just no files in it. Names deliberately do not match any OTHER
      // gate's own hardcoded filename (`kb-from-run.test.ts`, `drift.test.ts`
      // and `dead-end-smoke.test.ts` each key off one specific real run's
      // name), so only the run-doctor gate's generic `sweep-*.json` count
      // gate can react to them; content is `{}` because `vitest list` never
      // executes a test body, only collects its declaration.
      const fixtures = Array.from({ length: 25 }, (_, i) => `${dir}/sweep-probe-${process.pid}-${i}.json`)
      const dirAlreadyExisted = existsSync(dir)
      mkdirSync(dir, { recursive: true })
      for (const f of fixtures) writeFileSync(f, "{}")
      try {
        const { status, output } = runChecker()
        expect(status).toBe(0)
        expect(output).toContain("skip census:")
        expect(output).not.toContain("undeclared skip")
        expect(output).not.toContain("declared gate not found")
        // `tests/run-doctor.test.ts`'s gate is an `it` nested inside a plain,
        // ungated `describe` — the one GATES entry whose own title lands as
        // the SUFFIX of a collected name ("run-doctor over the runs on disk >
        // survives every run file...") rather than the PREFIX every other
        // gate's `describe`-level title lands as. The census's `open` check
        // used to test only the prefix shape, so this specific gate printed
        // "dark" unconditionally, regardless of what `runs/` held — confirmed
        // directly against this same 25-file fixture before the fix existed.
        expect(output).toContain(
          "runs  tests/run-doctor.test.ts › survives every run file, across every engine version that wrote one",
        )
      } finally {
        for (const f of fixtures) if (existsSync(f)) rmSync(f)
        // Leave the tree exactly as found — this test's own `mkdirSync` is
        // the only reason `runs/` would exist at all on a fresh checkout.
        if (!dirAlreadyExisted) rmSync(dir, { recursive: true, force: true })
      }
    },
    150_000,
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
