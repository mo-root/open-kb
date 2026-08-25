import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * `pnpm bench`'s "Repeatability" footnote — the one comparing three-plus
 * `clerk.com` sweeps against each other — computes the dollar and wall-clock
 * SPAN with `Math.min(...v)`/`Math.max(...v)` over `v = clerkSweeps.map(f)
 * .filter(x => x !== null)` (bench.ts:394-410). `usd`/`seconds` are `null`
 * whenever a run file's `stats.usd`/`.seconds` is not a number — a run
 * recorded before either existed, or one that never finished — and when
 * EVERY clerk.com row in `runs/` is missing one, `v` is `[]`.
 * `Math.min(...[])` is `Infinity`, `Math.max(...[])` is `-Infinity`, and
 * `.toFixed()` prints both as the literal string "Infinity"/"-Infinity"
 * rather than throwing (unlike `new Date(Infinity)`, which is the shape the
 * sibling RangeError bug this same describe-block's neighbour file covers —
 * see `seven-scripts-crashed-on-a-runs-directory-that-does-not-exist.test.ts`).
 * So this one does not crash; it silently prints a sentence claiming the map
 * "came back ... for $Infinity to $-Infinity, in Infinitys to -Infinitys" —
 * a false receipt in a report whose entire premise (see bench.ts's own
 * header) is "read off the runs instead of typed", never a number nobody
 * measured.
 *
 * Reproduced below with three fixture `clerk.com` sweep files carrying an
 * empty `stats: {}` — exactly the shape a stopped or pre-metering run
 * writes. Fixed by making the span helper return `null` when it has nothing
 * to span (same convention `day()`/`n0()`/`money()` already use elsewhere in
 * this file) and printing "an unrecorded cost"/"an unrecorded time" instead
 * of asserting a number this run never wrote down.
 */

const scriptPath = fileURLToPath(new URL("../scripts/bench.ts", import.meta.url))
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))

/** Grounded-era entity, kept (not noise, not the anchor's own row) — enough
 *  for `readRun` to count this file as a current-pipeline sweep. */
const fixtureRun = (stats: Record<string, unknown>) =>
  JSON.stringify({
    anchor: "clerk.com",
    entities: [{ domain: "authkit.com", kind: "company", relation: "competitor", descGrounded: 0.5 }],
    stats,
  })

function runBenchWith(runFiles: Record<string, string>): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "openkb-bench-clerk-"))
  try {
    mkdirSync(join(dir, "runs"), { recursive: true })
    for (const [name, content] of Object.entries(runFiles)) writeFileSync(join(dir, "runs", name), content)
    const stdout = execFileSync(tsx, [scriptPath], { cwd: dir, encoding: "utf8" })
    return { stdout, stderr: "" }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("bench.ts's clerk.com repeatability footnote never asserts a number nobody measured", () => {
  it("prints 'an unrecorded cost'/'an unrecorded time' rather than $Infinity when every row lacks stats.usd/.seconds", () => {
    const { stdout } = runBenchWith({
      "sweep-clerk-com-202608070000.json": fixtureRun({}),
      "sweep-clerk-com-202608070001.json": fixtureRun({}),
      "sweep-clerk-com-202608070002.json": fixtureRun({}),
    })
    expect(stdout).not.toContain("Infinity")
    expect(stdout).toContain("for an unrecorded cost, in an unrecorded time")

    /**
     * THE SAME EMPTY POPULATION, ONE SENTENCE LOWER, and this file ran past
     * it on every invocation.
     *
     * The swarm/sweep headline reached for `shownSwarm?.toFixed(4)` where its
     * three siblings each guarded with an explicit `=== null ? "—"`. With no
     * swarm run in the directory — which is every directory today, since the
     * swarm runs live in `runs/archive/pre-agent-20260816` and `readdirSync`
     * does not descend — optional chaining yields `undefined` and the
     * template prints the literal `$undefined`. `pnpm bench` did this on the
     * author's own machine while this test passed, because it only ever
     * looked for "Infinity".
     *
     * An unmeasured figure has one spelling in this file and it is "—".
     */
    expect(stdout).not.toContain("undefined")
    expect(stdout).not.toContain("NaN")
  })

  it("still prints the real span once stats.usd/.seconds are present", () => {
    const { stdout } = runBenchWith({
      "sweep-clerk-com-202608070000.json": fixtureRun({ usd: 1.0, seconds: 100 }),
      "sweep-clerk-com-202608070001.json": fixtureRun({ usd: 1.2, seconds: 102 }),
      "sweep-clerk-com-202608070002.json": fixtureRun({ usd: 1.1, seconds: 101 }),
    })
    expect(stdout).not.toContain("Infinity")
    expect(stdout).not.toContain("undefined")
    expect(stdout).not.toContain("unrecorded")
    expect(stdout).toContain("for **$1.00 to $1.20**, in **100s to 102s**")
  })
})
