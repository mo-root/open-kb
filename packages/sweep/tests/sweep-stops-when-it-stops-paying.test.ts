import { describe, it, expect } from "vitest"
import { SERP, runFixture, type Harness } from "./fixture.js"

/**
 * THE FOUR WAYS A SWEEP STOPS SPENDING.
 *
 * The widening loop is the only part of the engine with no fixed budget. Every
 * other phase does a bounded amount of work per thing it was handed; this one
 * decides, in a loop, whether to buy more searches. Four separate rules can end
 * it, and each is there because the other three do not cover its case:
 *
 *   1. the model says the map is done                     (`verdict.enough`)
 *   2. the model wants more but proposes none             (empty draw AND empty queries)
 *   3. everything proposed was already asked, or banned   (nothing survives the filter)
 *   4. the round that just landed added almost nothing    (`MIN_NEW_HOSTS`)
 *
 * and above all four, `MAX_WAVES` bounds how many times the model is consulted
 * at all.
 *
 * Rules 2 and 3 look redundant and are not: rule 2 fires before the round costs
 * anything, rule 3 fires after the proposals have been through the dedupe and
 * the anchor ban, which is where a model that keeps re-proposing the same
 * query lands. Rule 4 is the only one that measures the WORLD rather than the
 * model, and it is the only backstop against a planner that will declare a gap
 * forever.
 *
 * Every test here counts ASSESS CALLS and QUERIES ON THE WIRE, because that is
 * what a broken stopping rule costs. On a live run one round is a model call
 * plus up to twenty queries times `pages` SERP requests, and a rule that quietly
 * stopped working would show up as a larger bill and nothing else.
 */

const assessCalls = (h: Harness) => h.calls.filter((c) => c.phase === "assess").length

/** The query a round proposes. Distinct per round, so nothing is dropped as a
 *  duplicate — rule 3 has its own test and must not fire inside the others. */
const widening = (round: number) => ({
  q: `widening question number ${round}`,
  intent: "pain",
  platform: "web",
  why: "aimed at the gap the last round named",
  market: "log search",
})

/** Hosts nobody has seen, none of them in the fetch table, so each settles by
 *  predicate for $0 and a big round still costs no model calls. */
const strangers = (round: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://w${round}-${i}.example/`,
    title: `stranger ${round}-${i}`,
    description: "a host this run had not seen",
  }))

/** The default table plus rows for the widening rounds. Copied, never mutated:
 *  the fixture's own table is shared by every suite in this package. */
const serpPlus = (extra: Record<string, ReturnType<typeof strangers>>) => ({ ...SERP, ...extra })

describe("rule 1 — the model says the map is done", () => {
  it("asks once, widens never, and fires exactly the opening hand", async () => {
    const h = await runFixture()
    expect(assessCalls(h)).toBe(1)
    // `report.queries` is everything fired and `report.opening` is the first
    // wave. Equal means nothing was added; on a live run they were measured 63
    // apart, which is the whole reason both numbers exist.
    expect(h.result.report.queries).toBe(14)
    expect(h.result.report.opening).toBe(14)
    expect(h.asked).toHaveLength(14)
  }, 30_000)
})

describe("rule 2 — the model wants more and proposes nothing", () => {
  it("stops without a round, even though `enough` was false, and says which rule stopped it", async () => {
    const h = await runFixture({
      script: { assess: () => ({ enough: false, missing: "the substitutes are thin", draw: [], queries: [] }) },
    })
    expect(assessCalls(h)).toBe(1)
    expect(h.asked).toHaveLength(14)
    expect(h.result.report.queries).toBe(h.result.report.opening)

    // WHY THIS TEST WATCHES THE NARRATION. Rule 3 would also stop this run —
    // an empty proposal survives the filter as an empty round — so seal state
    // and query count alone cannot tell the two rules apart, and a loop that
    // sealed on `enough` ALONE would pass every assertion above. The
    // difference reaches the operator as a sentence, and the two sentences
    // mean different things: "the model had nothing to add" is a finished map,
    // "every suggested query had already been asked" is a model going in
    // circles, which is a prompt problem. Reporting the second for the first
    // sends someone to debug a prompt that is behaving.
    expect(h.says.some((s) => s.startsWith("enough —") && s.includes("the substitutes are thin"))).toBe(true)
    expect(h.says.some((s) => s.includes("had already been asked"))).toBe(false)
  }, 30_000)
})

describe("rule 3 — everything proposed had already been asked, or named the anchor", () => {
  it("stops once the filter empties the round, having bought none of them", async () => {
    const h = await runFixture({
      script: {
        assess: () => ({
          enough: false,
          missing: "more of the same",
          draw: [],
          queries: [
            // Already fired in the opening hand.
            { q: "log search", intent: "pain", platform: "web", why: "again", market: "log search" },
            // The same query twice inside ONE round. `seen` grows as each
            // candidate is accepted, so this is caught by its own sibling and
            // not only by what earlier waves asked.
            { q: "log search", intent: "pain", platform: "web", why: "and again", market: "log search" },
            // Names a coinage. The opening batch's ban and the widening loop's
            // ban are one predicate in `@open-kb/core`; a coinage dropped at
            // the open must not get in through this door instead.
            { q: "Lumen retention tuning", intent: "pain", platform: "web", why: "no", market: "log search" },
          ],
        }),
      },
    })
    expect(assessCalls(h)).toBe(1)
    expect(h.asked).toHaveLength(14)
    expect(h.asked).not.toContain("Lumen retention tuning")
    expect(h.asked.filter((q) => q === "log search")).toHaveLength(1)
    // The other half of the sentence pair above: this run is the one that
    // earns "already been asked", and rule 2's run must not.
    expect(h.says.some((s) => s.includes("every suggested query had already been asked"))).toBe(true)
  }, 30_000)
})

describe("rule 4 — the round that landed added almost nothing", () => {
  it("stops the moment a round's yield falls under the floor, with the ceiling still far away", async () => {
    // Each round's query returns three hosts nobody had seen. Three is real
    // progress AND it is under the floor, which is the judgement being pinned:
    // more queries here would be buying corroboration, not coverage.
    //
    // It takes two rounds to get there, and the reason is worth writing down.
    // `before` is sampled when the planner WAKES, which on the first round is
    // before any of the opening wave's results have landed (the planner is
    // deliberately concurrent with the workers — "assessment overlaps searching
    // instead of interrupting it"). So round 1 measures its own three hosts
    // plus the whole opening wave's six and clears the floor easily. Round 2
    // is measured against a settled map and trips it. A live run has the same
    // shape at a larger scale: the floor cannot fire on round 1 there either.
    const h = await runFixture({
      serp: serpPlus({ [widening(1).q]: strangers(1, 3), [widening(2).q]: strangers(2, 3) }),
      script: {
        assess: (round) => ({ enough: false, missing: "nothing on the substitutes", draw: [], queries: [widening(round)] }),
      },
      // `concurrency` pinned, not inherited. Round 1 clears the floor by exactly
      // one host (9 against 8), and the margin is held by the DEFAULT search
      // concurrency of 20 — sweep.ts gates the first round's width on it. Drop
      // that default to 6 and this test goes red while the yield floor is working
      // perfectly, which reads as "the floor broke" and sends the next reader to
      // debug correct code. Depend on the number rather than inherit it.
      sweepOptions: { minNewHosts: 8, maxWaves: 4, concurrency: 20 },
    })
    // Two rounds against a ceiling of four: the loop took its answer from the
    // yield rather than from the model or from the ceiling. Remove the floor
    // and this run goes to four.
    expect(assessCalls(h)).toBe(2)
    expect(h.asked).toContain(widening(2).q)
    expect(h.asked).not.toContain(widening(3).q)
    expect(h.asked).toHaveLength(16)
    expect(h.result.report.opening).toBe(14)
    expect(h.result.report.queries).toBe(16)
  }, 30_000)

  it("keeps going while the yield clears the floor, and the ceiling is what finally stops it", async () => {
    // The same planner, except every round now lands nine strangers — over the
    // floor, so rule 4 never fires and `MAX_WAVES` is the only thing left
    // holding the loop. Without it this run does not finish: a planner that
    // says `enough: false` forever and keeps paying its way has no other exit.
    const rounds = 2
    const extra: Record<string, ReturnType<typeof strangers>> = {}
    for (let r = 1; r <= rounds + 2; r++) extra[widening(r).q] = strangers(r, 9)
    const h = await runFixture({
      serp: serpPlus(extra),
      script: { assess: (round) => ({ enough: false, missing: "still thin", draw: [], queries: [widening(round)] }) },
      sweepOptions: { minNewHosts: 8, maxWaves: rounds, concurrency: 20 },
    })
    expect(assessCalls(h)).toBe(rounds)
    expect(h.asked).toHaveLength(14 + rounds)
    expect(h.asked).toContain(widening(rounds).q)
    // The round the ceiling refused. Its row exists in the table, so the only
    // reason it is absent is that the loop stopped.
    expect(h.asked).not.toContain(widening(rounds + 1).q)
  }, 30_000)
})

describe("the reserve is what a widening round reaches for first", () => {
  it("draws held templates before fresh invention, and each keeps its own family", async () => {
    const h = await runFixture({
      script: {
        assess: () => ({
          enough: false,
          missing: "the roundups",
          draw: [{ product: "Log Search Cloud", n: 2 }],
          queries: [
            { q: "audit trail for who read which log line", intent: "pain", platform: "web", why: "gap", market: "log search" },
          ],
        }),
      },
      sweepOptions: { maxWaves: 1 },
    })
    // The two templates `openingHand` held back for this product, in the order
    // it held them, ahead of the invented one. A round that ignored the reserve
    // and re-invented instead would produce neither of these strings.
    expect(h.asked.slice(14)).toEqual([
      "best log search",
      "log search vs",
      "audit trail for who read which log line",
    ])
    // A released template keeps the family it was written as; only the
    // free-form invention is debranded. Get this wrong and the family ledger —
    // the table the next widening round reads to decide what is paying —
    // describes a run that did not happen.
    expect(h.result.report.families).toEqual({ plain: 8, branded: 4, debranded: 5 })
  }, 30_000)
})

describe("the assess call is told how saturated the last round was", () => {
  it("carries the ratio of already-seen rows into the prompt, and says so before round one", async () => {
    // Two rounds forced: the first assess proposes a query, the second says
    // enough. The second call's prompt must carry the first round's yield as
    // a saturation sentence — the owner's ask: when most of what comes back
    // is ground already held, the model should be told, not left to infer it
    // from a host count.
    const h = await runFixture({
      script: {
        assess: (round) =>
          round === 1
            ? { enough: false, missing: "widen once", draw: [], queries: [widening(round)] }
            : { enough: true, missing: "", draw: [], queries: [] },
      },
      serp: {
        ...SERP,
        // The widening query lands rows, some already on the map and one not,
        // so the saturation ratio has something real to say.
        "widening question number 1": [
          { url: "https://grepstack.example/", title: "Grepstack", description: "Hosted log search." },
          { url: "https://freshhost.example/", title: "Fresh", description: "A host no earlier query saw." },
        ],
      },
      sweepOptions: { minNewHosts: 1 },
    })
    const assesses = h.calls.filter((c) => c.phase === "assess")
    expect(assesses.length).toBeGreaterThanOrEqual(2)
    expect(assesses[0]!.prompt).toContain("(no widening round has fired yet)")
    expect(assesses[1]!.prompt).toMatch(/\d+% of the last round's \d+ results were hosts already on the map/)
  })
})
