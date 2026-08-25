import { describe, expect, it } from "vitest"
import { parseSweepStdout } from "../scripts/overnight.js"

/**
 * `scripts/overnight.ts` spawns `pnpm sweep <domain> <queries>` as a
 * subprocess and reads its role in the batch entirely off the captured
 * stdout — seven separate regexes, none of them exercised by anything.
 * Coverage gap found sweeping `scripts/*.ts` beyond sweep.ts (D-scope:
 * "areas nobody has swept"), the same class SELF-55/56 already fixed in
 * query-yield.ts and corroboration-arrival.ts.
 *
 * The fixtures below are built from the exact template literals the two
 * files that actually print this text use: the headline block in
 * `scripts/sweep.ts` (`N on the map from N hosts`, `$N.NNNN · Ns`) and the
 * `say("understand", ...)` narration in `packages/sweep/src/sweep.ts`
 * (`N products → N distinct markets`, `no queries for N of N core
 * markets`) — routed to stdout by `onLog` as `$<runningTotal>  <line>`.
 */
describe("parseSweepStdout", () => {
  it("reads every field off a realistic sweep transcript", () => {
    const stdout = [
      "$0.0123  12s  8 products → 3 distinct markets, 1 coinages to avoid",
      "$0.0400  45s  no queries for 2 of 5 core markets: pos-hardware, payments",
      "================================================================================",
      "531 on the map from 926 hosts (395 left it: 340 noise, 55 judged to be in a different market)",
      "kinds      { core: 8, competitor: 210 }",
      "relations  { competitor: 210, none: 90 }",
      "",
      "147 queries fired of 158 queued · 147 SERP calls · 1240 results",
      "tokens 512,000 in / 84,000 out",
      "phases  understand 0-12s  ·  sweep 15-410s  ·  classify 420-838s",
      "$0.7123 · 1710s",
    ].join("\n")

    expect(parseSweepStdout(stdout)).toEqual({
      usd: 0.7123,
      secs: 1710,
      kept: 531,
      hosts: 926,
      products: 8,
      markets: 3,
      uncovered: 2,
    })
  })

  it("defaults uncovered to 0 when every core market got a query", () => {
    // The "no queries for" line only prints when `missed.length` is nonzero
    // — most runs never emit it.
    const stdout = [
      "$0.0123  12s  8 products → 3 distinct markets, 1 coinages to avoid",
      "531 on the map from 926 hosts (395 left it: 340 noise, 55 judged to be in a different market)",
      "$0.7123 · 1710s",
    ].join("\n")

    expect(parseSweepStdout(stdout).uncovered).toBe(0)
  })

  it("does not let the phases line's 'railname NNN-NNNs' spans be mistaken for the summary seconds", () => {
    // "· 410s" style substrings never occur in the phases line — each span
    // reads "0-12s", digits-dash-digits-s, not "· <digits>s" — but the
    // regex is unanchored, so a future format change that inserted one
    // ahead of the real summary line would silently corrupt `secs`. This
    // fixture pins today's correct behaviour.
    const stdout = [
      "phases  understand 0-12s  ·  sweep 15-410s  ·  classify 420-838s",
      "$0.7123 · 1710s",
    ].join("\n")

    expect(parseSweepStdout(stdout).secs).toBe(1710)
  })

  it("zeroes every field on stdout with none of the expected lines", () => {
    expect(parseSweepStdout("")).toEqual({
      usd: 0,
      secs: 0,
      kept: 0,
      hosts: 0,
      products: 0,
      markets: 0,
      uncovered: 0,
    })
  })

  it("a failed run's truncated stdout (no summary line reached) still returns zeroes rather than throwing", () => {
    const stdout = "$0.0123  12s  8 products → 3 distinct markets, 1 coinages to avoid\n"
    const row = parseSweepStdout(stdout)
    expect(row.usd).toBe(0)
    expect(row.secs).toBe(0)
    expect(row.kept).toBe(0)
    expect(row.hosts).toBe(0)
    expect(row.products).toBe(8)
    expect(row.markets).toBe(3)
  })
})
