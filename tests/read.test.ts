import { describe, expect, it } from "vitest"
import { resolve, tally } from "../scripts/read.js"

/**
 * `resolve` and `tally` — the file-matching and grouping logic behind
 * `pnpm read` — had no test anywhere. The whole file ran at import time
 * (argv, `readdirSync`, console), so nothing could import it at all.
 * Coverage gap found sweeping `scripts/*.ts beyond sweep.ts` (D-scope: "areas
 * nobody has swept"). `resolve` in particular has a real bug history — its
 * newest-run sort used to open every match twice for nothing (cbedb47) —
 * that direct coverage would have caught sooner. Fixed the same way
 * `recallForAnchor` was pulled out of `recall.ts`: extract the pure
 * functions, gate the CLI body behind the `invokedDirectly` guard
 * `run-doctor.ts` already uses.
 */
describe("resolve", () => {
  it("passes a path ending in .json straight through, ignoring the file list", () => {
    expect(resolve("some/where/run.json", [])).toBe("some/where/run.json")
  })

  it("matches a domain against its slugified filename", () => {
    const files = ["sweep-brightdata-com-20260821105321.json", "sweep-stripe-com-20260820090000.json"]
    expect(resolve("brightdata.com", files)).toBe("runs/sweep-brightdata-com-20260821105321.json")
  })

  it("matches a bare run id (already slug-shaped) via substring, not just the derived slug", () => {
    const files = ["sweep-brightdata-com-20260821105321.json"]
    expect(resolve("sweep-brightdata-com-20260821105321", files)).toBe("runs/sweep-brightdata-com-20260821105321.json")
  })

  it("picks the lexically newest of several matches — the run filename's own timestamp suffix", () => {
    const files = [
      "sweep-brightdata-com-20260820090000.json",
      "sweep-brightdata-com-20260821105321.json",
      "sweep-brightdata-com-20260819010000.json",
    ]
    expect(resolve("brightdata.com", files)).toBe("runs/sweep-brightdata-com-20260821105321.json")
  })

  it("ignores non-.json files when matching", () => {
    const files = ["sweep-brightdata-com-20260821105321.json.bak", "notes-brightdata-com.txt"]
    expect(() => resolve("brightdata.com", files)).toThrow(/no run matching "brightdata\.com"/)
  })

  it("throws naming the arg and listing at most the last 8 candidate files when nothing matches", () => {
    const files = ["sweep-stripe-com-20260820090000.json"]
    expect(() => resolve("brightdata.com", files)).toThrow('no run matching "brightdata.com". runs/ holds:\n  sweep-stripe-com-20260820090000.json')
  })

  it("an empty file list (a missing or empty runs/) throws the same refusal, not a crash", () => {
    expect(() => resolve("brightdata.com", [])).toThrow(/no run matching "brightdata\.com"/)
  })
})

describe("tally", () => {
  it("counts each string, most-frequent first", () => {
    expect(tally(["competitor", "adjacent", "competitor", "substitute", "competitor"])).toEqual([
      ["competitor", 3],
      ["adjacent", 1],
      ["substitute", 1],
    ])
  })

  it("returns an empty array for an empty input, not a crash", () => {
    expect(tally([])).toEqual([])
  })
})
