import { describe, expect, it } from "vitest"
import { hostOf, recallForAnchor } from "../scripts/recall.js"

/**
 * `recallForAnchor` — the found-vs-placed split that is the whole point of
 * `scripts/recall.ts` (see its header comment: "found" is a search failure,
 * "as rival" is a classify failure) — had no test anywhere. The whole file
 * ran the arithmetic inline at import time (argv, `readdirSync`, console),
 * so nothing could import it at all. Coverage gap found sweeping
 * `scripts/*.ts beyond sweep.ts` (D-scope: "areas nobody has swept"). Fixed
 * the same way `promptStats` was pulled out of `show-prompt.ts`: extract the
 * pure function, gate the CLI body behind the `invokedDirectly` guard
 * `run-doctor.ts` already uses.
 */
describe("recallForAnchor", () => {
  it("finds every rival and places all of them correctly", () => {
    const row = recallForAnchor(
      ["a.com", "b.com"],
      [
        { domain: "a.com", relation: "competitor" },
        { domain: "b.com", relation: "substitute" },
      ],
    )
    expect(row).toEqual({ kept: 2, truth: 2, found: 2, asRival: 2, missed: [], misplaced: [] })
  })

  it("a rival never surfaced by any query is missed, not misplaced", () => {
    const row = recallForAnchor(["a.com", "b.com"], [{ domain: "a.com", relation: "competitor" }])
    expect(row.found).toBe(1)
    expect(row.asRival).toBe(1)
    expect(row.missed).toEqual(["b.com"])
    expect(row.misplaced).toEqual([])
  })

  it("a rival found and judged, but not as competitor or substitute, is found and misplaced", () => {
    const row = recallForAnchor(["a.com"], [{ domain: "a.com", relation: "adjacent" }])
    expect(row.found).toBe(1)
    expect(row.asRival).toBe(0)
    expect(row.missed).toEqual([])
    expect(row.misplaced).toEqual(["a.com=adjacent"])
  })

  it("a rival present only as noise reads as missed, the same as absent entirely", () => {
    // Noise is the one kind the map itself drops, so it must not count as
    // found here either — matching the comment on the `placed` filter.
    const row = recallForAnchor(["a.com"], [{ domain: "a.com", relation: "competitor", kind: "noise" }])
    expect(row.found).toBe(0)
    expect(row.missed).toEqual(["a.com"])
  })

  it("kept counts every non-noise, non-none entity — not just the truth-list rivals", () => {
    const row = recallForAnchor(
      ["a.com"],
      [
        { domain: "a.com", relation: "competitor" },
        { domain: "unrelated.com", relation: "channel" },
        { domain: "dropped.com", relation: "none" },
        { domain: "noisy.com", relation: "competitor", kind: "noise" },
      ],
    )
    expect(row.kept).toBe(2)
    expect(row.truth).toBe(1)
  })
})

describe("hostOf", () => {
  it("lowercases and strips a leading www.", () => {
    expect(hostOf("https://WWW.Example.com/path?q=1")).toBe("example.com")
  })

  it("returns an empty string for text that is not a URL", () => {
    expect(hostOf("not a url")).toBe("")
  })
})
