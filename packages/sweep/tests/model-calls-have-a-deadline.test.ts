import { describe, it, expect } from "vitest"
import { CALL_TIMEOUT_MS } from "../src/sweep.js"

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
