import { describe, it, expect } from "vitest"
import { runFixture, type Harness } from "./fixture.js"

/**
 * AN OPINION ABOUT WHETHER TO BUY MORE MUST NOT BE ABLE TO END THE RUN.
 *
 * `call()` retries an empty or unparseable answer once and then throws. The
 * widening planner runs inside the same `Promise.all` as the search workers,
 * so before this test an assess call that failed twice rejected the whole
 * search phase and `sweep()` with it — measured on the cursor.com run of
 * 2026-08-23, which died at 796s with 618 hosts bought and $0.41 spent, on
 * "No object generated: could not parse the response" from its sixth assess
 * call. Everything paid for was discarded over a question whose worst honest
 * answer is "stop widening".
 *
 * The fixture's model produces the same failure class the live run hit: an
 * answer that does not fit the schema makes `generateObject` throw
 * AI_NoObjectGeneratedError, exactly as an unparseable body does.
 */

const assessCalls = (h: Harness) => h.calls.filter((c) => c.phase === "assess").length

describe("the assess call failing twice", () => {
  it("seals the widening loop, says so, and still judges what the opening hand bought", async () => {
    const h = await runFixture({
      // Off-schema on every ask: no `enough`, no `missing`, no `draw`, no
      // `queries`. The first failure is retried with more room and fails the
      // same way; the second surfaces to the planner.
      script: { assess: () => ({ nonsense: true }) },
    })

    // The call and its one retry — `call()`'s own contract — and not a third.
    expect(assessCalls(h)).toBe(2)

    // Nothing was widened: every query on the wire is the opening hand.
    expect(h.result.report.queries).toBe(h.result.report.opening)

    // The operator was told which rule ended the widening, and why.
    expect(h.says.some((s) => /assess failed twice/.test(s))).toBe(true)
    expect(h.says.some((s) => /not widening further/.test(s))).toBe(true)

    // And the run went on to judge and write the map it had already paid
    // for, rather than throwing it away — the whole point.
    expect(h.result.entities.length).toBeGreaterThan(0)
    expect(h.result.report.kept).toBeGreaterThan(0)
  }, 30_000)
})

/**
 * THE RETRY KNOWS WHY THE FIRST ANSWER WAS REFUSED.
 *
 * "No object generated: response did not match schema" was the whole of what
 * a schema miss left behind — not which field, not what the model sent. The
 * AI SDK keeps the zod issues on the error; `call()` now puts the first of
 * them in the narration, in the span, and in the retry's own prompt, because
 * a model that strayed from an enum under a long prompt strays the same way
 * when asked the identical question again.
 */
describe("a schema miss is named, and the retry is told about it", () => {
  it("narrates the field, hints the retry, and records it on the failed span", async () => {
    const h = await runFixture({
      // Everything the schema wants, plus an `intent` it does not allow —
      // the measured shape of the live failure (enum strays), not a blank.
      script: {
        assess: () => ({
          enough: false,
          missing: "",
          draw: [],
          queries: [{ q: "x", intent: "buy", platform: "web", why: "w", market: "log search" }],
        }),
      },
    })
    // The narration names the field the answer missed.
    expect(h.says.some((s) => /assess: the model's answer was refused \(queries\.0\.intent:/.test(s))).toBe(true)
    // The retry's prompt carries that same issue — it is a different ask.
    const [first, retry] = h.calls.filter((c) => c.phase === "assess")
    expect(first!.prompt).not.toMatch(/Your previous answer was rejected/)
    expect(retry!.prompt).toMatch(/Your previous answer was rejected: queries\.0\.intent:/)
    // And the span that records the failure carries the issue, not just the sentence.
    const failed = h.spans.find((sp) => sp.kind === "model" && sp.agentId === "plan" && sp.ok === false)
    expect(failed?.error).toMatch(/queries\.0\.intent/)
    // Still fail-open: the run judged what it had.
    expect(h.result.entities.length).toBeGreaterThan(0)
  }, 30_000)
})
