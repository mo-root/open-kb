import { describe, it, expect, vi } from "vitest"
import { SpanStream } from "../src/spans.js"
import { reserveUsd, tripAtUsd, withSpendCap, type SpendTrip } from "../src/spend-cap.js"

const base = { runId: "r1", agentId: "lead", parentId: null, ms: 10, ok: true, usd: 0 }

/** Flushes both microtasks and the generator/promise hops `SpanStream.stream()`
 *  needs to deliver an emitted span to a parked consumer. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("reserveUsd", () => {
  it("takes 25% of the cap when that beats the $0.05 floor", () => {
    expect(reserveUsd(1)).toBeCloseTo(0.25)
  })

  it("takes the $0.05 floor on a small cap", () => {
    expect(reserveUsd(0.1)).toBeCloseTo(0.05)
  })
})

describe("tripAtUsd", () => {
  it("is the cap minus its reserve", () => {
    expect(tripAtUsd(1)).toBeCloseTo(0.75)
  })

  it("never goes negative on a cap smaller than the reserve floor", () => {
    expect(tripAtUsd(0.02)).toBe(0)
  })
})

describe("withSpendCap", () => {
  it("a null cap installs no subscriber and hands back the task unchanged", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const record = vi.fn()
    const result = withSpendCap(Promise.resolve("done"), { spans, capUsd: null, abort, record })
    await expect(result).resolves.toBe("done")
    expect(record).not.toHaveBeenCalled()
    expect(abort.signal.aborted).toBe(false)
  })

  it("lets a run finish under the cap: no trip, no abort, no record", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const record = vi.fn()
    const task = (async () => {
      spans.emit({ ...base, kind: "model", name: "classify", argsDigest: "x", usd: 0.1 })
      spans.close()
      return "ok"
    })()
    const result = withSpendCap(task, { spans, capUsd: 1, abort, record })
    await expect(result).resolves.toBe("ok")
    expect(record).not.toHaveBeenCalled()
    expect(abort.signal.aborted).toBe(false)
  })

  it("trips at tripUsd, in order announce -> abort -> record, and re-throws the run's own rejection", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const order: string[] = []
    const announce = vi.fn((trip: SpendTrip) => order.push(`announce:${trip.tripUsd}`))
    const record = vi.fn(async (trip: SpendTrip) => {
      order.push(`record:${trip.spentUsd}`)
    })
    abort.signal.addEventListener("abort", () => order.push("abort"))
    const { promise: task, reject } = deferred<string>()

    const result = withSpendCap(task, { spans, capUsd: 1, abort, announce, record })
    spans.emit({ ...base, kind: "search", name: "serp", argsDigest: "q", usd: 0.8 }) // crosses tripUsd = 0.75
    await tick()

    expect(order).toEqual(["announce:0.75", "abort", "record:0.8"])
    expect(abort.signal.aborted).toBe(true)
    expect(record).toHaveBeenCalledWith({ capUsd: 1, tripUsd: 0.75, heldBackUsd: 0.25, spentUsd: 0.8 } satisfies SpendTrip)

    // The abort is what stops the underlying run; here that means the task rejects, as both the
    // web route's and every CLI's engine do when the abort signal they were given fires.
    reject(new Error("aborted"))
    await expect(result).rejects.toThrow("aborted")
  })

  it("stops after one trip: a span emitted after the break does not record a second time", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const record = vi.fn(async () => {})
    const { promise: task, reject } = deferred<string>()

    const result = withSpendCap(task, { spans, capUsd: 1, abort, record })
    spans.emit({ ...base, kind: "search", name: "serp", argsDigest: "q", usd: 0.9 })
    await tick()
    expect(record).toHaveBeenCalledTimes(1)

    // In flight work can still land after the trip; the subscriber must already be gone.
    spans.emit({ ...base, kind: "search", name: "serp", argsDigest: "q2", usd: 0.95 })
    await tick()
    expect(record).toHaveBeenCalledTimes(1)

    reject(new Error("aborted"))
    await expect(result).rejects.toThrow("aborted")
  })

  it("stops watching without tripping once stillRunning() reports false", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const record = vi.fn()
    let running = true
    const task = new Promise<string>(() => {})
    withSpendCap(task, { spans, capUsd: 1, abort, record, stillRunning: () => running })

    running = false
    // Above tripUsd (0.75), but stillRunning() is checked before the trip test on every span.
    spans.emit({ ...base, kind: "search", name: "serp", argsDigest: "q", usd: 0.9 })
    await tick()

    expect(record).not.toHaveBeenCalled()
    expect(abort.signal.aborted).toBe(false)
  })

  it("routes a record() failure to onRecordFailure instead of an unhandled rejection", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const recordError = new Error("write failed")
    const record = vi.fn(async () => {
      throw recordError
    })
    const onRecordFailure = vi.fn()
    const { promise: task, reject } = deferred<string>()

    const result = withSpendCap(task, { spans, capUsd: 1, abort, record, onRecordFailure })
    spans.emit({ ...base, kind: "search", name: "serp", argsDigest: "q", usd: 0.8 })
    await tick()

    expect(onRecordFailure).toHaveBeenCalledWith(recordError)

    reject(new Error("aborted"))
    await expect(result).rejects.toThrow("aborted")
  })

  it("a run that succeeds on its own after tripping still surfaces its value, not the trip", async () => {
    // See the note in spend-cap.ts on `stillRunning`: a consumer can be behind the log, and a
    // healthy run's last span can land above the trip point. If the caller has no stillRunning()
    // guard, that late span still trips the watchdog — but the settle path is symmetric either
    // way, so this pins what happens when the run's own promise resolves rather than rejects.
    const spans = new SpanStream()
    const abort = new AbortController()
    const record = vi.fn(async () => {})
    const { promise: task, resolve } = deferred<string>()

    const result = withSpendCap(task, { spans, capUsd: 1, abort, record })
    spans.emit({ ...base, kind: "search", name: "serp", argsDigest: "q", usd: 0.8 })
    await tick()
    expect(record).toHaveBeenCalledTimes(1)

    resolve("finished anyway")
    await expect(result).resolves.toBe("finished anyway")
  })
})
