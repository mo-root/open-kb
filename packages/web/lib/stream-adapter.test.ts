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
