import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { diagnose } from "../scripts/run-doctor.js"

/**
 * The doctor reads shapes this repo does not control: 45 run files written by
 * a dozen versions of the engine, most of them predating most report fields.
 * It is also now imported by `scripts/sweep.ts` and runs at the end of every
 * CLI run, where a throw would land after the map was written and read as a
 * failed run.
 *
 * So the contract is narrow and worth pinning: never throw, and never let an
 * absent field pass for a measured zero.
 */

const runsDir = join(process.cwd(), "runs")
const files = (() => {
  try { return readdirSync(runsDir).filter((f) => f.startsWith("sweep-") && f.endsWith(".json")) }
  catch { return [] }
})()

describe("run-doctor over the runs on disk", () => {
  // `runs/` is gitignored — a clean checkout (this branch's own sandboxed
  // overnight fires included) has none, and no fixture can stand in: every
  // assertion below is a count taken from whatever the real corpus happens to
  // contain. Ungated, this `it` failed unconditionally on such a checkout
  // ("expected 0 to be greater than 20") — not a defect in the doctor, just
  // the same absent-`runs/` gap `scripts/check-skips.mjs` already gates three
  // other suites for, minus the gate. Skipping only when the directory is
  // fully empty keeps the >20 floor meaningful: a checkout with 1-20 files
  // still fails it, on purpose (see the comment at that assertion).
  it.skipIf(files.length === 0)("survives every run file, across every engine version that wrote one", () => {
    // Without this the whole suite passes on an empty runs/ and proves
    // nothing — the exact vacuity this branch removed from four tests.
    expect(files.length, "run files to diagnose").toBeGreaterThan(20)

    let withGaps = 0
    for (const f of files) {
      const j = JSON.parse(readFileSync(join(runsDir, f), "utf8"))
      const notes = diagnose(j.report ?? {}, j.stats ?? {})
      expect(notes.length, `${f} produced no findings at all`).toBeGreaterThan(0)
      for (const n of notes) {
        expect(["gap", "watch", "ok", "unknown"]).toContain(n.level)
        expect(n.what.length, `${f}: a finding with no name`).toBeGreaterThan(0)
        expect(n.detail.length, `${f}: ${n.what} with no detail`).toBeGreaterThan(0)
      }
      if (notes.some((n) => n.level === "gap")) withGaps++
    }
    // The corpus really does contain gaps, so "never throws" is not being
    // demonstrated on a set of runs the doctor had nothing to say about.
    expect(withGaps, "runs with at least one gap").toBeGreaterThan(0)
  })

  it("calls an absent field unknown, not clean", () => {
    // The oldest runs carry none of this week's fields. Every one of those
    // has to come back `unknown`; a `gap` would be inventing a defect and an
    // `ok` would be inventing a measurement.
    const notes = diagnose({}, {})
    expect(notes.length).toBeGreaterThan(4)
    expect(notes.every((n) => n.level === "unknown")).toBe(true)
    for (const n of notes) expect(n.detail).toContain("not recorded")
  })

  it("separates a stage that ran and found nothing from one that never ran", () => {
    // The distinction the whole script is built on, and the one the listicle
    // guard added to the engine: identical zeros, opposite meanings.
    const looked = diagnose({ listicleHarvest: { starved: false, rowsScanned: 0, vendorsFound: 0, queriesFired: 0 } }, {})
    const starved = diagnose({ listicleHarvest: { starved: true, rowsScanned: 0, vendorsFound: 0, queriesFired: 0 } }, {})

    const lookedNote = looked.find((n) => n.what === "listicle harvest")!
    const starvedNote = starved.find((n) => n.what === "listicle harvest")!
    expect(lookedNote.level).toBe("ok")
    expect(starvedNote.level).toBe("watch")
    expect(starvedNote.detail).toContain("ceiling")
  })

  it("gives second look a note even when it ran and asked nobody", () => {
    // `sl.asked === 0` (every host placed on the first pass) used to fall
    // through every branch — not `ok`, not `unknown`, no note printed at
    // all, unlike every other zero-but-recorded case in this file.
    const notes = diagnose({ secondLook: { asked: 0, rescued: 0, failed: 0 } }, {})
    const note = notes.find((n) => n.what === "second look")
    expect(note).toBeDefined()
    expect(note!.level).toBe("ok")
    expect(note!.detail).toContain("0 asked")
  })

  it("gives triage skip a clean note when the run found no hosts at all, not NaN%", () => {
    // `t.hosts === 0` (a dead search, nothing to triage) used to compute
    // `t.skipped / t.hosts` as 0/0 = NaN and print the literal text
    // "(NaN%)" in the detail — the same zero-that-means-two-things trap the
    // second-look fix above exists to catch, just visible garbage instead
    // of a missing note.
    const notes = diagnose({ triage: { hosts: 0, skipped: 0, kept: 0, calls: 0, failed: 0 } }, {})
    const note = notes.find((n) => n.what === "triage skip")
    expect(note).toBeDefined()
    expect(note!.level).toBe("ok")
    expect(note!.detail).not.toContain("NaN")
    expect(note!.detail).toContain("0/0")
  })

  it("reads a rival channel cut by a ceiling differently from one that failed", () => {
    // The rival family is dealt last, so under a ceiling "names found, no
    // queries" is the budget working. Uncapped, the same pair is a real gap.
    const rivals = { found: 5, urlsScanned: 899, queries: 0, reachedMap: 0 }
    const capped = diagnose({ rivals, budget: { maxQueries: 43 } }, {}).find((n) => n.what === "rival harvest")!
    const uncapped = diagnose({ rivals }, {}).find((n) => n.what === "rival harvest")!
    expect(capped.level).toBe("watch")
    expect(uncapped.level).toBe("gap")
    expect(uncapped.detail).toContain("no ceiling explains it")
  })
})
