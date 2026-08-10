import type { Span } from "@open-kb/core"
import { readUi } from "@open-kb/sweep"

/**
 * Span log to the five streams the surface reads.
 *
 *   progress  { round, agent, message, atSec? }    stage rail + event feed
 *   agent     AI-SDK-shaped chunks                 the reading-along panel
 *   cost      { round, usd, tokens, serpCalls }    the meter
 *   trace     one row per tool call                the calls table
 *   (default) { kind, ... }                        results
 *
 * Two classes of span:
 *   narration  `name` starts `ui:`. Routed verbatim, never counted or priced.
 *   work       a search, fetch or model call. Becomes a trace row and advances
 *              the cost counters.
 *
 * `agent` on a progress frame must be a key `AGENT_STAGE` knows, or the rail
 * freezes on the previous stage while the run continues behind it. The sweep
 * emits the six that map: understand, plan, sweep, rank, link, write.
 *
 * A missing number is never defaulted to zero. `readCost` drops a frame whose
 * `usd` is not finite so a broken meter shows nothing rather than $0.00.
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
  /** Why it failed. `SpanStream` already carries this and the sweep already
   *  sets it (`error: r.error` on every SERP span); it was dropped here, so a
   *  failed call reached the browser as a struck-through row with no reason. */
  error?: string
  usd: number
  runningUsd: number
}

/**
 * One namespace's view of one run.
 *
 * Stateful, because the cost frame is cumulative, a fresh adapter replaying the
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
      if (ui.ns !== ns) return null

      /* WHO said it, restored.
         `emitUi(spans, runId, ns, agent, frame)` takes the agent name and writes
         it to `span.agentId` — but `readUi` returns `{ns, frame}` and drops the
         span, so the identity died one layer above this line. It cost nothing
         while the run was a single file of stages. It costs everything to a
         swarm: N agents streaming into one namespace with no way to tell them
         apart is one interleaved monologue, and `AgentPanel` was concatenating
         concurrent model outputs into the same paragraph because of it.
         The frame's own `agent` wins where it has one — `progress` frames carry
         it explicitly and that is the field `stageOf` reads. */
      return typeof ui.frame.agent === "string"
        ? ui.frame
        : { ...ui.frame, agent: span.agentId }
    }

    // Real work. Counted first, so the cost frame this span produces already
    // includes it, a meter that lags its own trace row by one reads as a call
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
          // `tool` is the one field `readTrace` refuses to default, a row with
          // no tool name is dropped, so the span's `name` must always be one.
          tool: span.name,
          kind: span.kind,
          argsDigest: span.argsDigest,
          ms: span.ms,
          ok: span.ok,
          ...(span.error ? { error: span.error } : {}),
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
