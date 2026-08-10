import { describe, it, expect } from "vitest"
import { gateAnswer, gateExchange, nOfM, share, usdOfUsd } from "./scorecard-view"
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
  workAtRefusal: null,
  workAnswered: 0,
  answeredBy: [],
  stood: "",
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

describe("what the refusals bought", () => {
  it("says a refusal that got nothing, and what ended the exchange", () => {
    expect(gateAnswer(gate({ refusals: 2, workAnswered: 0, stood: "refusals-spent" }))).toBe(
      "refused twice; no page and no landing followed — the refusal ceiling was reached and the finish stood unpaid",
    )
  })

  it("says a refusal that was paid — the same sentences, a different outcome", () => {
    // Identical objection lists; only this line separates the lead that worked
    // from the lead that restated.
    expect(gateAnswer(gate({ refusals: 1, workAnswered: 1, stood: "work" }))).toBe(
      "refused once; one page or landing followed — the lead paid — a page it fetched, or a mission it commissioned coming home",
    )
  })

  it("names WHAT it was paid with, so `stood: work` can be argued with", () => {
    // The complaint this answers: a lead can end `{workAnswered: 1, stood:
    // "work", nodes: 0}` by fetching one unrelated blog. The count cannot show
    // that; the url can, and the reader judges it.
    expect(
      gateAnswer(gate({ refusals: 1, workAnswered: 1, stood: "work", answeredBy: ["page:https://a-blog.example/"] })),
    ).toBe(
      "refused once; one page or landing followed (page:https://a-blog.example/) — the lead paid — a page it fetched, or a mission it commissioned coming home",
    )
    expect(
      gateAnswer(
        gate({
          refusals: 1,
          workAnswered: 3,
          stood: "work",
          answeredBy: ["mission:family:market", "page:https://rival.com/", "mission:mine"],
        }),
      ),
    ).toContain("3 pages or landings followed (mission:family:market, +2 more)")
  })

  it("a run stored before the receipt existed prints no empty parentheses", () => {
    expect(gateAnswer(gate({ refusals: 1, workAnswered: 1, stood: "work", answeredBy: [] }))).toBe(
      "refused once; one page or landing followed — the lead paid — a page it fetched, or a mission it commissioned coming home",
    )
  })

  it("names a hatch: objections stood and the gate declined to spend a refusal", () => {
    const objections = ["the pool holds $0.02 of $5.00"]
    expect(gateAnswer(gate({ refusals: 0, objections, stood: "budget-floor" }))).toBe(
      "it did not refuse: the pool was already under the price the run closes at",
    )
  })

  it("stays quiet on a clean pass and on a run stored before the gate recorded any of this", () => {
    expect(gateAnswer(gate({ refusals: 0, objections: [], stood: "clean" }))).toBeNull()
    expect(gateAnswer(gate({ refusals: 0, objections: ["something stood"], stood: "" }))).toBeNull()
  })
})
