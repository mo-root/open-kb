import type { ScoreFraction, ScorecardGateView } from "./viewTypes"

/**
 * The Coverage card's display logic, pure and DOM-free.
 *
 * Two rules live here so the card cannot drift away from them:
 *
 * 1. Every fraction shows its own arithmetic. T6 serialized num/den beside
 *    the value "so a reader recomputes value from num/den instead of trusting
 *    a percentage" — the card renders the same honesty: "2 of 3 · 0.67",
 *    never a bare percent.
 *
 * 2. The gate's exchange is shown in the gate's own sentences, verbatim.
 *    `scorecardObjections` writes fact-sentences, never verdicts; a card that
 *    paraphrased them would be the harness editorializing over its own
 *    instrument.
 *
 * Client-safe on purpose (no lib/runs.ts import): KbOverview is a
 * `"use client"` component, same constraint that put RELATION_BLURB in
 * lib/viewTypes.ts.
 */

/** "2 of 3" — the arithmetic, for count fractions. */
export function nOfM(f: ScoreFraction): string {
  return `${f.num} of ${f.den}`
}

/** "$3.13 of $5.00" — the arithmetic, for money fractions (poolUnspent). */
export function usdOfUsd(f: ScoreFraction): string {
  return `$${f.num.toFixed(2)} of $${f.den.toFixed(2)}`
}

/** The value to two places — or a dash when `den` was 0 and the fraction
 *  measured nothing. "0.00" there would claim a measurement that was never
 *  made, which is the exact overstatement core's den-0 rule exists to block. */
export function share(f: ScoreFraction): string {
  return f.value === null ? "—" : f.value.toFixed(2)
}

export interface GateLine {
  /** One objection sentence, byte-identical to the record. */
  text: string
  /** True when the accepted finish's unresolved[] still omitted it. */
  carried: boolean
}

/**
 * The gate's exchange, as the card shows it. `spoke` is "the gate actually
 * refused a finish" — with refusals 0 the record's `objections` are merely
 * the sentences standing at an accepted finish, and rendering those as an
 * exchange would dramatize a conversation that never happened.
 *
 * Lines are the refusal's objections in delivery order, each marked carried
 * when it was still standing at the end; a carried sentence the refusal never
 * spoke (raised only later) is appended rather than lost.
 */
export function gateExchange(gate: ScorecardGateView): { spoke: boolean; lines: GateLine[] } {
  const spoke = gate.refusals > 0
  if (!spoke) return { spoke, lines: [] }
  const carried = new Set(gate.carriedObjections)
  const lines: GateLine[] = gate.objections.map((text) => ({ text, carried: carried.has(text) }))
  for (const text of gate.carriedObjections) {
    if (!gate.objections.includes(text)) lines.push({ text, carried: true })
  }
  return { spoke, lines }
}
