import { describe, expect, it } from "vitest"
import { score } from "./CommandPalette"

/**
 * CommandPalette.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history).
 *
 * `score` is the one piece of the palette with rules in it — the same reason
 * lib/graph/search.ts's rankMatches was pulled out pure and tested on its
 * own (see that file's own comment) — but it was never exported, so nothing
 * in the repo has ever exercised its subsequence match, its gap penalty, or
 * its ranking order. The component's own header comment states the contract
 * this locks down: subsequence not substring ("brdt" finds "Bright Data"),
 * and "prefers a prefix hit, then an early hit, then a short title."
 */

describe("score: no-match and prefix short-circuits", () => {
  it("scores an empty needle 0 (matches everything, ranked first)", () => {
    expect(score("", "Bright Data")).toBe(0)
  })

  it("scores a case-insensitive prefix hit 0, the best possible score", () => {
    expect(score("bri", "Bright Data")).toBe(0)
  })

  it("returns -1 when the needle's letters do not all appear in order", () => {
    expect(score("xyz", "Bright Data")).toBe(-1)
    // "atbr" has the right letters but not in the haystack's order.
    expect(score("atbr", "Bright Data")).toBe(-1)
  })
})

describe("score: subsequence matching, not substring", () => {
  it("finds a subsequence that is never contiguous in the haystack", () => {
    // b-r(ight )d(ata t)... "brdt" is not a substring of "Bright Data".
    expect(score("brdt", "Bright Data")).toBeGreaterThan(0)
  })

  it("lowercases the haystack but assumes the needle already is (the caller's job — see the q.trim().toLowerCase() call site)", () => {
    expect(score("brdt", "BRIGHT DATA")).toBe(score("brdt", "Bright Data"))
    expect(score("BRDT", "Bright Data")).toBe(-1)
  })
})

describe("score: ranking order matches the component's stated preference", () => {
  it("prefers a prefix hit over a later subsequence hit", () => {
    const prefixHit = score("br", "Bright Data")
    const laterHit = score("br", "Umbra Data") // "b" then "r" appear, but not as a prefix
    expect(prefixHit).toBeLessThan(laterHit)
  })

  it("prefers an earlier subsequence hit over a later one, neither a prefix", () => {
    const early = score("ta", "Data Bright") // "t" at index 2, "a" at index 3 — no gap
    const late = score("ta", "Bright Data") // "t" at index 5, "a" at index 8 — one gap
    expect(early).toBeLessThan(late)
  })

  it("prefers a shorter haystack when the match starts at the same index", () => {
    const short = score("at", "Data") // "a" at index 1, "t" at index 2
    const long = score("at", "Data Data") // same positions, longer string
    expect(short).toBeLessThan(long)
  })

  it("penalizes a gappy match more than a contiguous one starting at the same index", () => {
    const contiguous = score("da", "xdax") // "d" at index 1, "a" at index 2 — no gap
    const gapped = score("da", "xdyax") // "d" at index 1, "a" at index 3 — one gap
    expect(contiguous).toBeLessThan(gapped)
  })
})
