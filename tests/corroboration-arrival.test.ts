import { describe, expect, it } from "vitest"
import { arrivalRow, hostOf } from "../scripts/corroboration-arrival.js"

/**
 * `arrivalRow` (the join behind `scripts/corroboration-arrival.ts`) had no
 * test anywhere — the whole file ran at import time (the loop over
 * `readdirSync` doubled as the file scan and the arithmetic), so nothing
 * could import it at all. Coverage gap found sweeping `scripts/*.ts beyond
 * sweep.ts` (D-scope: "areas nobody has swept"), the same class of gap
 * `tallyQueryYield` in query-yield.ts (SELF-55) already had fixed. Extracted
 * the per-run arithmetic into `arrivalRow`, gated the CLI body (argv
 * parsing, the directory scan, every `console.log`) behind the same
 * `invokedDirectly` guard `query-yield.ts` and `run-doctor.ts` already use.
 */
describe("hostOf", () => {
  it("lowercases via registrableHost", () => {
    expect(hostOf("https://WWW.Example.com/path")).toBe("example.com")
  })

  it("returns an empty string for an unparseable url instead of throwing", () => {
    expect(hostOf("not a url")).toBe("")
  })
})

describe("arrivalRow", () => {
  /** 20 queries — the header's own "too short to have a first and second
   *  half" floor — each returning one already-corroborated host plus one
   *  query-specific host, so `rival.com` crosses seenIn >= 2 at query index
   *  1 (10% of the way through) and every other host never repeats. */
  const searched = Array.from({ length: 20 }, (_, i) => ({
    hits: [{ url: "https://rival.com/a" }, { url: `https://only-query-${i}.com/a` }],
  }))

  it("returns null for a run shorter than 20 queries — too short to say anything about timing", () => {
    expect(arrivalRow("sweep-x-1.json", { searched: searched.slice(0, 19) }, 2)).toBeNull()
  })

  it("returns null for a run whose searched array is missing or malformed", () => {
    expect(arrivalRow("sweep-x-1.json", {}, 2)).toBeNull()
    expect(arrivalRow("sweep-x-1.json", { searched: "nope" as any }, 2)).toBeNull()
  })

  it("returns null when no host ever reaches the threshold", () => {
    // Every host here is unique to its own query — none repeats, so none
    // reaches seenIn >= 2.
    const neverRepeats = Array.from({ length: 20 }, (_, i) => ({ hits: [{ url: `https://only-query-${i}.com/a` }] }))
    expect(arrivalRow("sweep-x-1.json", { searched: neverRepeats }, 2)).toBeNull()
  })

  it("strips the sweep- prefix and .json suffix from the file name", () => {
    const row = arrivalRow("sweep-example-com-20260101.json", { searched }, 2)
    expect(row?.run).toBe("example-com-20260101")
  })

  it("marks a host late if it first reaches the threshold past the halfway point, veryLate past 75%", () => {
    // rival.com reaches seenIn 2 at index 1 (5%) — early, neither late nor
    // very late. Add a second host that only repeats starting at index 15
    // (75%), so it first hits seenIn 2 at index 16 (80%) — both late and
    // very late.
    const withLateHost = searched.map((s, i) =>
      i >= 15 ? { hits: [...s.hits, { url: "https://slow.com/a" }] } : s,
    )
    const row = arrivalRow("sweep-x-1.json", { searched: withLateHost }, 2)
    expect(row).toMatchObject({ queries: 20, reached: 2, late: 1, veryLate: 1 })
  })

  it("counts distinct hosts per query, not hits — two hits from one host on one query count once", () => {
    const dup = searched.map((s, i) => (i === 0 ? { hits: [...s.hits, { url: "https://rival.com/b" }] } : s))
    const row = arrivalRow("sweep-x-1.json", { searched: dup }, 2)
    // rival.com still reaches seenIn 2 at index 1, same as without the
    // duplicate hit on index 0 — the dup did not fast-forward it.
    expect(row?.reached).toBe(1)
  })

  it("drops an unparseable hit url rather than counting it toward seenIn", () => {
    const withBad = searched.map((s, i) => (i === 5 ? { hits: [...s.hits, { url: "not a url" }] } : s))
    const row = arrivalRow("sweep-x-1.json", { searched: withBad }, 2)
    expect(row?.reached).toBe(1)
  })
})
