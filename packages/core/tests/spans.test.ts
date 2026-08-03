import { describe, it, expect } from "vitest"
import { SpanStream } from "../src/spans.js"

const base = { runId: "r1", agentId: "lead", parentId: null, ms: 10, ok: true, usd: 0 }

describe("SpanStream", () => {
  it("numbers spans monotonically and accumulates cost", () => {
    const s = new SpanStream(() => "2026-08-03T10:00:00.000Z")
    const a = s.emit({ ...base, kind: "search", name: "serp", argsDigest: "web scraping api", usd: 0.002 })
    const b = s.emit({ ...base, kind: "fetch", name: "unlock", argsDigest: "https://a.com", usd: 0.01 })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.runningUsd).toBeCloseTo(0.002)
    expect(b.runningUsd).toBeCloseTo(0.012)
    expect(s.totalUsd()).toBeCloseTo(0.012)
  })

  it("emits a span for a failure, with the reason in words", () => {
    const s = new SpanStream()
    const sp = s.emit({ ...base, kind: "fetch", name: "unlock", argsDigest: "https://stripe.com/radar",
                        ok: false, error: "blocked: empty-body after 51s" })
    expect(sp.ok).toBe(false)
    expect(sp.error).toContain("empty-body")
  })

  it("refuses to record a non-finite cost rather than reporting a healthy zero", () => {
    const s = new SpanStream()
    const sp = s.emit({ ...base, kind: "model", name: "flash", argsDigest: "turn 3", usd: Number.NaN })
    expect(sp.usd).toBe(0)
    expect(sp.ok).toBe(false)
    expect(sp.error).toContain("non-finite cost")
    expect(s.totalUsd()).toBe(0)
  })

  it("delivers spans to an async consumer and ends when closed", async () => {
    const s = new SpanStream()
    const got: number[] = []
    const consumer = (async () => {
      for await (const sp of s.stream()) got.push(sp.seq)
    })()
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "a" })
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "b" })
    s.close()
    await consumer
    expect(got).toEqual([1, 2])
  })

  it("ends immediately for a consumer that starts iterating after close()", async () => {
    const s = new SpanStream()
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "a" })
    s.close()
    const got: number[] = []
    for await (const sp of s.stream()) got.push(sp.seq)
    // Spans emitted before close, but before iteration too, are still delivered in order —
    // closing does not discard the backlog, it only stops new waits from hanging.
    expect(got).toEqual([1])
  })

  it("delivers spans emitted before iteration begins, in order", async () => {
    const s = new SpanStream()
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "a" })
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "b" })
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "c" })
    const got: number[] = []
    const consumer = (async () => {
      for await (const sp of s.stream()) got.push(sp.seq)
    })()
    s.close()
    await consumer
    expect(got).toEqual([1, 2, 3])
  })
})
