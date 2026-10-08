import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EXIT } from "../scripts/fatal.js"
import { installInterruptHandler } from "../scripts/interrupt.js"

/**
 * `scripts/sweep.ts` cannot be run end to end here — it reaches for real
 * credentials and a live network call the moment it starts, which this repo's
 * overnight loop may never do (see `tests/batch-refuses-before-it-spends-
 * anything.test.ts`'s own note on the same constraint). So this pins the
 * handler itself: a real `AbortController`, a real `process.on("SIGINT"`
 * listener, `process.exit` and `console.error` stubbed the same way
 * `tests/fatal.test.ts` stubs them for `fatal()` — nothing here touches the
 * network or the model.
 */

function setUp() {
  const abort = new AbortController()
  const holder = { interrupted: false }
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
  const unregister = installInterruptHandler(abort, () => 1.2345, holder)
  return { abort, holder, errorSpy, exitSpy, unregister }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("installInterruptHandler", () => {
  it("aborts the run and reports the spend on the first SIGINT, without exiting", () => {
    const { abort, holder, errorSpy, exitSpy, unregister } = setUp()
    try {
      process.emit("SIGINT")
      expect(abort.signal.aborted).toBe(true)
      expect(holder.interrupted).toBe(true)
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("$1.2345 spent so far")
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it("leaves immediately, with EXIT.interrupted, on a second SIGINT", () => {
    const { exitSpy, unregister } = setUp()
    try {
      process.emit("SIGINT")
      process.emit("SIGINT")
      expect(exitSpy).toHaveBeenCalledWith(EXIT.interrupted)
    } finally {
      unregister()
    }
  })

  it("answers SIGTERM the same way as SIGINT", () => {
    const { abort, holder, unregister } = setUp()
    try {
      process.emit("SIGTERM")
      expect(abort.signal.aborted).toBe(true)
      expect(holder.interrupted).toBe(true)
    } finally {
      unregister()
    }
  })

  it("unregister leaves no listener behind", () => {
    const before = process.listenerCount("SIGINT")
    const { unregister } = setUp()
    expect(process.listenerCount("SIGINT")).toBe(before + 1)
    unregister()
    expect(process.listenerCount("SIGINT")).toBe(before)
  })
})

/**
 * BOTH CLI ENTRYPOINTS ARE ACTUALLY WIRED TO THIS, and a guard rather than a
 * proof for the same reason `tests/the-cli-entrypoints-have-a-dollar-bound
 * .test.ts` gives for its own source-grep checks: `scripts/sweep.ts` and
 * `scripts/swarm.ts` both reach for live credentials at module scope, so
 * nothing here can import and drive them end to end. What a grep catches is
 * the wiring being quietly removed while the handler it calls stays behind,
 * green and unreferenced.
 *
 * `scripts/swarm.ts` had no SIGINT/SIGTERM handling at all until this fire —
 * confirmed by `git log`, the commit that added the assertion below is the
 * same one that added the three lines it checks for. Before it, a Ctrl+C on
 * a running swarm hit Node's own default (dead silently, nothing printed),
 * the exact gap `scripts/interrupt.ts`'s own file comment already measured
 * for `scripts/sweep.ts` before THAT handler existed.
 */
describe("both scripts/sweep.ts and scripts/swarm.ts are wired to the handler", () => {
  const source = (name: string) => readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), "utf8")

  it("sweep.ts installs the handler on its own abort and exits EXIT.interrupted", () => {
    const src = source("sweep.ts")
    expect(src).toContain("installInterruptHandler(abort")
    expect(src).toContain("EXIT.interrupted")
  })

  it("swarm.ts installs the handler too, and its catch no longer sends an interrupt through fatal()", () => {
    const src = source("swarm.ts")
    expect(src).toContain("installInterruptHandler(abort")
    // The bug this fire fixed: the orchestrator's `abortedEnd()` rejects on
    // EITHER a cap trip or a manual abort, and the catch used to decide
    // "was this fatal?" from `capStop.trip` alone — which a Ctrl+C never
    // sets, so it was routed to `fatal()` and reported as a crash.
    expect(src).toContain("!capStop.trip && !interrupted.interrupted")
    expect(src).toContain("EXIT.interrupted")
  })
})
