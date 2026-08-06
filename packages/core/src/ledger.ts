import type { MissionTier } from "./board.js"

/**
 * One pool. Reserved before work. Sized per item. Reported on every return.
 *
 * The ledger owns the arithmetic and only the arithmetic: what fits, what is
 * left, when a warning threshold is crossed. Every editorial act — the "$X left,
 * write down what you have" message, the skip narration, the closing turn —
 * belongs to the caller. The ledger just answers.
 */

/**
 * Tier allowances in dollars. Caps, not estimates: reserving generously and
 * settling fast is strictly better than reserving tightly, because an
 * over-reservation costs milliseconds and an under-reservation costs a killed
 * mission. Measured typical actuals sit well under each cap: peek ~$0.008,
 * read ~$0.070, dig ~$0.161.
 */
export const ALLOWANCES: Record<MissionTier, number> = { peek: 0.03, read: 0.1, dig: 0.25 }

/** Fraction of an allowance consumed before `warnAt` answers true. */
const WARN_FRACTION = 0.8

/** Multiple of an allowance past which `overrunAbort` answers true. */
const ABORT_MULTIPLE = 1.5

/**
 * Slack for float comparisons at the thresholds. Cents-level precision is the
 * contract; without this, `0.07 + 0.01 >= 0.8 * 0.1` is at the mercy of
 * rounding in the last bit.
 */
const EPSILON = 1e-9

export type ReserveOutcome = { ok: true; claimId: string } | { ok: false; reason: string }
export type SettleOutcome = { ok: true; surplusUsd: number } | { ok: false; reason: string }
export type DrawOutcome = { ok: true; remainingUsd: number } | { ok: false; reason: string }

interface Claim {
  reservedUsd: number
  drawnUsd: number
}

const usd = (n: number) => `$${n.toFixed(2)}`

export class Ledger {
  readonly ceilingUsd: number
  /**
   * Carved at construction: max($0.12, 10% of the ceiling). It buys
   * corroboration missions when the pool hits its floor — never prose — so a
   * run cannot end with a map full of single-sourced nodes and no money to
   * check them.
   */
  readonly finishReserveUsd: number

  #spentUsd = 0
  #claims = new Map<string, Claim>()
  #settled = new Set<string>()
  #n = 0

  constructor(ceilingUsd: number) {
    this.ceilingUsd = ceilingUsd
    this.finishReserveUsd = Math.max(0.12, 0.1 * ceilingUsd)
  }

  /** The whole ceiling minus the carved reserve — what work may ever touch. */
  get workPoolUsd(): number {
    return this.ceilingUsd - this.finishReserveUsd
  }

  #outstandingUsd(): number {
    let sum = 0
    for (const c of this.#claims.values()) sum += c.reservedUsd
    return sum
  }

  /** pool - spent - outstanding claims - finish reserve. May go negative after an overrun; that is the honest number. */
  spendable(): number {
    return this.ceilingUsd - this.finishReserveUsd - this.#spentUsd - this.#outstandingUsd()
  }

  spentUsd(): number {
    return this.#spentUsd
  }

  /**
   * Hold `usdAmount` out of the pool before any work happens. Never throws: an
   * unaffordable reservation is answered with a sentence the caller can put in
   * front of a model ("re-tier it or drop it" is the caller's line to add).
   */
  reserve(usdAmount: number): ReserveOutcome {
    const left = this.spendable()
    if (usdAmount > left + EPSILON) {
      return {
        ok: false,
        reason: `a ${usd(usdAmount)} reservation does not fit; ${usd(left)} is spendable after the finish reserve`,
      }
    }
    const claimId = `c${++this.#n}`
    this.#claims.set(claimId, { reservedUsd: usdAmount, drawnUsd: 0 })
    return { ok: true, claimId }
  }

  /**
   * Close a claim at its real cost. The surplus returns to the pool in the same
   * call — this is what lets an early-finishing mission fund the next one. An
   * overrun settles at the real number too; the pool takes the hit, because the
   * money is already gone and pretending otherwise would corrupt `spendable`.
   */
  settle(claimId: string, actualUsd: number): SettleOutcome {
    const claim = this.#claims.get(claimId)
    if (!claim) {
      const why = this.#settled.has(claimId) ? "was already settled" : "was never reserved"
      return { ok: false, reason: `claim ${claimId} ${why}; nothing to settle` }
    }
    this.#claims.delete(claimId)
    this.#settled.add(claimId)
    this.#spentUsd += actualUsd
    return { ok: true, surplusUsd: claim.reservedUsd - actualUsd }
  }

  /**
   * Record consumption against a claim's sub-ledger as paid tool returns land.
   * This is what makes `warnAt` answerable. Does not touch `spendable`: the
   * full allowance was already held at reserve time. `remainingUsd` goes
   * honestly negative on overrun.
   */
  draw(claimId: string, usdAmount: number): DrawOutcome {
    const claim = this.#claims.get(claimId)
    if (!claim) {
      const why = this.#settled.has(claimId) ? "is settled" : "was never reserved"
      return { ok: false, reason: `claim ${claimId} ${why}; nothing to draw against` }
    }
    claim.drawnUsd += usdAmount
    return { ok: true, remainingUsd: claim.reservedUsd - claim.drawnUsd }
  }

  /**
   * True once 80% of the claim's allowance is drawn. The in-band "$X left —
   * write down what you have" trigger belongs to the caller; the ledger just
   * answers, as often as asked. Unknown or settled claims answer false: no
   * claim, no warning.
   */
  warnAt(claimId: string): boolean {
    const claim = this.#claims.get(claimId)
    if (!claim) return false
    return claim.drawnUsd >= WARN_FRACTION * claim.reservedUsd - EPSILON
  }

  /**
   * True once real spend reaches 1.5x the claim. Takes the caller's figure
   * rather than the drawn total because the harness at a tool boundary holds
   * the authoritative number, and an abort decision should never trust the
   * lagging copy. Everything already written stands; aborting is the caller's
   * act. Advisory at the boundary, by construction: the caller can only hand
   * over spend it has already paid, so this stops the NEXT call, never the
   * increment that crossed — measured 2026-08-05, one read mission closed at
   * 1.9x its allowance ($0.189 on $0.10) because the boundary before its
   * final turn read $0.145 and that turn alone cost $0.045.
   */
  overrunAbort(claimId: string, spentSoFarUsd: number): boolean {
    const claim = this.#claims.get(claimId)
    if (!claim) return false
    return spentSoFarUsd >= ABORT_MULTIPLE * claim.reservedUsd - EPSILON
  }

  /**
   * Can the lead's next turn be paid for? Priced from the transcript's exact
   * token count and the caller's prices per million tokens — the one agent
   * whose spend is a fifth of the run is not exempt from the ledger.
   */
  affordTurn(
    transcriptTokens: number,
    pricePerMTokIn: number,
    estOutTokens: number,
    pricePerMTokOut: number,
  ): boolean {
    const costUsd = (transcriptTokens * pricePerMTokIn + estOutTokens * pricePerMTokOut) / 1_000_000
    return costUsd <= this.spendable() + EPSILON
  }
}
