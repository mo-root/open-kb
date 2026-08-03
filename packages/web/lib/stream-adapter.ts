import type { Span } from "@open-kb/core"
import { readUi } from "@open-kb/sweep"

/**
 * Span log → the four things the surface reads.
 *
 * The engine emits ONE kind of thing: a `Span`, an append-only record of
 * something the run did. The UI reads four namespaces with four different
 * shapes (components/build/types.ts holds the readers). This is the only place
 * that knows how one becomes the other.
 *
 *   progress  { round, agent, message, atSec? }         stage rail + event feed
 *   agent     AI-SDK-shaped chunks                      the reading-along panel
 *   cost      { round, usd, tokens, serpCalls, … }      the meter
 *   trace     one row per tool call                     the calls table
 *   (default) { kind, … }                               results
 *
 * TWO CLASSES OF SPAN, and the distinction is the whole design:
 *
 *   NARRATION — `name` starts `ui:`. A stage headline, a result payload, a line
 *     of the model's own output. Routed verbatim to the namespace it names.
 *     Never counted, never priced: it did no work and cost nothing.
 *
 *   WORK — everything else. A search, a fetch, a model call. Becomes a trace row
 *     AND advances the cost counters. This is the only thing that may.
 *
 * `agent` on a progress frame must be a key `AGENT_STAGE` knows or the rail
 * freezes on the stage before while the run works perfectly behind it. The
 * sweep emits exactly the five names that map (understand · plan · sweep · rank
 * · write) and there is a test-shaped comment on both ends saying so.
 *
 * NOTHING HERE DEFAULTS A MISSING NUMBER TO ZERO. `readCost` drops a frame
 * whose `usd` is not finite precisely so a broken meter shows as nothing rather
 * than as a healthy $0.00, and `SpanStream.emit` already flags a non-finite
 * price as a failed span. Re-defaulting here would defeat both.
 */

export type Namespace = "results" | "progress" | "agent" | "cost" | "trace"

export const NAMESPACES: readonly Namespace[] = ["results", "progress", "agent", "cost", "trace"]

export function isNamespace(v: string | null): v is Namespace {
  return v !== null && (NAMESPACES as readonly string[]).includes(v)
}

export interface CostFrame {
  round: number
  usd: number
  tokens: number
  serpCalls: number
  unlockerCalls: number
}

export interface TraceFrame {
  seq: number
  ts: string
  round: number
  agent: string
  tool: string
  kind: string
  argsDigest: string
  ms: number
  ok: boolean
  usd: number
  runningUsd: number
}

/**
 * One namespace's view of one run.
 *
 * Stateful, because the cost frame is CUMULATIVE — a fresh adapter replaying the
 * run's whole log from span 1 reproduces exactly the counts a reader that was
 * attached from the start saw. That property is what makes `startIndex`
 * reconnection lossless: the server replays, counts, and skips.
 */
export function adapterFor(ns: Namespace): (span: Span) => unknown | null {
  let tokens = 0
  let serpCalls = 0
  let unlockerCalls = 0

  return (span: Span): unknown | null => {
    const ui = readUi(span)

    if (ui) {
      // Narration. Verbatim to its own namespace, invisible everywhere else —
      // in particular it must not reach `cost` or `trace`, where it would
      // inflate the call count with things that were never called.
      return ui.ns === ns ? ui.frame : null
    }

    // Real work. Counted first, so the cost frame this span produces already
    // includes it — a meter that lags its own trace row by one reads as a call
    // that was made for free.
    tokens += (span.tokensIn ?? 0) + (span.tokensOut ?? 0)
    if (span.kind === "search") serpCalls += 1
    if (span.kind === "fetch" && span.name === "unlocker") unlockerCalls += 1

    switch (ns) {
      case "cost":
        return {
          round: 1,
          // `runningUsd` is the stream's own total, not a sum recomputed here.
          // SpanStream is what zeroes and flags a non-finite price, so this
          // number is already the one that was audited.
          usd: span.runningUsd,
          tokens,
          serpCalls,
          unlockerCalls,
        } satisfies CostFrame
      case "trace":
        return {
          seq: span.seq,
          ts: span.ts,
          round: 1,
          agent: span.agentId,
          // `tool` is the one field `readTrace` refuses to default — a row with
          // no tool name is dropped, so the span's `name` must always be one.
          tool: span.name,
          kind: span.kind,
          argsDigest: span.argsDigest,
          ms: span.ms,
          ok: span.ok,
          usd: span.usd,
          runningUsd: span.runningUsd,
        } satisfies TraceFrame
      default:
        // `results`, `progress` and `agent` carry narration only. A search that
        // returned nothing is a trace row and a cost line; it is not a result.
        return null
    }
  }
}
