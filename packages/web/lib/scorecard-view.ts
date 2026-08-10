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

/** Why an armed gate let a finish stand, in the reader's words. Keys are the
 *  swarm's `GateStood`; an unknown or empty one is a run stored before the
 *  gate recorded it, and gets no sentence rather than a guessed one. */
const STOOD_BLURB: Record<string, string> = {
  clean: "nothing was standing to object to",
  work: "the lead paid — a page it fetched, or a mission it commissioned coming home",
  disarmed: "the harness had already told the lead to close",
  "turn-cap": "a refusal's answer would have collided with the turn cap",
  "budget-floor": "the pool was already under the price the run closes at",
  "refusals-spent": "the refusal ceiling was reached and the finish stood unpaid",
}

/**
 * One sentence saying what the refusals cost and what ended the exchange —
 * null when the record does not support one.
 *
 * The two cases it exists for are the ones the objection list alone reads
 * wrong. A gate that refused and got nothing looks, from the sentences, exactly
 * like a gate that refused and got a page. And a gate that had objections but
 * declined to spend one — because the pool was already under the floor, or the
 * turn cap was one away — is not the same event as a clean pass, though
 * `refusals: 0` renders identically.
 */
export function gateAnswer(gate: ScorecardGateView): string | null {
  const why = STOOD_BLURB[gate.stood]
  if (gate.refusals === 0) {
    // A clean pass needs no footnote. A hatch does.
    return why && gate.stood !== "clean" && gate.objections.length > 0 ? `it did not refuse: ${why}` : null
  }
  const times = gate.refusals === 1 ? "once" : gate.refusals === 2 ? "twice" : `${gate.refusals} times`
  const n = gate.workAnswered
  const followed =
    n === 0 ? "no page and no landing followed" : n === 1 ? "one page or landing followed" : `${n} pages or landings followed`
  return why ? `refused ${times}; ${followed}${receipt(gate)} — ${why}` : `refused ${times}; ${followed}${receipt(gate)}`
}

/**
 * The receipt behind "one page or landing followed", in parentheses.
 *
 * `stood: "work"` is true of a lead that opened the one page its market turned
 * on and equally true of a lead that fetched an unrelated blog and ended with
 * an empty map. The count cannot tell them apart and neither can the objection
 * list; the URL can. Naming the FIRST item and counting the rest keeps the
 * line one sentence long — the full list is in the record.
 *
 * Empty on runs stored before the gate kept it, where the parentheses would
 * otherwise sit there with nothing in them.
 */
function receipt(gate: ScorecardGateView): string {
  const [first, ...rest] = gate.answeredBy
  if (first === undefined) return ""
  return rest.length === 0 ? ` (${first})` : ` (${first}, +${rest.length} more)`
}
