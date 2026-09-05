import { describe, expect, it } from "vitest"
import type { Span } from "@open-kb/core"
import { adapterFor, isNamespace, NAMESPACES } from "./stream-adapter"

/* The identity that was being dropped.
   `emitUi` writes the agent name to `span.agentId`, `readUi` returns only
   `{ns, frame}`, and the adapter used to forward that frame verbatim — so
   every narration frame reached the browser anonymous. With one agent that
   was invisible. With a swarm it is the difference between N readable threads
   and one interleaved monologue, so it is worth a test that fails loudly if
   the field is ever dropped again. */

function uiSpan(ns: string, agentId: string, frame: Record<string, unknown>): Span {
  return {
    runId: "r1",
    seq: 1,
    ts: "2026-08-04T00:00:00.000Z",
    agentId,
    parentId: null,
    kind: "remember",
    name: `ui:${ns}`,
    argsDigest: JSON.stringify(frame),
    ms: 0,
    ok: true,
    usd: 0,
    runningUsd: 0,
  } as unknown as Span
}

describe("adapterFor — narration", () => {
  it("stamps the emitting agent onto an agent frame that has no identity", () => {
    const frame = adapterFor("agent")(
      uiSpan("agent", "discover", { type: "text-delta", delta: "reading the docs" }),
    ) as Record<string, unknown>

    expect(frame).toMatchObject({ type: "text-delta", delta: "reading the docs" })
    expect(frame.agent).toBe("discover")
  })

  it("never overwrites an agent the frame states itself", () => {
    // Progress frames carry `agent` explicitly and `stageOf` reads exactly that
    // field. If the span's id ever won here, a frame narrated by one agent on
    // behalf of a stage would light the wrong stage.
    const frame = adapterFor("progress")(
      uiSpan("progress", "sweep", { agent: "plan", message: "round 2: widening" }),
    ) as Record<string, unknown>

    expect(frame.agent).toBe("plan")
  })

  it("still routes narration only to its own namespace", () => {
    expect(adapterFor("agent")(uiSpan("progress", "plan", { message: "x" }))).toBeNull()
  })

  it("keeps narration out of cost and trace entirely", () => {
    // A narration frame counted as a call is how a run reports work it never
    // did; the `ui:` prefix is what prevents it and this pins that.
    expect(adapterFor("cost")(uiSpan("progress", "plan", { message: "x" }))).toBeNull()
    expect(adapterFor("trace")(uiSpan("agent", "plan", { text: "x" }))).toBeNull()
  })
})

/* isNamespace had zero direct test anywhere — grepped every *.test.ts in the
   repo. It is the one guard between a browser-supplied `?ns=` and `adapterFor`,
   which switches on its argument as a Namespace with no runtime check of its
   own: app/api/run/[id]/stream/route.ts calls `isNamespace(nsParam)` and
   answers 400 on a miss, in both its live and replay paths, and neither path
   has a route-level test covering that branch either. A regression here — a
   typo in NAMESPACES, a case-sensitivity slip — would not 400 on a bad `ns`;
   it would fall through to `adapterFor`'s `default` branch and silently stream
   nothing, which is a much harder failure to notice than a rejected request. */
describe("isNamespace", () => {
  it("accepts exactly the five namespaces adapterFor knows", () => {
    for (const ns of NAMESPACES) expect(isNamespace(ns)).toBe(true)
    expect(NAMESPACES).toHaveLength(5)
  })

  it("rejects null, the empty string, and anything not in the list", () => {
    expect(isNamespace(null)).toBe(false)
    expect(isNamespace("")).toBe(false)
    expect(isNamespace("Progress")).toBe(false) // case-sensitive
    expect(isNamespace("results ")).toBe(false) // no trimming
    expect(isNamespace("bogus")).toBe(false)
  })
})

/* The "real work" half of adapterFor (lines 97-136) had zero coverage from any
   test in this file or elsewhere in the repo — grepped every *.test.ts for
   `adapterFor("cost")` and `adapterFor("trace")` fed a non-`ui:` span and found
   none. Every existing case above only ever exercises the narration branch
   (`readUi` returning non-null). That left the cost/trace shape, the
   tokens/serpCalls/unlockerCalls counters, and the results/progress/agent
   default-to-null branch completely unexercised — the exact code a broken
   meter or a mis-shaped trace row would come from. */

function workSpan(over: Partial<Span> = {}): Span {
  return {
    runId: "r1",
    seq: 1,
    ts: "2026-08-04T00:00:00.000Z",
    agentId: "sweep",
    parentId: null,
    kind: "search",
    name: "brightdata-serp",
    argsDigest: "q=site:example.com",
    ms: 120,
    ok: true,
    usd: 0.002,
    runningUsd: 0.002,
    ...over,
  } as Span
}

describe("adapterFor — real work", () => {
  it("builds a cost frame from the running total and counts a search as one serpCall", () => {
    const adapt = adapterFor("cost")
    const frame = adapt(workSpan({ kind: "search", tokensIn: 10, tokensOut: 5, runningUsd: 0.05 }))

    expect(frame).toEqual({
      round: 1,
      usd: 0.05,
      tokens: 15,
      serpCalls: 1,
      unlockerCalls: 0,
    })
  })

  it("counts a fetch named unlocker as an unlockerCall, and any other fetch as neither", () => {
    const adapt = adapterFor("cost")

    adapt(workSpan({ kind: "fetch", name: "unlocker", runningUsd: 0.01 }))
    const afterUnlocker = adapt(workSpan({ kind: "fetch", name: "unlocker", runningUsd: 0.02 })) as {
      serpCalls: number
      unlockerCalls: number
    }
    expect(afterUnlocker).toMatchObject({ serpCalls: 0, unlockerCalls: 2 })

    const afterPlainFetch = adapt(workSpan({ kind: "fetch", name: "raw-fetch", runningUsd: 0.02 })) as {
      serpCalls: number
      unlockerCalls: number
    }
    expect(afterPlainFetch).toMatchObject({ serpCalls: 0, unlockerCalls: 2 })
  })

  it("accumulates tokens and call counts across calls on the same adapter instance", () => {
    // The adapter is stateful by design (the doc comment above adapterFor
    // spells out why: a fresh reader replaying from span 1 must land on the
    // same running counts a reader attached from the start saw) — this pins
    // that a new adapterFor("cost") call starts a fresh, independent count.
    const adapt = adapterFor("cost")
    adapt(workSpan({ kind: "search", tokensIn: 10, tokensOut: 0 }))
    adapt(workSpan({ kind: "search", tokensIn: 0, tokensOut: 20 }))
    const third = adapt(workSpan({ kind: "model", tokensIn: 1, tokensOut: 1, runningUsd: 0.09 })) as {
      tokens: number
      serpCalls: number
    }

    expect(third).toMatchObject({ tokens: 32, serpCalls: 2 })
    expect(adapterFor("cost")(workSpan({ kind: "search" }))).toMatchObject({ tokens: 0, serpCalls: 1 })
  })

  it("builds a trace row carrying the span's own identity, and omits error when there is none", () => {
    const frame = adapterFor("trace")(
      workSpan({ seq: 7, ts: "t7", agentId: "plan", name: "web_search", kind: "search", ok: true, usd: 0.003, runningUsd: 0.09 }),
    )

    expect(frame).toEqual({
      seq: 7,
      ts: "t7",
      round: 1,
      agent: "plan",
      tool: "web_search",
      kind: "search",
      argsDigest: "q=site:example.com",
      ms: 120,
      ok: true,
      usd: 0.003,
      runningUsd: 0.09,
    })
  })

  it("carries error onto a trace row exactly when the span failed with one", () => {
    const frame = adapterFor("trace")(workSpan({ ok: false, error: "timeout" })) as Record<string, unknown>
    expect(frame.error).toBe("timeout")
  })

  it("drops a real span read through results, progress or agent instead of leaking a work payload", () => {
    // Only `cost` and `trace` derive a frame from real work; the other three
    // namespaces carry narration only (the doc comment's "(default)" row), so
    // a real span read through them must fall through to null rather than
    // leaking a work payload where only `ui:`-prefixed frames belong.
    for (const ns of ["results", "progress", "agent"] as const) {
      expect(adapterFor(ns)(workSpan())).toBeNull()
    }
  })
})
