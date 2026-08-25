import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * `scripts/batch.ts` had ZERO test coverage anywhere — the only script among
 * the three CLI entrypoints with a dollar bound (see
 * `tests/the-cli-entrypoints-have-a-dollar-bound.test.ts`) that nothing
 * exercises directly. It cannot be imported: it does real work at module
 * scope (`process.argv` parsing, `process.exit`, and — once past
 * validation — a real `child_process.spawn` of `scripts/sweep.ts`), the
 * same reason `bench.ts`/`calibrate-kernel.ts`/etc. are checked by subprocess
 * rather than import elsewhere in this repo. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED — see docs/overnight-backlog.md).
 *
 * EVERY CASE HERE STOPS BEFORE A SWEEP IS SPAWNED. That boundary is
 * deliberate, not incidental: this loop may make no live or paid calls, and
 * `runOne()` spawns `npx tsx scripts/sweep.ts <anchor>`, which reaches for
 * real credentials the moment it starts. Confirmed for the one case that
 * looks closest to crossing it — a valid anchor under a cap so tight
 * `listRoom` refuses on the very first check — that the process exits
 * before any child is created (`spent === 0`, `"0/0 built"`, no `runs/*.json`
 * other than the manifest batch.ts itself writes). Every other case here
 * fails validation even earlier, before `mkdirSync("runs")` is reached.
 *
 * `flag()` is `batch.ts`'s own argv parser (`--concurrency`, `--timeout`,
 * `--retries`), shared by every numeric flag; `min` is 1 for the flags where
 * zero is meaningless and 0 for `--retries`. It had no coverage of either
 * boundary. The list-file and `--resume` manifest refusals (missing file,
 * empty file, missing manifest) are the same "reader's own typo, named by
 * path" family `audit.ts` and `diff-runs.ts` already have covered
 * elsewhere — batch.ts was the one entrypoint in that family without its
 * own proof.
 */

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))
const scriptPath = fileURLToPath(new URL("../scripts/batch.ts", import.meta.url))

/** Runs batch.ts from a scratch directory and reports how it ended, rather
 *  than throwing vitest's own diff on the non-zero exit every case here
 *  produces. */
function run(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "openkb-batch-"))
  try {
    try {
      const stdout = execFileSync(tsx, [scriptPath, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...env },
      })
      return { status: 0, stdout, stderr: "" }
    } catch (e) {
      const err = e as { status: number | null; stdout?: string; stderr?: string }
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Same scratch-dir shape as `run()`, but with a domains file already
 *  written inside it, for the cases that need a valid list to reach the
 *  flag they are testing. */
function runWithList(list: string, args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "openkb-batch-"))
  const listPath = join(dir, "domains.txt")
  writeFileSync(listPath, list)
  try {
    try {
      const stdout = execFileSync(tsx, [scriptPath, listPath, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...env },
      })
      return { status: 0, stdout, stderr: "" }
    } catch (e) {
      const err = e as { status: number | null; stdout?: string; stderr?: string }
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("batch.ts refuses a bad invocation before it touches the network", () => {
  it("prints usage and exits 2 with no list argument at all", () => {
    const { status, stderr } = run([])
    expect(status).toBe(2)
    expect(stderr).toContain("usage: tsx scripts/batch.ts <domains.txt>")
  })

  it("reads a flag in the list's own position as a missing list, not a typo'd domain", () => {
    const { status, stderr } = run(["--concurrency", "2"])
    expect(status).toBe(2)
    expect(stderr).toContain("usage: tsx scripts/batch.ts <domains.txt>")
  })

  it("names the path when the list does not exist", () => {
    const { status, stderr } = run(["nope.txt"])
    expect(status).toBe(2)
    expect(stderr).toContain("no such list: nope.txt")
  })

  it("refuses a list with nothing but comments and blank lines", () => {
    const { status, stderr } = runWithList("# just a comment\n\n", [])
    expect(status).toBe(2)
    expect(stderr).toContain("has no domains in it")
  })

  it("names the path when --resume points at a manifest that does not exist", () => {
    const { status, stderr } = runWithList("example.com\n", ["--resume", "nope.jsonl"])
    expect(status).toBe(2)
    expect(stderr).toContain("no such manifest: nope.jsonl")
  })
})

describe("flag() enforces its own floor and refuses a non-integer", () => {
  it.each([
    ["--concurrency", "abc", "needs a whole number of 1 or more"],
    ["--concurrency", "0", "needs a whole number of 1 or more"],
    ["--concurrency", "1.5", "needs a whole number of 1 or more"],
    ["--timeout", "soon", "needs a whole number of 1 or more"],
    ["--retries", "-1", "needs a whole number of 0 or more"],
  ])("%s %s is refused: %s", (flag, value, expected) => {
    const { status, stderr } = runWithList("example.com\n", [flag, value])
    expect(status).toBe(2)
    expect(stderr).toContain(`${flag} ${expected}`)
    expect(stderr).toContain(JSON.stringify(value))
  })

  it("accepts --retries 0, the one numeric flag whose floor is meaningful input", () => {
    // min=0 for --retries specifically because "do not retry" is a real ask,
    // unlike --concurrency/--timeout where 0 means no work at all. Proven
    // without spawning a sweep: an unreachably tight list cap makes
    // listRoom refuse before runOne() is ever called, so this only proves
    // the flag itself was accepted, not that a retry loop ran.
    const { status, stdout } = runWithList("example.com\n", ["--retries", "0"], { OPENKB_BATCH_CAP_USD: "0.01" })
    expect(status).toBe(0)
    expect(stdout).not.toContain("needs a whole number")
    expect(stdout).toContain("no room for another run")
  })
})

describe("the list is deduplicated and the budget stops the batch before any run starts", () => {
  it("drops a repeated domain once and reports it, then a tight cap stops before spawning anything", () => {
    const { status, stdout } = runWithList("example.com\nexample.com\n# comment\nother.com\n", [], {
      OPENKB_BATCH_CAP_USD: "0.01",
    })
    expect(status).toBe(0)
    expect(stdout).toContain("1 duplicate domain dropped")
    expect(stdout).toContain("2 to build")
    // The budget check runs before the child is spawned — proven by there
    // being nothing spent and nothing built, not merely a message printed.
    expect(stdout).toContain("no room for another run")
    expect(stdout).toContain("0/0 built · $0.00")
    expect(stdout).toContain("2 not started: example.com, other.com")
    expect(stdout).toContain("resume with:")
  })
})
