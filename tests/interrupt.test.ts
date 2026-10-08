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
