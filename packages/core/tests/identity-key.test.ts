import { describe, expect, it } from "vitest"
import { identityKey } from "../src/judge.js"

/**
 * identityKey had no direct test anywhere — it was covered only indirectly,
 * through wrongDoorName/anchorIdentityTheft (judge.ts) and each of two other
 * files' own private, byte-for-byte-identical copies: export-kb.ts's anchor-
 * label suppression and sweep.ts's one-spelling-one-owner host claiming
 * (both now import this one instead of restating it — see judge.ts's own
 * comment on why the restating was a drift risk). Locking the primitive
 * itself, once, is what makes "these three call sites agree on identity"
 * true by construction rather than by three independently-tuned regexes
 * happening to match.
 */
describe("identityKey — the fold three call sites now share instead of restating", () => {
  it("lowercases", () => {
    expect(identityKey("FIGMA")).toBe("figma")
  })

  it("strips punctuation, so hyphenated and camel-cased spellings of one name agree", () => {
    expect(identityKey("e-gain")).toBe("egain")
    expect(identityKey("eGain")).toBe("egain")
    expect(identityKey("EGAIN")).toBe("egain")
  })

  it("strips whitespace and digits' neighbours the same way, keeping alphanumerics only", () => {
    expect(identityKey("Open AI 4.0")).toBe("openai40")
  })

  it("the empty string folds to the empty string, not a thrown error", () => {
    expect(identityKey("")).toBe("")
  })
})
