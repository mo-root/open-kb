import { describe, expect, it } from "vitest"
import { plural, resolve, tally } from "../scripts/read.js"

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

  it("joins a bare filename ending in .json (no directory) onto runs/ instead of passing it through", () => {
    const files = ["sweep-brightdata-com-20260821105321.json"]
    expect(resolve("sweep-brightdata-com-20260821105321.json", files)).toBe(
      "runs/sweep-brightdata-com-20260821105321.json",
    )
  })

  it("picks the lexically newest of several matches — the run filename's own timestamp suffix", () => {
    const files = [
      "sweep-brightdata-com-20260820090000.json",
      "sweep-brightdata-com-20260821105321.json",
      "sweep-brightdata-com-20260819010000.json",
    ]
    expect(resolve("brightdata.com", files)).toBe("runs/sweep-brightdata-com-20260821105321.json")
  })

  it("picks the newer swarm run over an older sweep run for the same domain, despite 'sweep-' sorting lexically after 'swarm-'", () => {
    const files = [
      "sweep-brightdata-com-20260101000000.json",
      "swarm-brightdata-com-20260601000000.json",
    ]
    expect(resolve("brightdata.com", files)).toBe("runs/swarm-brightdata-com-20260601000000.json")
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

/**
 * `plural` backs the one summary line (`the run` → queries/searches/results/
 * hosts/edges) that the web-wide pluralization audit (26ca32a) never
 * reached, because it only swept `packages/web`. Before this fix a one-query
 * or one-host run printed "1 queries" / "1 hosts" with no guard at all —
 * the same bare-plural shape fixed four times over in PlanCard.tsx,
 * CostBreakdown.tsx, BuildWorkflow.tsx and the run report page.
 */
describe("plural", () => {
  it("uses the singular form for exactly 1", () => {
    expect(plural(1, "query", "queries")).toBe("1 query")
    expect(plural(1, "host")).toBe("1 host")
  })

  it("uses the given plural form for counts other than 1, including 0", () => {
    expect(plural(0, "query", "queries")).toBe("0 queries")
    expect(plural(2, "query", "queries")).toBe("2 queries")
  })

  it("defaults the plural form to the singular plus 's' when not given", () => {
    expect(plural(3, "result")).toBe("3 results")
    expect(plural(1, "result")).toBe("1 result")
  })
})
