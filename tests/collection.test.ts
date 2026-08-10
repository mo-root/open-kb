import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync, existsSync } from "node:fs"

/* The guard that notices a test nobody runs.

   `scripts/check-test-collection.mjs` compares what vitest would collect against
   what git says is on disk. This file is the planted-probe half of it: the script
   printing "clean" is only worth something if it has been watched go red.

   THE BOOTSTRAP. A test that detects uncollected tests has an obvious hole — if
   this file were itself uncollected, nothing here would run and nothing would
   complain. It is not resolved by cleverness but by there being two independent
   paths to the same script, each covering the other's disappearance:

     `pnpm check` runs the script directly. That path does not involve vitest at
     all, so it is immune to the entire class: if THIS file stopped being
     collected, `pnpm check` would still run the script, and the script would
     report tests/collection.test.ts by name as a test on disk that nothing runs.
     The guard catches its own removal from the suite.

     The suite runs it too, via the probes below. That path covers the opposite
     accident — someone dropping the script from the `check` script in
     package.json — because these tests keep executing it either way.

   Neither path is load-bearing alone, and it takes two deletions in two separate
   files to make the guard silent.

   That first claim is only as wide as the script's own idea of what a test file
   is, which is worth stating because it was briefly false. When the script
   matched `.test.` alone, renaming THIS file to `collection.spec.ts` removed it
   from the suite AND from the script's view of the disk: four probe tests
   vanished and the guard printed "clean". One rename, not two deletions. The
   script matches `(test|spec)` now, so that rename is reported by name — but the
   general shape holds: this file is protected by the script's suffix set, so
   widening the config's conventions without widening that set reopens the hole
   here first. */

/* The probe for "somewhere the include list does not reach" is at the REPO ROOT,
   not in `packages/web/app/` — which is the directory that actually motivated
   this and would have read better. vitest.config.ts says app/** is deliberately
   unlisted only until someone writes the first test there, and on that day a
   probe living there would silently start being collected and this test would
   fail for a reason that has nothing to do with the guard. The repo root matches
   none of the four include patterns and is not a place anyone will ever put a
   suite, so the probe stays uncollectable by construction rather than by a
   decision that is one line from changing. */
/* Process-scoped, not a constant, because these are planted in the SHARED working
   tree rather than a temp dir — they have to be, since the thing under test is
   whether the real config reaches a real path. Two runs at once with one filename
   between them is a race with a silent side: `afterEach` deletes by name, so the
   second run's cleanup removes the first run's probe mid-assertion and the first
   run reports the guard as broken when it is not. A watch mode alongside
   `pnpm check`, a CI job sharing a checkout, or a second agent on this branch all
   do it. Measured during review: a peer process was rewriting vitest.config.ts
   while these ran. The pid makes the collision impossible instead of unlikely. */
const UNREACHABLE = `__collection-probe-${process.pid}.test.tsx`

/** Inside `components/**`, whose whole point is that a `.test.tsx` now lands there. */
const REACHABLE = `packages/web/components/__collection-probe-${process.pid}.test.tsx`

const BODY = `import { it, expect } from "vitest"\nit("x", () => expect(1).toBe(1))\n`

function runChecker(): { status: number; output: string } {
  // stdio: "pipe" — execFileSync otherwise echoes the child's stderr to this process's own
  // stderr in addition to capturing it, spraying expected failures across the run. Same
  // reason tests/purity.test.ts pipes.
  try {
    const output = execFileSync("node", ["scripts/check-test-collection.mjs"], {
      encoding: "utf8",
      stdio: "pipe",
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status, output: `${e.stdout}${e.stderr}` }
  }
}

describe("test collection", () => {
  afterEach(() => {
    // Only ever files this file wrote, and never a directory: `packages/web/app` is a real
    // route tree, and a cleanup that removed a directory would be a far worse bug than the
    // one under test.
    for (const p of [UNREACHABLE, REACHABLE]) if (existsSync(p)) rmSync(p)
  })

  it("every test file on disk is collected by the suite", () => {
    const { status, output } = runChecker()
    expect(output).toContain("clean")
    expect(status).toBe(0)
  })

  it("a test file the include list cannot reach turns the guard red, and is named", () => {
    writeFileSync(UNREACHABLE, BODY)
    const { status, output } = runChecker()
    expect(status).not.toBe(0)
    // Naming the file is the whole product. "Something is uncollected" sends you hunting
    // through sixty files for the one that is missing.
    expect(output).toContain(UNREACHABLE)
    expect(output).toContain("do not run")
  })

  it("the same file inside a listed directory leaves it green", () => {
    // The negative half. Without it, a guard that went red on any new file at all would
    // pass the test above while proving nothing about collection.
    writeFileSync(REACHABLE, BODY)
    const { status, output } = runChecker()
    expect(output).toContain("clean")
    expect(status).toBe(0)
  })

  it("a .test.tsx beside the component it covers is collected", () => {
    // The specific hole this was built alongside: `components/**` matched `*.test.ts` while
    // every component is a `.tsx`, so the natural name for the first component test matched
    // nothing. Pinned by extension, not by the number of files in that directory — which is
    // legitimately zero and must be allowed to stay zero.
    writeFileSync(REACHABLE, BODY)
    const listed = execFileSync("node_modules/.bin/vitest", ["list", "--filesOnly", "--json"], {
      encoding: "utf8",
      stdio: "pipe",
    })
    expect(listed).toContain(REACHABLE)
  })
})
