import { describe, expect, it } from "vitest"
import { familyFloorFromEnv, wallClockMsFromEnv } from "../scripts/swarm.js"

/**
 * `scripts/swarm.ts`'s own env parsing for `OPENKB_SWARM_WALL` and
 * `OPENKB_SWARM_FAMILIES` had no test anywhere: the whole file used to run at
 * import time (argv, credentials, a real `runSwarm` that spends money), so
 * even reaching this arithmetic meant shelling out to a live run. Split out
 * the same way `readFlag`/`computeOutcome` split from scripts/batch.ts and
 * `readCapUsd`/`capUsdOrExit` split from scripts/spend-caps.ts — pure
 * functions over the raw env string, importable now that the spending body
 * sits behind the `invokedDirectly` guard. Coverage gap found sweeping
 * scripts/*.ts beyond sweep.ts and batch.ts for the same "zero test
 * coverage" class already fixed elsewhere in this directory.
 */

describe("wallClockMsFromEnv", () => {
  it("defaults to 600_000 when unset", () => {
    expect(wallClockMsFromEnv(undefined)).toBe(600_000)
  })

  it("takes a positive override", () => {
    expect(wallClockMsFromEnv("120000")).toBe(120_000)
  })

  it("falls back on zero, negative, NaN and non-finite values — a malformed wall must not become no wall", () => {
    for (const raw of ["0", "-1", "not-a-number", "Infinity", "-Infinity"]) {
      expect(wallClockMsFromEnv(raw)).toBe(600_000)
    }
  })
})

describe("familyFloorFromEnv", () => {
  it("keeps the library default (undefined) when unset or blank", () => {
    expect(familyFloorFromEnv(undefined)).toBeUndefined()
    expect(familyFloorFromEnv("")).toBeUndefined()
    expect(familyFloorFromEnv("   ")).toBeUndefined()
  })

  it("disables on off/false, case-insensitively", () => {
    expect(familyFloorFromEnv("off")).toBe(false)
    expect(familyFloorFromEnv("OFF")).toBe(false)
    expect(familyFloorFromEnv("false")).toBe(false)
    expect(familyFloorFromEnv("False")).toBe(false)
  })

  it("enables on on/true, case-insensitively", () => {
    expect(familyFloorFromEnv("on")).toBe(true)
    expect(familyFloorFromEnv("ON")).toBe(true)
    expect(familyFloorFromEnv("true")).toBe(true)
  })

  it("sizes the floor from a bare number", () => {
    expect(familyFloorFromEnv("3")).toBe(3)
    expect(familyFloorFromEnv(" 5 ")).toBe(5)
    // Not clamped here — the library it configures does the clamping
    // (documented as "clamps to its 5-template deck"), so a value outside
    // 1-5 is still a real number this function must pass through honestly.
    expect(familyFloorFromEnv("9")).toBe(9)
  })

  it("keeps the library default on anything unrecognised, rather than guessing", () => {
    expect(familyFloorFromEnv("maybe")).toBeUndefined()
    expect(familyFloorFromEnv("2.5x")).toBeUndefined()
  })
})
