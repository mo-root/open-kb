import { describe, it, expect } from "vitest"
import { CALL_TIMEOUT_MS, LINK_CALL_TIMEOUT_MS } from "../src/sweep.js"

/**
 * A model call that never answers used to be a run that never ends.
 *
 * `abortSignal: signal` in `call()` was the run's own AbortController — it
 * fires when a visitor leaves or the host's clock runs out, and it is not a
 * timeout. Measured: a figma.com sweep sat in the link phase for 13 minutes at
 * 0.1% CPU on one unanswered call, 451 of 491 pairs done, and would have sat
 * there indefinitely. Bright Data's search and fetch have carried
 * `AbortSignal.timeout` all along.
 *
 * These test the composition rather than the network: that a deadline exists,
 * that it is fresh per call, and that it does not swallow the run's own cancel.
 */
describe("every model call carries a deadline", () => {
  it("has one, and it clears the slowest measured real call", () => {
    // The slowest legitimate calls in runs/ are classify retries at 56-62s.
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(62_000)
    expect(CALL_TIMEOUT_MS).toBeLessThanOrEqual(600_000)
  })

  it("gives link a shorter deadline than every other agent, within the backlog's 45-60s range", () => {
    // P0-4: link and orphan calls are batched, uniform, and already retried
    // once, so a hang there does not need the full CALL_TIMEOUT_MS runway.
    expect(LINK_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000)
    expect(LINK_CALL_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
    expect(LINK_CALL_TIMEOUT_MS).toBeLessThan(CALL_TIMEOUT_MS)
  })

  it("composes with the run's cancel without replacing it", async () => {
    // What `withDeadline()` builds. Either source must be able to abort the
    // call, and the run's own signal must stay distinguishable afterwards so a
    // host that stopped answering does not get reported as a visitor leaving.
    const run = new AbortController()
    const composed = AbortSignal.any([run.signal, AbortSignal.timeout(60_000)])
    run.abort()
    expect(composed.aborted).toBe(true)
    expect(run.signal.aborted).toBe(true)
  })

  it("fires on time when the run is not cancelled, leaving the run's signal clear", async () => {
    const run = new AbortController()
    const composed = AbortSignal.any([run.signal, AbortSignal.timeout(20)])
    await new Promise((r) => setTimeout(r, 60))
    expect(composed.aborted).toBe(true)
    // The distinction the caller relies on to tell a timeout from a cancel.
    expect(run.signal.aborted).toBe(false)
  })

  it("is fresh per call — a shared timeout would abort every later call", async () => {
    // One `AbortSignal.timeout` created once starts counting at creation, so
    // by call 200 of a run it is long expired. `withDeadline()` is a function
    // for exactly this reason.
    const shared = AbortSignal.timeout(20)
    await new Promise((r) => setTimeout(r, 60))
    expect(shared.aborted).toBe(true)
    const fresh = AbortSignal.timeout(20)
    expect(fresh.aborted).toBe(false)
  })
})

describe("a stopped call does not take the run with it", () => {
  it("names a timeout apart from a cancel, which is what decides whether to retry", () => {
    // `call()` retries a timed-out call once and must never retry a cancelled
    // one — a visitor who closed the tab is not waiting for a second attempt.
    // The distinction is that a deadline leaves the RUN's signal clear.
    const run = new AbortController()
    const timedOut = (err: Error, aborted: boolean) =>
      !aborted &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /aborted due to timeout/i.test(String(err.message ?? "")))

    // What the AI SDK actually threw when the figma run died at 412/492 pairs.
    const real = new Error("The operation was aborted due to timeout")
    expect(timedOut(real, run.signal.aborted)).toBe(true)

    const byName = new Error("stopped")
    byName.name = "TimeoutError"
    expect(timedOut(byName, run.signal.aborted)).toBe(true)

    // The same error, once the visitor has left: not ours to retry.
    run.abort()
    expect(timedOut(real, run.signal.aborted)).toBe(false)

    // And an ordinary failure is neither.
    expect(timedOut(new Error("model refused the schema"), false)).toBe(false)
  })
})
