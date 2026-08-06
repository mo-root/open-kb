import { describe, it, expect } from "vitest"
import { gateExchange, nOfM, share, usdOfUsd } from "./scorecard-view"
import type { ScorecardGateView } from "./viewTypes"

/**
 * The Coverage card's display logic, kept pure so it is testable without a
 * DOM. The rule the card lives by: every fraction shows its own arithmetic
 * ("n of m" beside the value, T6's honesty rule), and the gate's exchange is
 * shown in the gate's own sentences — verbatim, because they were written to
 * be read — whenever the gate actually refused.
 */

const gate = (over: Partial<ScorecardGateView>): ScorecardGateView => ({
  refusals: 0,
  objections: [],
  carriedObjections: [],
  refusedFinish: null,
  ...over,
})

describe("fraction display", () => {
  it("shows the arithmetic as n of m", () => {
    expect(nOfM({ num: 2, den: 3, value: 0.6666666666666666 })).toBe("2 of 3")
    expect(nOfM({ num: 12, den: 12, value: 1 })).toBe("12 of 12")
  })

  it("shows a money fraction in dollars, two places", () => {
    expect(usdOfUsd({ num: 3.1303555, den: 5, value: 0.6260711 })).toBe("$3.13 of $5.00")
  })

  it("shows the value to two places, and dashes a den-0 fraction instead of claiming 0", () => {
    expect(share({ num: 2, den: 3, value: 0.6666666666666666 })).toBe("0.67")
    expect(share({ num: 12, den: 12, value: 1 })).toBe("1.00")
    // core's fraction(): den 0 => value null, "never NaN". A dash is the only
    // honest render — 0.00 would claim a measurement that was never made.
    expect(share({ num: 0, den: 0, value: null })).toBe("—")
  })
})

describe("the gate's exchange", () => {
  it("stays silent when the gate never refused", () => {
    const x = gateExchange(gate({ objections: ["the pool holds $3.55 of $5.00"] }))
    expect(x.spoke).toBe(false)
  })

  it("speaks the objection sentences verbatim once a refusal happened", () => {
    const a = "2 of 3 planned families have zero page-tier nodes (competitors_x, integrations_y)"
    const b = "the pool holds $3.55 of $5.00"
    const x = gateExchange(gate({ refusals: 1, objections: [a, b] }))
    expect(x.spoke).toBe(true)
    expect(x.lines.map((l) => l.text)).toEqual([a, b])
  })

  it("marks an objection the accepted finish still omitted as carried", () => {
    const a = "2 of 3 planned families have zero page-tier nodes"
    const b = "the pool holds $3.55 of $5.00"
    const x = gateExchange(gate({ refusals: 1, objections: [a, b], carriedObjections: [b] }))
    expect(x.lines).toEqual([
      { text: a, carried: false },
      { text: b, carried: true },
    ])
  })

  it("appends a carried sentence the refusal never spoke, rather than losing it", () => {
    const a = "12 of 12 nodes rest on a single source"
    const x = gateExchange(gate({ refusals: 1, objections: [], carriedObjections: [a] }))
    expect(x.lines).toEqual([{ text: a, carried: true }])
  })
})
