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
  it("survives every run file, across every engine version that wrote one", () => {
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
