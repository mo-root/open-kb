import { describe, expect, it } from "vitest"
import { wrongDoorName } from "../src/judge.js"

/**
 * wrongDoorName withdraws a model-written name when its home is a different
 * registrable domain. An adversarial audit on a live cursor.com run found the
 * pre-fix rule firing on 5 of 6 real cases — real entities silently
 * withdrawn — because it only ever compared the name against the
 * registrable domain's OWN label. These tests hold both halves at once: the
 * measured false positives now stand down, and the rule's original
 * true-positive case (a brand on a RESELLER's subdomain) still fires.
 */

describe("wrongDoorName — measured false positives now stand down", () => {
  it("trypear.ai is PearAI's own home — the domain wears a vanity prefix containment tolerates unaided", () => {
    expect(wrongDoorName("PearAI", "trypear.ai")).toBe(false)
  })

  it("getpanto.ai is Panto AI's own home — the name wears a generic suffix, stripped before comparing", () => {
    expect(wrongDoorName("Panto AI", "getpanto.ai")).toBe(false)
  })

  it("tree-sitter.github.io is tree-sitter's own docs — brand lives in the subdomain of a platform host", () => {
    expect(wrongDoorName("tree-sitter", "tree-sitter.github.io")).toBe(false)
  })

  it("firebase.google.com is Firebase's own home — brand lives in the subdomain of a platform host", () => {
    expect(wrongDoorName("Firebase", "firebase.google.com")).toBe(false)
  })

  it("martinterhaak.medium.com is a legitimate personal-blog author page on a platform host", () => {
    expect(wrongDoorName("martinterhaak", "martinterhaak.medium.com")).toBe(false)
  })
})

describe("wrongDoorName — the original true positive still fires", () => {
  it("SendGrid judged onto a reseller's subdomain is still withdrawn", () => {
    expect(wrongDoorName("SendGrid", "sendgrid.kke.co.jp")).toBe(true)
  })

  it("an equivalent reseller-subdomain shape on a non-platform host still fires", () => {
    // Same shape as tree-sitter.github.io (name == host's leftmost label,
    // unrelated registrable label) but the registrable domain is an
    // ordinary reseller's, not one of SUBDOMAIN_IDENTITY_HOSTS — so
    // subdomain-label awareness must NOT reach it.
    expect(wrongDoorName("Acme", "acme.somereseller.com")).toBe(true)
  })

  /**
   * MEASURED REGRESSION, caught and reverted before it shipped: an earlier
   * version of the vanity-suffix correction also stripped a leading prefix
   * from BOTH sides independently, and an adversarial review found by
   * execution that this forgives cases exactly this shape — two unrelated
   * brands whose vanity affixes happen to strip down to the same remainder.
   * These two pin the fix that stayed: the domain's own label is never
   * stripped, only the written name is, so two accidental affixes on
   * opposite sides can no longer manufacture a false match.
   */
  it("does not forgive two unrelated brands that collide only after stripping both sides' affixes", () => {
    // "try"+"hackme" / "hackme"+"hq" both reduce to "hackme" if the domain
    // side is stripped too — TryHackMe is not this reseller-shaped host.
    expect(wrongDoorName("TryHackMe", "tryhackme.hackmehq.com")).toBe(true)
  })

  it("does not forgive a second, differently-shaped affix collision", () => {
    expect(wrongDoorName("GetAround", "getaround.aroundhq.com")).toBe(true)
  })
})

describe("wrongDoorName — sanity cases", () => {
  it("an unrelated name on an unrelated host never fires", () => {
    expect(wrongDoorName("Stripe", "example.com")).toBe(false)
  })

  it("a name that IS the registrable domain's own brand never fires", () => {
    expect(wrongDoorName("Figma", "figma.com")).toBe(false)
    expect(wrongDoorName("figma", "www.figma.com")).toBe(false)
  })

  it("a name shorter than 3 characters never fires, however it overlaps the host", () => {
    expect(wrongDoorName("Io", "io.somehost.com")).toBe(false)
  })
})
