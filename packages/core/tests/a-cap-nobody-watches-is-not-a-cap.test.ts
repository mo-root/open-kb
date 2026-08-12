import { describe, expect, it } from "vitest"
import { SpanStream, reserveUsd, tripAtUsd, withSpendCap, type SpendTrip } from "../src/index.js"

/**
 * THE WATCHDOG THAT ENDS A RUN AT ITS CAP.
 *
 * Every ceiling this repo had before it was read once, before the run, from a
 * cumulative figure at a provider — a cap on STARTING, which a run that starts a
 * cent under it walks straight through. What is tested here is the difference:
 * a cap that is checked WHILE the money is being spent, against the run's own
 * span stream, and that ends the run in a way somebody can read afterwards.
 *
 * The three properties, in the order they matter:
 *
 *   it fires            a run that crosses the line is aborted, not observed
 *   it records          the ending is written BEFORE the caller is let go, or a
 *                       run that cost money disappears without a trace
 *   it does not fire    on a normal run, because a cap that stops healthy work
 *                       is a cap the operator turns off, and then there is none
 */

/** One paid call, at whatever it cost. The fields are the span log's, not this
 *  file's — a test that invented its own shape would not be reading the stream
 *  the engines write to. */
function bill(spans: SpanStream, usd: number, name = "classify") {
  return spans.emit({
    runId: "r",
    agentId: "rank",
    parentId: null,
    kind: "model",
    name,
    argsDigest: `call-${usd}`,
    ms: 1,
    ok: true,
    usd,
  })
}

/**
 * A run shaped like the engines': it spends until it is aborted, and then it
 * throws, which is what both `sweep()` and `runSwarm()` do at their checkpoints.
 * `perCall` is the size of one billed call and `pool` is how many are in flight
 * when the signal is read, because the overrun past the trip point is exactly
 * that product.
 */
function fakeRun(
  spans: SpanStream,
  signal: AbortSignal,
  opts: { perCall: number; pool: number; calls: number },
): Promise<string> {
  return (async () => {
    for (let round = 0; round * opts.pool < opts.calls; round++) {
      if (signal.aborted) throw new Error("aborted")
      // The whole pool lands before the signal is read again — a rank pool eight
      // wide does not stop in the middle of itself.
      for (let i = 0; i < opts.pool; i++) bill(spans, opts.perCall)
      await new Promise((r) => setTimeout(r, 0))
    }
    return "a map"
  })()
}

describe("a cap nobody watches is not a cap", () => {
  it("stops a run that crosses the line, and hands the ending back", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const seen: SpendTrip[] = []

    const out = await withSpendCap(fakeRun(spans, abort.signal, { perCall: 0.05, pool: 1, calls: 1_000 }), {
      spans,
      capUsd: 1,
      abort,
      record: (trip) => {
        seen.push(trip)
      },
    }).catch((e: unknown) => (e as Error).message)

    // The engine's own throw came back, unchanged. The watchdog reports what
    // happened to a run; it does not decide what the run's outcome was.
    expect(out).toBe("aborted")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.capUsd).toBe(1)
    expect(seen[0]!.tripUsd).toBe(tripAtUsd(1))
    expect(seen[0]!.spentUsd).toBeGreaterThanOrEqual(tripAtUsd(1))
    // AND IT ACTUALLY STOPPED THE SPENDING. 1,000 calls at five cents is $50;
    // the run ended inside its cap.
    expect(spans.totalUsd()).toBeLessThanOrEqual(1)
  })

  it("records the ending before it lets the caller go, so a stopped run is never lost", async () => {
    // THE FAILURE THIS IS ABOUT is a run that spends money and leaves nothing
    // behind: no row, no file, no reason. A watchdog that aborts and returns
    // without waiting for its own write is that failure, and on a serverless
    // host — where the invocation ends the moment the caller returns — the write
    // simply never happens.
    const spans = new SpanStream()
    const abort = new AbortController()
    let written = false

    await withSpendCap(fakeRun(spans, abort.signal, { perCall: 0.05, pool: 1, calls: 1_000 }), {
      spans,
      capUsd: 1,
      abort,
      record: async () => {
        // A round trip to a database, or a file being written.
        await new Promise((r) => setTimeout(r, 20))
        written = true
      },
    }).catch(() => {})

    expect(written).toBe(true)
  })

  it("aborts BEFORE it records, because what is being raced is money", async () => {
    // The reverse of the deadline watchdog's order, deliberately. Recording is a
    // round trip; a run that goes on buying searches for the length of one is
    // spending exactly the money this exists to stop. The proof is that the
    // signal is already set when the recorder runs.
    const spans = new SpanStream()
    const abort = new AbortController()
    const order: string[] = []

    await withSpendCap(fakeRun(spans, abort.signal, { perCall: 0.05, pool: 1, calls: 1_000 }), {
      spans,
      capUsd: 1,
      abort,
      announce: () => order.push(`announce:${abort.signal.aborted}`),
      record: () => {
        order.push(`record:${abort.signal.aborted}`)
      },
    }).catch(() => {})

    // The log line goes out first — it cannot be awaited into, so it costs
    // nothing to keep the transcript in the order things happened — and the
    // abort lands before anything that can.
    expect(order).toEqual(["announce:false", "record:true"])
  })

  it("does not fire on a normal-sized run", async () => {
    // THE MEASUREMENT THAT MATTERS MOST. A default that fires on healthy work is
    // worse than no default, because the operator disables it and is then
    // unprotected. This is the measured median CLI run — $1.386 — against the
    // $8.00 default the scripts choose.
    const spans = new SpanStream()
    const abort = new AbortController()
    let stopped = false

    const out = await withSpendCap(
      fakeRun(spans, abort.signal, { perCall: 0.001386, pool: 1, calls: 1_000 }),
      {
        spans,
        capUsd: 8,
        abort,
        record: () => {
          stopped = true
        },
      },
    )

    expect(out).toBe("a map")
    expect(stopped).toBe(false)
    expect(abort.signal.aborted).toBe(false)
    expect(spans.totalUsd()).toBeCloseTo(1.386, 6)
  })

  it("does not fire on the worst healthy run on record either", async () => {
    // $3.736, shopify.com, 251 queries, 1,599 seconds — the most expensive run in
    // `runs/` at the current default model that produced a complete map.
    const spans = new SpanStream()
    const abort = new AbortController()
    let stopped = false

    const out = await withSpendCap(fakeRun(spans, abort.signal, { perCall: 0.003736, pool: 1, calls: 1_000 }), {
      spans,
      capUsd: 8,
      abort,
      record: () => {
        stopped = true
      },
    })

    expect(out).toBe("a map")
    expect(stopped).toBe(false)
  })

  it("ends the run inside its cap when whole pools are in flight", async () => {
    // THE RESERVE, MEASURED RATHER THAN ARGUED. Between the span that crosses the
    // line and the engine reading the signal again, everything already in flight
    // still lands and still bills. The rank pool is eight wide, so eight calls
    // land after the trip; the run must still end UNDER its cap, not merely near
    // it, and that is the whole job of the held-back reserve.
    const spans = new SpanStream()
    const abort = new AbortController()
    const cap = 1

    await withSpendCap(fakeRun(spans, abort.signal, { perCall: 0.004, pool: 8, calls: 10_000 }), {
      spans,
      capUsd: cap,
      abort,
      record: () => {},
    }).catch(() => {})

    expect(spans.totalUsd()).toBeGreaterThan(tripAtUsd(cap))
    expect(spans.totalUsd()).toBeLessThanOrEqual(cap)
    // And with room to spare: the reserve is $0.25 here and a whole pool is
    // $0.032.
    expect(spans.totalUsd()).toBeLessThanOrEqual(tripAtUsd(cap) + 8 * 0.004)
  })

  it("does not stop a run that has already ended", async () => {
    // Closing the stream wakes the watcher with whatever was still buffered, and
    // the last span of a perfectly good run can sit above the trip point. Without
    // this guard such a run is recorded as capped after it had already succeeded
    // — a lie about a run that worked, and on the CLI an exit code that tells a
    // batch to treat a finished map as a stopped one.
    const spans = new SpanStream()
    const abort = new AbortController()
    let stopped = false
    const engine = { running: true }

    const task = (async () => {
      // Everything a run bills, all of it above the trip point, landing before
      // the watcher has read any of it.
      for (let i = 0; i < 50; i++) bill(spans, 0.05)
      engine.running = false
      return "a map"
    })()

    const out = await withSpendCap(task, {
      spans,
      capUsd: 1,
      abort,
      stillRunning: () => engine.running,
      record: () => {
        stopped = true
      },
    })
    spans.close()
    await new Promise((r) => setTimeout(r, 0))

    expect(out).toBe("a map")
    expect(stopped).toBe(false)
    expect(abort.signal.aborted).toBe(false)
  })

  it("off is off: no cap installs no watcher and changes nothing", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const task = Promise.resolve("a map")

    // The same promise, not a wrapper around it: nothing subscribes, nothing
    // branches, and a run with no cap pays nothing for the feature.
    const returned = withSpendCap(task, { spans, capUsd: null, abort, record: () => {} })
    expect(returned).toBe(task)

    for (let i = 0; i < 100; i++) bill(spans, 1)
    expect(abort.signal.aborted).toBe(false)
    expect(await returned).toBe("a map")
  })

  it("hands back what the task returned when nothing fired", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const out = await withSpendCap(Promise.resolve({ entities: 41 }), {
      spans,
      capUsd: 8,
      abort,
      record: () => {},
    })
    expect(out).toEqual({ entities: 41 })
  })

  it("passes a failure through untouched, and does not call it a cap stop", async () => {
    // A run that dies of a provider error is not a run that reached its ceiling,
    // and a watchdog that swallowed the difference would have the CLI writing
    // "stopped at the cap" over an authentication failure.
    const spans = new SpanStream()
    const abort = new AbortController()
    let stopped = false

    const out = await withSpendCap(Promise.reject(new Error("insufficient credits")), {
      spans,
      capUsd: 8,
      abort,
      record: () => {
        stopped = true
      },
    }).catch((e: unknown) => (e as Error).message)

    expect(out).toBe("insufficient credits")
    expect(stopped).toBe(false)
  })

  it("reports a recorder that throws instead of losing it", async () => {
    const spans = new SpanStream()
    const abort = new AbortController()
    const failures: unknown[] = []

    await withSpendCap(fakeRun(spans, abort.signal, { perCall: 0.05, pool: 1, calls: 1_000 }), {
      spans,
      capUsd: 1,
      abort,
      record: () => {
        throw new Error("the database is down")
      },
      onRecordFailure: (e) => failures.push(e),
    }).catch(() => {})

    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe("the database is down")
  })
})

describe("the trip point sits below the cap, so a run ends AT it rather than past it", () => {
  it("always holds something back, at every size a cap is set to", () => {
    // $0.41 is the web route's default on a 300s host, $3.74 on a big one, $8.00
    // is the CLI default, and $1.50 the swarm's usual ceiling.
    for (const cap of [0.41, 1.5, 3.74, 8]) {
      expect(tripAtUsd(cap)).toBeLessThan(cap)
      expect(cap - tripAtUsd(cap)).toBeGreaterThanOrEqual(0.05)
      // `toBeCloseTo`, because the two sides are the same subtraction done in a
      // different order and binary floats do not care that they are equal.
      expect(cap - tripAtUsd(cap)).toBeCloseTo(reserveUsd(cap), 10)
    }
  })

  it("never goes negative, however small the cap", () => {
    // A cap under the floor reserve would otherwise produce a negative trip
    // point, and every run would abort on its first span. Callers refuse such a
    // cap; the arithmetic must not produce nonsense in the meantime.
    expect(tripAtUsd(0.01)).toBe(0)
    expect(tripAtUsd(0)).toBe(0)
  })
})
