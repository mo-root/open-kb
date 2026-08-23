import { describe, expect, it } from "vitest"
import { anchorIdentityTheft } from "../src/judge.js"

/**
 * anchorIdentityTheft has no direct test anywhere — judgeHosts calls it
 * (judge.ts:553) and sweep.ts's second-look path calls it again
 * (sweep.ts:4260), both only ever exercised through full judgeHosts
 * integration fixtures in packages/sweep/tests/rank.test.ts, none of which
 * happen to script a model naming the anchor for a different host. wrongDoorName,
 * the sibling withdrawal rule right above this one in judge.ts, has its own
 * dedicated file (wrong-door-name.test.ts); this one never got the same
 * treatment even though a regression here has the same shape of consequence:
 * a real entity silently renamed out of the map, or a real theft left
 * standing.
 */

describe("anchorIdentityTheft — fires when a host is answered with the anchor's own name", () => {
  it("a rival host judged with the anchor's brand is withdrawn", () => {
    expect(anchorIdentityTheft("Cursor", "windsurf.com", "cursor.com")).toBe(true)
  })

  it("matches on the anchor's registrable label regardless of case", () => {
    expect(anchorIdentityTheft("CURSOR", "windsurf.com", "Cursor.com")).toBe(true)
  })

  it("matches through punctuation on the written name — the comparison is exact once stripped, not fuzzy", () => {
    expect(anchorIdentityTheft("Cursor!", "windsurf.com", "cursor.com")).toBe(true)
  })
})

describe("anchorIdentityTheft — declines when the host actually is the anchor", () => {
  it("the anchor's own host naming itself is not theft", () => {
    expect(anchorIdentityTheft("Cursor", "cursor.com", "cursor.com")).toBe(false)
  })

  it("a www-prefixed anchor host still registrable-matches and is not theft", () => {
    expect(anchorIdentityTheft("Cursor", "www.cursor.com", "cursor.com")).toBe(false)
  })
})

describe("anchorIdentityTheft — declines on an unrelated name", () => {
  it("a name that is not the anchor's brand never fires", () => {
    expect(anchorIdentityTheft("Windsurf", "windsurf.com", "cursor.com")).toBe(false)
  })
})

describe("anchorIdentityTheft — declines on a too-short anchor label", () => {
  it("a two-letter anchor label never fires, even on an exact match", () => {
    expect(anchorIdentityTheft("Io", "other.com", "io.com")).toBe(false)
  })
})
