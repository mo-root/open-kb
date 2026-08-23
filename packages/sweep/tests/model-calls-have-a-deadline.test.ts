import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CALL_TIMEOUT_MS, LINK_CALL_TIMEOUT_MS, RANK_CALL_TIMEOUT_MS } from "../src/sweep.js"

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
    // The slowest legitimate single call in runs/ is the catalog call at 51s
    // when it ran as one call instead of three. The old floor here was 62s,
    // from classify retries measured on the pinned OpenRouter host that
    // `openrouterOpts` has since stopped pinning — on the throughput-sorted
    // route a classify is 2-3s, and a ceiling sized to the slow host's
    // retries cost runs/sweep-cursor-com-20260823064255.json 6.3 minutes on
    // its last four judge hosts.
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(51_000)
    expect(CALL_TIMEOUT_MS).toBeLessThanOrEqual(600_000)
  })

  it("gives the per-host calls a ceiling half the general one — the pool's tail is bounded by it", () => {
    // classify, triage, second look, drop-confirm: one-host questions the
    // throughput-sorted route answers in 2-3s, made by the thousand. The
    // last few hosts of a pool have nothing to hide behind, so one ceiling
    // plus one retry is how long a run waits on its stragglers.
    expect(RANK_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
    expect(RANK_CALL_TIMEOUT_MS).toBeLessThanOrEqual(CALL_TIMEOUT_MS / 2)
  })

  it("gives link no longer a deadline than any other agent, within the backlog's 45-60s range", () => {
    // P0-4: link and orphan calls are batched, uniform, and already retried
    // once, so a hang there does not need more runway than CALL_TIMEOUT_MS.
    // The two met at 60s when the global ceiling came down; link keeps its
    // own knob, and must never be the LONGER of the two.
    expect(LINK_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000)
    expect(LINK_CALL_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
    expect(LINK_CALL_TIMEOUT_MS).toBeLessThanOrEqual(CALL_TIMEOUT_MS)
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

/**
 * THE DEADLINE HAS TO SURVIVE A GARBAGE COLLECTION.
 *
 * On Node 20 a timeout signal reachable only through `AbortSignal.any` is held
 * weakly by the composite; a gc() during the call frees it and the timer has
 * nothing left to abort. Measured before it was understood: one classify call
 * on runs/sweep-cursor-com-20260823064255.json ran ~355s against a 120s
 * ceiling, and the log carries no "no answer" line for it — the deadline had
 * been collected, not exceeded.
 *
 * `gc()` only exists under --expose-gc, so this runs the probe in a child
 * node with that flag, loading `deadline.ts` through tsx. The bare composite
 * is built beside `heldDeadline` in the same process: the test is the
 * DIFFERENCE between them under one gc, not a property of the runtime. On a
 * Node that holds the composite strongly both fire and the test still passes
 * — it asserts the held one fires, never that the bare one is lost.
 */
describe("the deadline survives a garbage collection", () => {
  it("fires after gc() where the bare AbortSignal.any composite may not", () => {
    const deadline = fileURLToPath(new URL("../src/deadline.ts", import.meta.url))
    const probe = `
      import { heldDeadline } from ${JSON.stringify(deadline)}
      const run = new AbortController().signal
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const bare = AbortSignal.any([run, AbortSignal.timeout(150)])
      const held = heldDeadline(150, run)
      let bareFired = false, heldFired = false
      bare.addEventListener("abort", () => { bareFired = true })
      held.addEventListener("abort", () => { heldFired = true })
      await wait(20); globalThis.gc(); await wait(20); globalThis.gc()
      await wait(400)
      console.log(JSON.stringify({ bareFired, heldFired, runAborted: run.aborted }))
    `
    const out = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", probe],
      { encoding: "utf8", timeout: 30_000 },
    )
    const last = out.trim().split("\n").pop()!
    const r = JSON.parse(last) as { bareFired: boolean; heldFired: boolean; runAborted: boolean }
    expect(r.heldFired).toBe(true)
    // The run's own signal is untouched by a timeout, which is what lets the
    // caller tell a host that stopped answering from a visitor who left.
    expect(r.runAborted).toBe(false)
  }, 30_000)
})
