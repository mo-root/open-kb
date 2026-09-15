import { describe, it, expect } from "vitest"
import { suggest } from "../src/sweep.js"

/**
 * `suggest()` (sweep.ts:1406) had no direct test — the only path that reached
 * it was the DNS-preflight fixture
 * (`an-anchor-that-does-not-resolve-fails-by-name.test.ts`), whose anchor's
 * TLD is `.example`, which matches none of the eight `GOOD_TLDS` and so never
 * exercised the doubled-letter or length+1 branches, or their `alt`-truthy
 * return.
 *
 * Reaching those branches directly (`suggest` exported for it) surfaced a
 * real bug: `tld === good` used to `continue` past only THAT candidate's own
 * two checks, leaving `tld` free to still match a DIFFERENT candidate later
 * in the loop. `"co"` is `"com"`'s own prefix, so `"com".length === "co".length
 * + 1 && "com".includes("co")` is true — a `.com` domain that fails DNS for
 * an unrelated reason (unregistered, expired, a typo in the second-level
 * name) came back "Did you mean foo.co?", silently changing a correct TLD
 * into a different one. Fixed with an early return once `tld` is already in
 * `GOOD_TLDS`, which removes the whole class rather than special-casing the
 * one colliding pair.
 */
describe("suggest", () => {
  it("never flags an already-valid .com as a typo of .co, the collision that broke this", () => {
    expect(suggest("foo.com")).toBe("")
  })

  it("returns nothing for every other already-valid TLD too", () => {
    for (const good of ["com", "io", "ai", "dev", "app", "co", "net", "org"]) {
      expect(suggest(`foo.${good}`)).toBe("")
    }
  })

  it("catches a doubled letter", () => {
    expect(suggest("foo.coom")).toBe("Did you mean foo.com?")
  })

  it("catches one extra character", () => {
    expect(suggest("foo.coms")).toBe("Did you mean foo.com?")
  })

  it("preserves every label before the TLD, including a subdomain", () => {
    expect(suggest("sub.example.coom")).toBe("Did you mean sub.example.com?")
  })

  it("returns nothing when no fix is one character away", () => {
    expect(suggest("foo.example")).toBe("")
  })
})
