import type { SpanStream } from "./spans.js"

/**
 * END A RUN JUST BEFORE IT COSTS MORE THAN ONE RUN IS ALLOWED TO COST.
 *
 * WHAT THIS IS FOR, and why a check before the run is not it. Every ceiling
 * this repo had before this one was read ONCE, ahead of the run, from a
 * cumulative figure at the provider. A run that starts a cent under such a
 * ceiling can then spend for as long as it likes with nothing watching, and the
 * reading that would have caught it is taken after the money is gone. A cap
 * that is only checked before the spending is not a cap on the spending; it is
 * a cap on STARTING, which is a different and much weaker promise.
 *
 * WHY THE SPAN STREAM AND NOT THE PROVIDER. `SpanStream.runningUsd` is this
 * run's own total, updated as each span lands, and it counts model AND search
 * AND fetch. A model provider's usage figure counts one of those three — and 58%
 * to 77% of a run's bill is search, which the model provider has never heard of.
 * It is also free: the number is already in hand, so watching it costs no
 * request and has no reading to fail.
 *
 * A SUBSCRIBER, NOT A POLL. `stream()` is a genuine fan-out — every consumer
 * gets its own cursor over the shared log — so this reads every span the run
 * emits, wakes only when one is emitted, and unsubscribes on the way out. A
 * timer would either check too rarely to stop anything or spin for the whole
 * run.
 *
 * WHY IT IS IN CORE. It was written in `packages/web/app/api/map/route.ts`, for
 * the one surface that meters what it spends, and it worked there — the three
 * CLI entrypoints meanwhile had no dollar bound of any kind, and the worst
 * single run on disk cost $6.83. Both engines emit into the same `SpanStream`,
 * so the same watchdog stops either one; a second copy in `scripts/` would have
 * been the same delicate ordering argument maintained twice.
 *
 * WHAT IT DOES NOT KNOW. Not what a run may cost, not where that number is
 * configured, not what a stopped run should be recorded as. The caller passes
 * the cap in and owns the ending; this owns the watching and the ORDER. Dollar
 * amounts are the payer's business, and the two payers here disagree about them
 * by an order of magnitude — `packages/web/lib/spend-limits.ts` derives $0.41
 * from what a 300s host affords, `scripts/spend-caps.ts` measures $8.00 from
 * what a CLI run actually costs.
 */

/** What the run had reached, and what it was measured against, at the stop. */
export interface SpendTrip {
  /** The ceiling in force for this run. */
  capUsd: number
  /** The running total the run is stopped at, which is BELOW the cap. */
  tripUsd: number
  /** `capUsd - tripUsd`: what is held back so the ending can be written. */
  heldBackUsd: number
  /** What the span that crossed the line brought the run's own total to. */
  spentUsd: number
}

export interface SpendCapOpts {
  /** The run's own span log. Read, never written. */
  spans: SpanStream
  /** The most this run may cost, or `null` for no cap at all. */
  capUsd: number | null
  /**
   * Aborted FIRST, before anything is recorded, and that order is the whole
   * correctness argument — see `withSpendCap`.
   */
  abort: AbortController
  /**
   * Said before the abort. A log line is not a promise and cannot be awaited
   * into, so it costs nothing to put it in front and it keeps the operator's
   * transcript in the order things happened. Optional: a silent stop is a
   * choice a caller may make.
   */
  announce?: (trip: SpendTrip) => void
  /**
   * The ending, written after the abort. Whatever a run being stopped
   * deliberately means on this surface: a row for the web route, a file on disk
   * for a CLI. Awaited, so a caller that returns a promise here is not raced by
   * the run's own unwinding.
   */
  record: (trip: SpendTrip) => void | Promise<void>
  /**
   * False once the run has ended some other way. Defaults to "still running".
   *
   * A RUN THAT IS ALREADY OVER MUST NOT BE STOPPED AGAIN. This loop reads the
   * log through its own cursor and can be BEHIND it: spans land faster than a
   * consumer resumes, so when the engine returns there may still be spans here
   * that this loop has not looked at — and the last span of a perfectly good run
   * can sit above the trip point. The trip is below the cap and the cap is above
   * what a healthy run costs, but "above" is a median with a spread. Without
   * this, such a run is recorded as capped after it had already succeeded.
   */
  stillRunning?: () => boolean
  /** If `record` throws. The run is already stopped by then; this is the only
   *  place that failure can be seen. */
  onRecordFailure?: (e: unknown) => void
}

/**
 * How much of a run's ceiling is held back so the run can be STOPPED at it
 * rather than discovered past it.
 *
 * `max($0.05, 25% of the cap)`, the shape `Ledger.finishReserveUsd` already uses
 * for the same job with a narrower fraction. Between the span that crosses the
 * line and the engine reaching its next abort checkpoint, whatever was already
 * in flight still lands and still bills, and this reserve is what that costs.
 *
 * WHAT IT BUYS, from the measured composition of a run's bill: at $0.0004 a
 * classify call and $0.0086 a search call, $0.05 is 125 classify calls or 6
 * searches. The widest pool that can be in flight is a search wave at 20, and a
 * whole run's search spend is bounded by its query budget, so the honest bound
 * is: a run can end over its cap, by at most what was in flight, and what can be
 * in flight is cents.
 *
 * IT LIVES HERE, WITH THE WATCHDOG, though the dollar figures either side of it
 * do not. A watchdog cannot stop a run AT a cap without knowing how much to hold
 * back, so the reserve is the mechanism's own parameter rather than a policy —
 * and it now has four callers (the web route and three CLI entrypoints) where it
 * had one.
 */
export function reserveUsd(capUsd: number): number {
  return Math.max(0.05, 0.25 * capUsd)
}

/** The running total at which a run is stopped, so that it ENDS at its cap. */
export function tripAtUsd(capUsd: number): number {
  return Math.max(0, capUsd - reserveUsd(capUsd))
}

/**
 * Watch `task`'s spending and stop it at `capUsd`, then hand the task's own
 * outcome back unchanged.
 *
 * ORDER, AND IT IS THE REVERSE OF A DEADLINE WATCHDOG'S. A watchdog counting
 * CLOCK records the run and then aborts, because the recorder reads the abort
 * signal to decide whether a person stopped the run, and "you stopped it" is a
 * lie told about a run nobody touched. Correct there, wrong here: recording is a
 * round trip to a database or a write to disk, and a run that goes on buying
 * searches for the length of one is a run spending exactly the money this
 * watchdog exists to stop. Thirty seconds of clock is something to spend on a
 * clean ending; dollars are not. So the abort comes FIRST and the record second.
 *
 * The abort and the `record` call are in one synchronous block, so no microtask
 * can slip between them: the engine's own throw reaches the task's catch only
 * after this one has already claimed the ending. Callers that can end a run
 * twice need a first-ending rule of their own; `announce` runs inside the same
 * block, ahead of the abort, because it cannot await.
 *
 * IT TRIPS BELOW THE CAP, at `tripAtUsd`, for the reason that function gives.
 *
 * OFF IS OFF. A `null` cap installs no subscriber, adds no branch to the hot
 * path, and hands back the promise that came in.
 */
export function withSpendCap<T>(task: Promise<T>, opts: SpendCapOpts): Promise<T> {
  const { spans, capUsd, abort, announce, record, stillRunning, onRecordFailure } = opts
  if (capUsd === null) return task

  const tripUsd = tripAtUsd(capUsd)
  /** Set BEFORE the write it guards, so the wrapper below knows there is an
   *  ending in flight that it has to wait for. */
  let stopping = false

  const watching = (async () => {
    for await (const span of spans.stream()) {
      if (stillRunning && !stillRunning()) break
      if (span.runningUsd < tripUsd) continue
      const trip: SpendTrip = {
        capUsd,
        tripUsd,
        heldBackUsd: capUsd - tripUsd,
        spentUsd: span.runningUsd,
      }
      stopping = true
      announce?.(trip)
      // Before the record, deliberately, and in the same synchronous block as
      // the call below it. See the note above: what is being raced here is
      // money, not a log line.
      abort.abort()
      await record(trip)
      // ONE STOP PER RUN. There is nothing left to watch — the run is aborted
      // and its ending is written — and a recorder that closed the stream (the
      // web route's does) would end this loop anyway. Breaking says so, and
      // unsubscribes on the way out.
      break
    }
  })().catch((e: unknown) => {
    // HANDLED WHERE IT IS CREATED, not where it is awaited, and the difference
    // is an unhandled rejection. This promise can reject the instant `record`
    // throws, which is long before the wrapper below gets to it — the wrapper is
    // still waiting for the run to unwind. A `catch` attached only down there
    // leaves a window in which the runtime sees a rejected promise nobody is
    // watching, and on a serverless host an unhandled rejection can take the
    // whole invocation down: a recorder that failed to write one ending would
    // destroy the process that was about to write the others.
    onRecordFailure?.(e)
  })

  return (async () => {
    // Settled rather than awaited, so the task's own rejection — which for both
    // engines is how a stop arrives — does not escape before the ending has been
    // written. It is re-thrown below, unchanged: this wrapper reports what
    // happened to the run, it does not decide what the run's outcome was.
    const settled = await task.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    // AWAITED ONLY WHEN IT IS DOING SOMETHING, and the asymmetry is deliberate.
    // If this watcher stopped the run, its `record` is the run's ending and the
    // caller may not return in front of it — that await is the difference
    // between a stopped run that is written down and one that disappears. If it
    // did not, the run ended some other way and this loop is either finished or
    // PARKED on a stream that nobody has closed yet: the caller closes it after
    // this returns, or — a shape both the web registry and an abandoned CLI run
    // can produce — never. Awaiting unconditionally would hang on that second
    // case forever; abandoning a parked subscriber costs one object that dies
    // with the run.
    if (stopping) await watching
    if (settled.ok) return settled.value
    throw settled.error
  })()
}
