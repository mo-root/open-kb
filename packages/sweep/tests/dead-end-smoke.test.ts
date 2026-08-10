import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Real-data smoke over the live run that motivated the dead-end taxonomy:
 * runs/sweep-brightdata-com-202608051650.json settled 127 of its 867 hosts as
 * unreadable, one flattened sentence per entity.
 *
 * That run PREDATES `unreadableReason`. Its entities carry only the sentence
 * with the verdict status — "could not be read this run (blocked)" — and the
 * reason codes are NOT recoverable from that: a "blocked" could have been
 * empty-body, thin-render, no-response or server-error, and nothing stored
 * says which. So the per-reason branch below self-skips on this file with
 * that stated; the NEXT live run populates the field, and the same test
 * starts asserting the split the moment a stored entity carries it.
 *
 * `runs/` is gitignored and CI will not have it, so the suite skips honestly
 * when the file is absent instead of green-lighting counts it never computed
 * (the drift.test.ts precedent, walk-up included).
 */
const RUN_FILE = "sweep-brightdata-com-202608051650.json"
const runPath = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "runs", RUN_FILE))) return join(dir, "runs", RUN_FILE)
    dir = dirname(dir)
  }
  return null
})()

interface StoredEntity {
  domain: string
  because?: string
  unreadableReason?: string
}

describe.skipIf(runPath === null)("the live run's 127 dead ends", () => {
  it("every unreadable entity is countable, and codes — once present — sum to the kernel's count", () => {
    const run = JSON.parse(readFileSync(runPath!, "utf8")) as {
      entities: StoredEntity[]
      report: { kernel: { unreadable: number; unreadableByReason?: Record<string, number> } }
    }
    const unread = run.entities.filter(
      (e) =>
        typeof e.because === "string" &&
        (e.because.includes("could not be read this run") || e.because.includes("front page fetch threw")),
    )
    // The flattened sentence is the one recoverable fact: 127 hosts, matching
    // the kernel's own count. This held before the taxonomy and must keep
    // holding after — the field is additive.
    expect(unread.length).toBe(run.report.kernel.unreadable)

    const coded = unread.filter((e) => e.unreadableReason !== undefined)
    if (coded.length === 0) {
      // The 2026-08-05 run predates the field: nothing to count by reason.
      // Deliberately not a failure — the next live run populates
      // `unreadableReason` on every unreadable entity and the branch below
      // takes over unedited.
      return
    }
    // A future run: every unreadable entity carries its code, and the report's
    // split is exactly the per-entity tally.
    expect(coded.length).toBe(unread.length)
    const tally: Record<string, number> = {}
    for (const e of coded) tally[e.unreadableReason!] = (tally[e.unreadableReason!] ?? 0) + 1
    expect(run.report.kernel.unreadableByReason).toEqual(tally)
    const summed = Object.values(run.report.kernel.unreadableByReason ?? {}).reduce((a, b) => a + b, 0)
    expect(summed).toBe(run.report.kernel.unreadable)
  })
})
