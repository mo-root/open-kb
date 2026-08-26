import { describe, it, expect } from "vitest"
import { Ledger, ALLOWANCES, HARVEST_BASE_USD, HARVEST_PER_HOST_USD, HARVEST_HOST_CAP } from "../src/ledger.js"

describe("ALLOWANCES", () => {
  it("prices the four cost words", () => {
    expect(ALLOWANCES.peek).toBeCloseTo(0.03)
    expect(ALLOWANCES.read).toBeCloseTo(0.1)
    expect(ALLOWANCES.dig).toBeCloseTo(0.25)
    expect(ALLOWANCES.harvest).toBeCloseTo(0.45)
  })

  it("derives harvest from its per-host pieces, never a flat guess", () => {
    // base + perHost × cap: the one tier whose work is counted in hosts. The
    // pieces are exported so the tool's cap and the price cannot drift apart.
    expect(ALLOWANCES.harvest).toBeCloseTo(HARVEST_BASE_USD + HARVEST_PER_HOST_USD * HARVEST_HOST_CAP)
    expect(HARVEST_HOST_CAP).toBe(40)
  })
})

describe("Ledger construction: the finish reserve is carved at t=0", () => {
  it("takes 10% when that beats the floor: $1.50 -> $0.15 reserved, $1.35 spendable", () => {
    const l = new Ledger(1.5)
    expect(l.finishReserveUsd).toBeCloseTo(0.15)
    expect(l.spendable()).toBeCloseTo(1.35)
  })

  it("takes the $0.12 floor on a small ceiling: $0.50 -> $0.12 reserved, $0.38 spendable", () => {
    const l = new Ledger(0.5)
    expect(l.finishReserveUsd).toBeCloseTo(0.12)
    expect(l.spendable()).toBeCloseTo(0.38)
  })

  it("a ceiling below the floor leaves nothing spendable, not a crash", () => {
    const l = new Ledger(0.1)
    expect(l.spendable()).toBeLessThan(0)
  })
})

describe("Ledger reserve and settle", () => {
  it("reserves a fitting amount and holds it out of spendable", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.25)
    expect(r.ok).toBe(true)
    expect(l.spendable()).toBeCloseTo(1.1)
  })

  it("never throws on an unaffordable reservation: it answers with a sentence", () => {
    const l = new Ledger(0.2) // reserve floor $0.12 leaves $0.08
    const r = l.reserve(0.1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("a $0.10 reservation does not fit; $0.08 is spendable after the finish reserve")
    expect(l.spendable()).toBeCloseTo(0.08)
  })

  it("settling returns the surplus to the pool immediately", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.25)
    if (!r.ok) throw new Error("reserve should fit")
    const s = l.settle(r.claimId, 0.161)
    expect(s.ok).toBe(true)
    if (s.ok) expect(s.surplusUsd).toBeCloseTo(0.089)
    expect(l.spendable()).toBeCloseTo(1.35 - 0.161)
  })

  it("an overrun settle charges the real number: the pool takes the hit", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.25)
    if (!r.ok) throw new Error("reserve should fit")
    const s = l.settle(r.claimId, 0.3)
    expect(s.ok).toBe(true)
    if (s.ok) expect(s.surplusUsd).toBeCloseTo(-0.05)
    expect(l.spendable()).toBeCloseTo(1.35 - 0.3)
  })

  it("outstanding claims stack: three reservations all count against spendable", () => {
    const l = new Ledger(1.5)
    l.reserve(0.25)
    l.reserve(0.1)
    l.reserve(0.03)
    expect(l.spendable()).toBeCloseTo(1.35 - 0.38)
  })

  it("an early-finishing mission funds the next one: settle, then a bigger reserve fits", () => {
    const l = new Ledger(0.5) // $0.38 spendable
    const a = l.reserve(0.25)
    l.reserve(0.1)
    expect(l.reserve(0.25).ok).toBe(false) // only $0.03 left
    if (!a.ok) throw new Error("reserve should fit")
    l.settle(a.claimId, 0.02) // surplus back within milliseconds
    expect(l.reserve(0.25).ok).toBe(true)
  })

  it("refuses to settle an unknown claim, with a sentence", () => {
    const l = new Ledger(1.5)
    const s = l.settle("c9", 0.1)
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toContain("c9")
  })

  it("refuses to settle the same claim twice, and says settled rather than never-reserved", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.settle(r.claimId, 0.05)
    const s = l.settle(r.claimId, 0.05)
    expect(s.ok).toBe(false)
    // The two refusal branches share one shape ("nothing to settle") and read
    // alike unless the clause naming WHY is checked: an unknown claim id was
    // never reserved, a re-settled one already was. Both compile and both pass
    // a bare `.ok === false` check even if `#settled.has` were swapped for
    // `#claims.has` or the ternary's branches were flipped — only the exact
    // wording catches that, and nothing in this file asserted it before.
    if (!s.ok) expect(s.reason).toContain("was already settled")
  })
})

describe("Ledger affordTurn: the lead is metered like everything else", () => {
  it("answers from the transcript's exact token count and both prices", () => {
    const l = new Ledger(1.5)
    // 160k in at $0.50/MTok + 2k out at $3.00/MTok = $0.086
    expect(l.affordTurn(160_000, 0.5, 2_000, 3.0)).toBe(true)
  })

  it("refuses a turn the pool no longer funds", () => {
    const l = new Ledger(1.5)
    l.reserve(1.3) // $0.05 left
    expect(l.affordTurn(160_000, 0.5, 2_000, 3.0)).toBe(false)
  })

  it("a quadratic transcript prices itself out: the same prices, ten times the tokens", () => {
    const l = new Ledger(0.5) // $0.38 spendable
    expect(l.affordTurn(160_000, 0.5, 2_000, 3.0)).toBe(true)
    expect(l.affordTurn(1_600_000, 0.5, 20_000, 3.0)).toBe(false) // $0.86
  })
})

describe("Ledger draw and warnAt: the 80% in-band warning", () => {
  it("stays quiet below 80% of the allowance", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.draw(r.claimId, 0.07)
    expect(l.warnAt(r.claimId)).toBe(false)
  })

  it("answers true once 80% is consumed — the caller owns the message", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.draw(r.claimId, 0.07)
    l.draw(r.claimId, 0.01) // cumulative 0.08 = 80%
    expect(l.warnAt(r.claimId)).toBe(true)
  })

  it("draw reports what remains of the allowance, honestly negative on overrun", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    const d1 = l.draw(r.claimId, 0.09)
    expect(d1.ok).toBe(true)
    if (d1.ok) expect(d1.remainingUsd).toBeCloseTo(0.01)
    const d2 = l.draw(r.claimId, 0.03)
    if (d2.ok) expect(d2.remainingUsd).toBeCloseTo(-0.02)
  })

  it("drawing within a claim does not touch spendable: the allowance was already held", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.draw(r.claimId, 0.09)
    expect(l.spendable()).toBeCloseTo(1.25)
  })

  it("refuses to draw against an unknown or settled claim, each with its own reason", () => {
    const l = new Ledger(1.5)
    const unknown = l.draw("c9", 0.01)
    expect(unknown.ok).toBe(false)
    // draw's own ternary spells the settled case "is settled" — a different
    // word from settle()'s "was already settled" for the same fact — so this
    // checks draw's actual wording rather than reusing settle's.
    if (!unknown.ok) expect(unknown.reason).toContain("was never reserved")
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.settle(r.claimId, 0.05)
    const settled = l.draw(r.claimId, 0.01)
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.reason).toContain("is settled")
  })

  it("warnAt answers false for an unknown or settled claim: no claim, no warning", () => {
    const l = new Ledger(1.5)
    expect(l.warnAt("c9")).toBe(false)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.draw(r.claimId, 0.09)
    l.settle(r.claimId, 0.09)
    expect(l.warnAt(r.claimId)).toBe(false)
  })
})

describe("Ledger overrunAbort: 1.5x the claim aborts at the next tool boundary", () => {
  it("stays quiet under 1.5x", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    expect(l.overrunAbort(r.claimId, 0.14)).toBe(false)
  })

  it("fires at 1.5x the allowance", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    expect(l.overrunAbort(r.claimId, 0.15)).toBe(true)
    expect(l.overrunAbort(r.claimId, 0.2)).toBe(true)
  })

  it("answers from the caller's number, not the drawn total: the harness holds the authoritative figure", () => {
    const l = new Ledger(1.5)
    const r = l.reserve(0.1)
    if (!r.ok) throw new Error("reserve should fit")
    l.draw(r.claimId, 0.01) // sub-ledger far behind
    expect(l.overrunAbort(r.claimId, 0.16)).toBe(true)
  })

  it("answers false for an unknown claim", () => {
    const l = new Ledger(1.5)
    expect(l.overrunAbort("c9", 99)).toBe(false)
  })
})
