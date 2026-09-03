import { afterEach, describe, expect, it, vi } from "vitest"
import { EXIT } from "../scripts/fatal.js"
import {
  computeOutcome,
  dedupeAnchors,
  doneAnchorsFromManifest,
  flag,
  readFlag,
  stringFlag,
  type Outcome,
} from "../scripts/batch.js"

/**
 * `scripts/batch.ts`'s own argv parsing, dedup, resume-manifest reading and
 * per-attempt outcome decision had no test that did not shell out to a real
 * subprocess (`tests/batch-refuses-before-it-spends-anything.test.ts`, which
 * stops before a sweep is ever spawned and so never reaches `computeOutcome`
 * at all — every case there is a validation refusal). This file is the direct
 * counterpart, following the same `readCapUsd`/`capUsdOrExit` split
 * `scripts/spend-caps.ts` uses: a pure reader plus a thin `process.exit`
 * wrapper around it, pulled out so the reader is reachable without a real
 * process boundary in the way.
 *
 * D-scope, self-discovered (docs/overnight-backlog.md is gone from this
 * checkout, untracked by 481fa6d — recovered the same way prior SELF-<n>
 * commits did; git log names SELF-267 as the last used, so this is SELF-268).
 * The split above only pulled `readFlag` out for its OWN sake — `flag`, the
 * `process.exit` wrapper it split from, was never exported and so never
 * reached by a test at all, unlike its `capUsdOrExit` counterpart which has
 * the exit path covered in
 * `tests/the-cli-entrypoints-have-a-dollar-bound.test.ts`. Confirmed with an
 * isolated coverage run (`vitest run tests/batch.test.ts --coverage
 * --coverage.include=scripts/batch.ts`) before this file's own describe
 * block below existed: `flag` showed 0 hits in `coverage-final.json`.
 */

describe("readFlag", () => {
  it("returns the fallback when the flag is absent", () => {
    expect(readFlag([], "concurrency", 2)).toEqual({ ok: true, n: 2 })
  })

  it("reads the value right after the flag", () => {
    expect(readFlag(["--concurrency", "5"], "concurrency", 2)).toEqual({ ok: true, n: 5 })
  })

  it("refuses a non-integer, a fraction, and below its floor", () => {
    for (const raw of ["abc", "1.5", "0"]) {
      const reading = readFlag(["--concurrency", raw], "concurrency", 2)
      expect(reading.ok).toBe(false)
      if (!reading.ok) {
        expect(reading.why).toContain("--concurrency needs a whole number of 1 or more")
        expect(reading.why).toContain(JSON.stringify(raw))
      }
    }
  })

  it("min=0 accepts zero, for --retries specifically", () => {
    expect(readFlag(["--retries", "0"], "retries", 1, 0)).toEqual({ ok: true, n: 0 })
    const reading = readFlag(["--retries", "-1"], "retries", 1, 0)
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.why).toContain("needs a whole number of 0 or more")
  })

  it("a flag with nothing after it reads as NaN, not the next argument", () => {
    const reading = readFlag(["--concurrency"], "concurrency", 2)
    expect(reading.ok).toBe(false)
  })
})

describe("flag", () => {
  const savedArgv = process.argv

  afterEach(() => {
    process.argv = savedArgv
    vi.restoreAllMocks()
  })

  it("returns the value without touching process.exit when the reading is ok", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    process.argv = ["node", "batch.ts", "--concurrency", "5"]

    expect(flag("concurrency", 2)).toBe(5)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("returns the fallback, untouched, when the flag is absent", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    process.argv = ["node", "batch.ts"]

    expect(flag("concurrency", 2)).toBe(2)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("exits 2 and prints readFlag's own refusal, verbatim, on an invalid value", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    process.argv = ["node", "batch.ts", "--concurrency", "abc"]

    flag("concurrency", 2)

    expect(exitSpy).toHaveBeenCalledWith(2)
    const reading = readFlag(["--concurrency", "abc"], "concurrency", 2)
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(errorSpy).toHaveBeenCalledWith(reading.why)
  })

  it("min=0 passes through to readFlag, so --retries 0 does not exit", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    process.argv = ["node", "batch.ts", "--retries", "0"]

    expect(flag("retries", 1, 0)).toBe(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe("stringFlag", () => {
  it("returns null when the flag is absent", () => {
    expect(stringFlag([], "resume")).toBeNull()
  })

  it("reads the value right after the flag", () => {
    expect(stringFlag(["--resume", "manifest.jsonl"], "resume")).toBe("manifest.jsonl")
  })

  it("returns null rather than another flag's name when nothing follows", () => {
    expect(stringFlag(["--resume"], "resume")).toBeNull()
  })
})

describe("dedupeAnchors", () => {
  it("keeps first-seen order and drops later repeats", () => {
    expect(dedupeAnchors(["a.com", "b.com", "a.com", "c.com", "b.com"])).toEqual(["a.com", "b.com", "c.com"])
  })

  it("is a no-op on a list with no repeats", () => {
    expect(dedupeAnchors(["a.com", "b.com"])).toEqual(["a.com", "b.com"])
  })

  it("returns an empty list for an empty list", () => {
    expect(dedupeAnchors([])).toEqual([])
  })
})

describe("doneAnchorsFromManifest", () => {
  const ok = (anchor: string): Outcome => ({ anchor, ok: true, detail: "x", seconds: 1, usd: 1, attempt: 1, at: "t" })
  const fail = (anchor: string): Outcome => ({ anchor, ok: false, detail: "x", seconds: 1, usd: null, attempt: 1, at: "t" })

  it("collects only the anchors whose outcome was ok", () => {
    const text = [ok("a.com"), fail("b.com"), ok("c.com")].map((o) => JSON.stringify(o)).join("\n")
    expect(doneAnchorsFromManifest(text)).toEqual(new Set(["a.com", "c.com"]))
  })

  it("skips blank lines and a truncated last line rather than throwing", () => {
    const text = `${JSON.stringify(ok("a.com"))}\n\n{"anchor": "b.com", "ok": tr`
    expect(doneAnchorsFromManifest(text)).toEqual(new Set(["a.com"]))
  })

  it("returns an empty set for an empty manifest", () => {
    expect(doneAnchorsFromManifest("")).toEqual(new Set())
  })
})

describe("computeOutcome", () => {
  const base = {
    anchor: "example.com",
    attempt: 1,
    tail: "",
    timeoutS: 3600,
    runCapUsd: 8,
    seconds: 120,
    at: "2026-08-25T00:00:00.000Z",
  }

  it("a normal finish with a map on disk is ok, priced at the map's own cost", () => {
    const out = computeOutcome({
      ...base,
      code: 0,
      killed: false,
      mine: "sweep-example-com-20260825000000.json",
      mineUsd: 1.5,
      stopFile: undefined,
      stopFileUsd: null,
    })
    expect(out).toMatchObject({ ok: true, usd: 1.5, detail: "runs/sweep-example-com-20260825000000.json" })
    expect(out.capped).toBeUndefined()
  })

  it("exit zero with no map found is not ok, even though nothing looks like a failure", () => {
    const out = computeOutcome({ ...base, code: 0, killed: false, mine: undefined, mineUsd: null, stopFile: undefined, stopFileUsd: null })
    expect(out.ok).toBe(false)
    expect(out.usd).toBeNull()
    expect(out.detail).toBe("exit 0")
  })

  it("killed by the outer wall clock reports the timeout, not the exit code", () => {
    const out = computeOutcome({ ...base, code: null, killed: true, mine: undefined, mineUsd: null, stopFile: undefined, stopFileUsd: null })
    expect(out.ok).toBe(false)
    expect(out.detail).toBe("killed at the 3600s cap")
  })

  it("a non-zero exit with output tail includes the tail's last lines", () => {
    const out = computeOutcome({
      ...base,
      code: 1,
      killed: false,
      tail: "line one\nline two\nline three\nline four",
      mine: undefined,
      mineUsd: null,
      stopFile: undefined,
      stopFileUsd: null,
    })
    expect(out.detail).toBe("exit 1 — line two / line three / line four")
  })

  it("a capped run that still wrote a map is ok, and says so distinctly", () => {
    const out = computeOutcome({
      ...base,
      code: EXIT.capped,
      killed: false,
      mine: "sweep-example-com-20260825000000.json",
      mineUsd: 8,
      stopFile: undefined,
      stopFileUsd: null,
    })
    expect(out).toMatchObject({ ok: true, capped: true, usd: 8, detail: "runs/sweep-example-com-20260825000000.json — stopped at the run cap while linking" })
  })

  it("a capped run with no map is priced off the stopped-run record when it can be read", () => {
    const out = computeOutcome({
      ...base,
      code: EXIT.capped,
      killed: false,
      mine: undefined,
      mineUsd: null,
      stopFile: "stopped-example-com-20260825000000.json",
      stopFileUsd: 7.2,
    })
    expect(out).toMatchObject({
      ok: false,
      capped: true,
      usd: 7.2,
      detail: "stopped at the $8.00 run cap — runs/stopped-example-com-20260825000000.json",
    })
  })

  it("a capped run whose stopped record cannot be read is charged the full run cap, not left null", () => {
    const out = computeOutcome({
      ...base,
      code: EXIT.capped,
      killed: false,
      mine: undefined,
      mineUsd: null,
      stopFile: "stopped-example-com-20260825000000.json",
      stopFileUsd: null,
    })
    expect(out.usd).toBe(8)
    expect(out.ok).toBe(false)
  })

  it("a capped run with no stopped file at all is still charged the run cap", () => {
    const out = computeOutcome({ ...base, code: EXIT.capped, killed: false, mine: undefined, mineUsd: null, stopFile: undefined, stopFileUsd: null })
    expect(out.usd).toBe(8)
    expect(out.detail).toBe("stopped at the $8.00 run cap")
  })

  it("carries anchor, attempt and at through unchanged", () => {
    const out = computeOutcome({ ...base, anchor: "other.com", attempt: 3, at: "stamp", code: 0, killed: false, mine: undefined, mineUsd: null, stopFile: undefined, stopFileUsd: null })
    expect(out.anchor).toBe("other.com")
    expect(out.attempt).toBe(3)
    expect(out.at).toBe("stamp")
  })
})
