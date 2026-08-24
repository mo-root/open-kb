import { describe, it, expect } from "vitest"
import { SpanStream } from "@open-kb/core"
import { emitUi, readUi, UI_PREFIX } from "../src/ui.js"

/**
 * `readUi`'s OWN DEFENSIVE BRANCHES had zero direct test anywhere. It is
 * consumed at two real call sites — `packages/web/lib/stream-adapter.ts` and
 * `scripts/sweep.ts` — and both route its `null` return down the SAME path a
 * genuine work span takes: `adapterFor` (stream-adapter.ts:74) only treats a
 * span as narration `if (ui)`, so `null` is not an edge case those callers
 * merely tolerate, it is the switch that keeps a torn frame from vanishing
 * into a namespace nobody reads or from crashing the log's own replay.
 *
 * `readUi`'s own doc comment states the contract precisely: "a malformed
 * payload is also `null`... a torn frame must degrade to one missing line,
 * never to a thrown adapter that takes the whole stream down with it." Every
 * existing test (`fixture.ts`, `rank-think.test.ts`) only ever calls it on
 * frames `emitUi` itself produced — the happy path. This is the unhappy one.
 */
describe("readUi degrades a torn or foreign frame to null, never a throw", () => {
  it("passes through a real-work span untouched — its name never wore the ui: prefix", () => {
    const spans = new SpanStream()
    const span = spans.emit({
      runId: "r", agentId: "rank", parentId: null,
      kind: "model", name: "classify", argsDigest: "not json at all {{{",
      ms: 12, ok: true, usd: 0.001,
    })
    expect(readUi(span)).toBeNull()
  })

  it("returns the frame for a namespace it teaches", () => {
    const spans = new SpanStream()
    emitUi(spans, "r", "progress", "rank", { stage: "search" })
    const span = spans.emit({
      runId: "r", agentId: "rank", parentId: null,
      kind: "remember", name: `${UI_PREFIX}progress`, argsDigest: JSON.stringify({ stage: "search" }),
      ms: 0, ok: true, usd: 0,
    })
    expect(readUi(span)).toEqual({ ns: "progress", frame: { stage: "search" } })
  })

  it("refuses a namespace the prefix wears but the vocabulary never taught", () => {
    // `cost` and `trace` are deliberately absent from UiNamespace — see ui.ts's
    // own comment: both are derived from real spans, so nothing may inject one
    // by hand. A span claiming to be `ui:cost` must fall through as null, the
    // same as an outright typo would.
    const spans = new SpanStream()
    const span = spans.emit({
      runId: "r", agentId: "rank", parentId: null,
      kind: "remember", name: `${UI_PREFIX}cost`, argsDigest: JSON.stringify({ usd: 99 }),
      ms: 0, ok: true, usd: 0,
    })
    expect(readUi(span)).toBeNull()
  })

  it("degrades malformed JSON to null instead of throwing out of the adapter", () => {
    const spans = new SpanStream()
    const span = spans.emit({
      runId: "r", agentId: "rank", parentId: null,
      kind: "remember", name: `${UI_PREFIX}agent`, argsDigest: "{not valid json",
      ms: 0, ok: true, usd: 0,
    })
    expect(readUi(span)).toBeNull()
  })

  it("refuses a payload that parsed but is not an object — a bare string or number", () => {
    const spans = new SpanStream()
    for (const digest of ['"just a string"', "42", "null", "true"]) {
      const span = spans.emit({
        runId: "r", agentId: "rank", parentId: null,
        kind: "remember", name: `${UI_PREFIX}results`, argsDigest: digest,
        ms: 0, ok: true, usd: 0,
      })
      expect(readUi(span)).toBeNull()
    }
  })

  it("refuses a payload that parsed to an array — an object is the contract, not just non-null", () => {
    const spans = new SpanStream()
    const span = spans.emit({
      runId: "r", agentId: "rank", parentId: null,
      kind: "remember", name: `${UI_PREFIX}agent`, argsDigest: JSON.stringify([1, 2, 3]),
      ms: 0, ok: true, usd: 0,
    })
    expect(readUi(span)).toBeNull()
  })
})
