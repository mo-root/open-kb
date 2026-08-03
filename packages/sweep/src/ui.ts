import type { Span, SpanStream } from "@open-kb/core"

/**
 * How narration rides the span log.
 *
 * The run has exactly one append-only log — `SpanStream` — and everything a
 * viewer reads comes off it, so a reader that reconnects mid-run replays the
 * same sequence a reader that was there from the start saw. That log's unit is
 * a `Span`: a thing the run DID, with a duration and a price.
 *
 * A stage headline ("firing 12 queries") and a result payload (the classified
 * host bag) are not that. They cost nothing and take no time, and counting them
 * as calls would inflate every tally on screen. They still have to travel in
 * `seq` order alongside the work they describe, or the stage rail lights after
 * the calls it is supposed to precede.
 *
 * So they ride as spans whose `name` is prefixed `ui:`, carrying their payload
 * as JSON in `argsDigest`. The adapter routes those verbatim to the namespace
 * named after the prefix and — critically — never counts them as tool calls,
 * which is what keeps `serpCalls` equal to the number of searches actually
 * bought.
 */

export const UI_PREFIX = "ui:"

/** The namespaces narration can be addressed to. `cost` and `trace` are not
 *  here on purpose: both are DERIVED from real spans, so nothing may inject a
 *  cost line by hand — a hand-written cost frame is how a run reports spending
 *  it never did. */
export type UiNamespace = "progress" | "agent" | "results"

export interface UiFrame {
  ns: UiNamespace
  frame: Record<string, unknown>
}

export function emitUi(
  spans: SpanStream,
  runId: string,
  ns: UiNamespace,
  agent: string,
  frame: Record<string, unknown>,
): void {
  spans.emit({
    runId,
    agentId: agent,
    parentId: null,
    kind: "remember",
    name: `${UI_PREFIX}${ns}`,
    argsDigest: JSON.stringify(frame),
    ms: 0,
    ok: true,
    usd: 0,
  })
}

/** `null` for a span that is real work rather than narration. A malformed
 *  payload is also `null`: a torn frame must degrade to one missing line, never
 *  to a thrown adapter that takes the whole stream down with it. */
export function readUi(span: Span): UiFrame | null {
  if (!span.name.startsWith(UI_PREFIX)) return null
  const ns = span.name.slice(UI_PREFIX.length)
  if (ns !== "progress" && ns !== "agent" && ns !== "results") return null
  try {
    const frame = JSON.parse(span.argsDigest) as unknown
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null
    return { ns, frame: frame as Record<string, unknown> }
  } catch {
    return null
  }
}
