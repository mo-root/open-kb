import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/* THE PROBE LIVES OUTSIDE THE REPO.

   It used to be written straight into `packages/core/src/__purity-probe.ts` and
   removed in an afterEach, which works exactly until a process does not reach
   its afterEach. A Ctrl-C or a SIGKILL mid-suite left the probe sitting in the
   real source tree, and what it broke depended on which test the kill landed
   in — which is the worst property a failure can have. Every body below trips
   the purity gate, so `pnpm check` goes red at step one with a violation in a
   file the reader never wrote. Two of them (`somewindow.foo`, `new
   XMLHttpRequest()`) are not valid TypeScript either, so those also fail
   `tsc -b` with a TS2304 four steps later. And a scan running beside this one
   has already been hurt by the probe without a kill being involved at all:
   scripts/check-test-collection.mjs reads every file `git ls-files` reports,
   saw the probe in the listing, and took an ENOENT because the afterEach
   removed it in between. A cleanup step is not a strong enough thing to be the
   only barrier between a test and the source tree. */

/* Measured, on this branch, before and after. The pre-fix file was restored
   under a second name and the suite SIGKILLed mid-run: `git status` showed
   `?? packages/core/src/__purity-probe.ts` and the gate then reported a
   violation in it. The same kill against this file, at five delays across the
   window, leaves the working tree with nothing in it — and leaves an orphaned
   probe in the temp dir, which is the proof the kill really did land between
   the write and the afterEach rather than missing the window.

   mkdtempSync also settles, structurally, the collision tests/collection.test.ts
   had to solve with `process.pid`: two concurrent runs sharing one probe
   filename, each afterEach deleting the other's file mid-assertion. That fix is
   right for a probe that MUST be planted in the working tree — that suite is
   testing whether the real config reaches a real path, so it has nowhere else
   to go. Nothing here needs the repo, so the same lesson goes one step further:
   the OS hands out a directory nobody else holds, and there is no name left to
   collide on. */
/* Created in a `beforeAll`, not at module scope, and that is a leak fix rather
   than a style preference. At module scope `mkdtempSync` fires when the file is
   merely COLLECTED — and `pnpm check` collects this suite twice without running
   it, once for check-test-collection.mjs and once for check-skips.mjs, both of
   which shell out to `vitest list`. `afterAll` never runs for a collection, so
   every `pnpm check` left directories behind: measured 1, 3, 3, 4 cumulative
   over four consecutive runs, monotonic. No kill required. Lazily created, a
   collection makes none and only a real run has one to clean up. */
let PROBE_DIR: string
let PROBE_FILE: string

function runChecker(args: string[] = []): { status: number; output: string } {
  // stdio: "pipe" is required — execFileSync's undocumented-in-practice default echoes the
  // child's stderr straight to this process's stderr in addition to capturing it, which would
  // spam violation output into the test run even on expected failures.
  try {
    const output = execFileSync("node", ["scripts/check-core-purity.mjs", ...args], {
      encoding: "utf8",
      stdio: "pipe",
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status, output: `${e.stdout}${e.stderr}` }
  }
}

/** The gate over the real core tree AND the probe dir. Note what this cannot
 *  express: there is no spelling of these arguments that leaves core out. */
function runOverProbe(): { status: number; output: string } {
  return runChecker(["--also", PROBE_DIR])
}

describe("core purity", () => {
  beforeAll(() => {
    PROBE_DIR = mkdtempSync(join(tmpdir(), "open-kb-purity-"))
    PROBE_FILE = join(PROBE_DIR, "__purity-probe.ts")
  })
  afterEach(() => {
    // force, because the tests that assert a refusal never write a probe at all.
    rmSync(PROBE_FILE, { force: true })
  })
  afterAll(() => {
    // Best effort by design. This is the line a SIGKILL skips, and skipping it
    // leaks one empty directory into the OS temp dir instead of leaving a .ts
    // file in packages/core/src for three other guards to trip over. A normal
    // run — including a collection, which now creates nothing — leaves neither.
    if (PROBE_DIR) rmSync(PROBE_DIR, { recursive: true, force: true })
  })

  it("core contains no env access, DOM, or vendor names", () => {
    const run = () => execFileSync("node", ["scripts/check-core-purity.mjs"], { encoding: "utf8" })
    expect(run).not.toThrow()
  })

  /* The gate can be told to read one more directory, and that is the only thing
     it can be told. These four are the price of that flag: every one of them is
     a way a pointable gate goes quiet, and each has to be a failure rather than
     a green before the flag is safe to have. */
  describe("the flag cannot narrow the scan", () => {
    it("reads core on every run, and `--also` only adds to it", () => {
      // Additivity measured, not asserted against a restated file count — the
      // number is read from the gate twice and the probe is the difference.
      const bare = runChecker()
      writeFileSync(PROBE_FILE, `export const a = 1\n`)
      const withProbe = runOverProbe()
      expect(bare.status).toBe(0)
      expect(withProbe.status).toBe(0)
      // Counted per root now, which says more than the old single total did:
      // core's number must be IDENTICAL with and without the flag — that is
      // additivity, stated directly — and the extra directory reports its own
      // one file, which is what proves it was read rather than just named.
      const core = (out: string) => Number(/clean — (\d+) files under/.exec(out)?.[1])
      expect(core(bare.output)).toBeGreaterThan(0)
      expect(core(withProbe.output)).toBe(core(bare.output))
      expect(withProbe.output).toContain(`plus 1 under ${PROBE_DIR}`)
      expect(withProbe.output).toContain("packages/core/src")
    })

    it("refuses a bare path instead of reading it as a new root", () => {
      // The mistake this flag exists to make impossible: someone reaches for
      // `check-core-purity.mjs some/dir` expecting the scan to move there. If
      // that were honoured over an empty directory it would print clean.
      const { status, output } = runChecker([PROBE_DIR])
      expect(status).toBe(2)
      expect(output).not.toContain("core purity: clean")
      expect(output).toContain("unrecognised argument")
    })

    it("refuses a directory with no .ts files in it", () => {
      // PROBE_DIR is empty until a test writes into it, so this is the "clean
      // over nothing" case exactly.
      const { status, output } = runOverProbe()
      expect(status).toBe(2)
      expect(output).not.toContain("core purity: clean")
      expect(output).toContain("no .ts files")
    })

    it("refuses a directory that is not there at all", () => {
      const { status, output } = runChecker(["--also", join(PROBE_DIR, "nope")])
      // 2, not 1. The two codes are the gate's whole safety argument — 1 means
      // core is impure, 2 means the gate did not run — and every assertion here
      // used to be `not.toBe(0)`, which cannot tell them apart. A refusal
      // reported as a violation would send someone hunting core for a fault
      // that is in their command line.
      expect(status).toBe(2)
      expect(output).not.toContain("core purity: clean")
      expect(output).toContain("could not be read")
    })

    it("is invoked by `pnpm check` with no arguments at all", () => {
      // The flag is for this file. `check` passing one would be the first step
      // toward a scan that is configured somewhere other than in the gate.
      const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> }
      const check = pkg.scripts?.check
      expect(check, "package.json has no `check` script").toBeDefined()
      const call = /node\s+scripts\/check-core-purity\.mjs([^&|]*)/.exec(check ?? "")
      expect(call, "`check` does not run the purity gate").not.toBeNull()
      expect(call?.[1]?.trim()).toBe("")
    })
  })

  describe("bypass hardening", () => {
    /* The vendor rule had no probe at all until this one. Deleting
       `[/brightdata|openrouter|gemini/i, "vendor name in core"]` from the gate
       left the whole suite green — a quarter of FORBIDDEN guarded by nothing.
       The real-core test cannot cover it either: core contains no vendor name,
       so a rule that fires on nothing looks exactly like a rule that works.
       This is also the rule the price table leans on — it is why MODEL_PRICES
       lives in providers and not core. */
    it("catches a vendor name, the rule the real tree can never exercise", () => {
      writeFileSync(PROBE_FILE, `export const a = "built on brightdata"\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("vendor name in core")
    })

    it("catches a vendor name whatever its casing", () => {
      writeFileSync(PROBE_FILE, `import { x } from "./OpenRouter.js"\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("vendor name in core")
    })

    it("catches process.env accessed via optional chaining", () => {
      writeFileSync(PROBE_FILE, `export const a = process?.env?.API_KEY\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("process.env — credentials are a parameter")
    })

    it("catches process.env with incidental whitespace", () => {
      writeFileSync(PROBE_FILE, `export const a = process . env\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("process.env — credentials are a parameter")
    })

    it("catches document accessed via optional chaining", () => {
      writeFileSync(PROBE_FILE, `export const a = document?.title\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("DOM API in a headless engine")
    })

    it("catches window accessed via optional chaining", () => {
      writeFileSync(PROBE_FILE, `export const a = window?.location\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("DOM API in a headless engine")
    })

    it("does not false-positive on identifiers that merely end in 'window'", () => {
      writeFileSync(PROBE_FILE, `export const a = somewindow.foo\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(0)
      expect(output).toContain(`plus 1 under ${PROBE_DIR}`)
      // `toContain(PROBE_DIR)` is what makes this a clean rather than a
      // never-looked. Exit 0 alone cannot tell them apart, and mutating the
      // gate to accept `--also` and discard the directory left exactly these
      // three green while 15 others went red — the vacuity moving the probe
      // out of the source tree risked, landing precisely here.
      // Proves the probe was READ, not merely named. The clean line prints the
      // `--also` directory whether or not it was scanned, so the discriminator
      // is its COUNT: mutating the gate to accept the flag and discard the
      // directory left exactly these guards green while 15 others went red —
      // the vacuity that moving the probe out of the source tree risked,
      // landing precisely on the tests that assert nothing is wrong.
      expect(output).toContain(`plus 1 under ${PROBE_DIR}`)
    })

    it("catches process.env split across lines, where no single line contains the full match", () => {
      // A line-by-line scan would miss this: neither "process" nor ".env" nor ".API_KEY"
      // alone matches process.env — only the joined text does.
      writeFileSync(PROBE_FILE, `export const a = process\n  .env\n  .API_KEY\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("process.env — credentials are a parameter")
    })
  })

  describe("HTTP framing", () => {
    it("catches a direct fetch( call", () => {
      writeFileSync(PROBE_FILE, `export const a = fetch("https://example.com")\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("HTTP framing")
    })

    it("catches XMLHttpRequest", () => {
      writeFileSync(PROBE_FILE, `export const a = new XMLHttpRequest()\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("HTTP framing")
    })

    it("catches new Request(", () => {
      writeFileSync(PROBE_FILE, `export const a = new Request("https://example.com")\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("HTTP framing")
    })

    it("catches a static import of node:http", () => {
      writeFileSync(PROBE_FILE, `import http from "node:http"\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("HTTP framing")
    })

    it("catches a static import of node:https", () => {
      writeFileSync(PROBE_FILE, `import https from "node:https"\n`)
      const { status, output } = runOverProbe()
      expect(status).toBe(1)
      expect(output).toContain("HTTP framing")
    })

    it("does not false-positive on identifiers that merely contain 'fetch'", () => {
      writeFileSync(
        PROBE_FILE,
        `export interface X { fetchedAt: string }\nexport const hasFetched = (x: X) => Boolean(x.fetchedAt)\n`,
      )
      const { status, output } = runOverProbe()
      expect(status).toBe(0)
      expect(output).toContain(`plus 1 under ${PROBE_DIR}`)
      // `toContain(PROBE_DIR)` is what makes this a clean rather than a
      // never-looked. Exit 0 alone cannot tell them apart, and mutating the
      // gate to accept `--also` and discard the directory left exactly these
      // three green while 15 others went red — the vacuity moving the probe
      // out of the source tree risked, landing precisely here.
      // Proves the probe was READ, not merely named. The clean line prints the
      // `--also` directory whether or not it was scanned, so the discriminator
      // is its COUNT: mutating the gate to accept the flag and discard the
      // directory left exactly these guards green while 15 others went red —
      // the vacuity that moving the probe out of the source tree risked,
      // landing precisely on the tests that assert nothing is wrong.
      expect(output).toContain(`plus 1 under ${PROBE_DIR}`)
    })

    it("does not false-positive on a 'fetch' property declaration or a fetch-prefixed method call", () => {
      // A port declared on an interface (`fetch: FetchPort`) is exactly the pattern core is
      // supposed to use — a provider injects the implementation. Calling through an injected
      // port (`ctx.fetch.get(url)`) is core using that port, not core making the HTTP call
      // itself. Neither should trip the HTTP-framing rule; if a future regex change makes them
      // trip it, this gate would start crying wolf and get disabled.
      writeFileSync(
        PROBE_FILE,
        [
          "export interface Port {",
          "  fetch: FetchPort",
          "}",
          "export function useIt(ctx: { fetch: { get: (u: string) => Promise<string> } }) {",
          '  return ctx.fetch.get("https://example.com")',
          "}",
          "",
        ].join("\n"),
      )
      const { status, output } = runOverProbe()
      expect(status).toBe(0)
    })
  })
})
