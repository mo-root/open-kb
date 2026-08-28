import { describe, expect, it } from "vitest"
import { disablesFlag } from "../src/flags.js"

/**
 * disablesFlag was hand-copied byte-for-byte in scripts/sweep.ts and
 * packages/web/app/api/map/route.ts, each pointing at the other as the
 * reason its shape must not drift, with no test on either copy — the same
 * gap SELF-128 (isTypingTarget) and SELF-132 found in other hand-copied
 * pairs. Now one function, tested here; both callers import it.
 */

describe("disablesFlag", () => {
  it("reads '0' and 'false' as an explicit disable", () => {
    expect(disablesFlag("0")).toBe(true)
    expect(disablesFlag("false")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(disablesFlag("FALSE")).toBe(true)
    expect(disablesFlag("False")).toBe(true)
  })

  it("trims surrounding whitespace", () => {
    expect(disablesFlag("  0  ")).toBe(true)
    expect(disablesFlag("\tfalse\n")).toBe(true)
  })

  it("leaves a default-on flag standing when unset", () => {
    expect(disablesFlag(undefined)).toBe(false)
  })

  it("leaves a default-on flag standing for '1' or 'true'", () => {
    expect(disablesFlag("1")).toBe(false)
    expect(disablesFlag("true")).toBe(false)
  })

  it("does NOT disable on 'off' or an empty string — only '0'/'false' do", () => {
    // Deliberately unlike OPENKB_SWARM_FAMILIES's "0"/"off"/"false" shape:
    // this flag's own disable set is narrower, and a regression widening it
    // to match would silently change what OPENKB_TRIAGE=off does today.
    expect(disablesFlag("off")).toBe(false)
    expect(disablesFlag("")).toBe(false)
  })
})
