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

  it("defaults cost to 0 when the caller omits usd entirely, not just when it's NaN", () => {
    // SpanInput.usd is optional (`usd?: number`) — every call site in this repo
    // always passes a number, so `?? 0` on line 63 had 0% branch coverage for
    // its undefined side; the NaN test above only exercises the DEFINED
    // (already-a-number) branch, since NaN !== undefined. A future caller that
    // leans on the documented default, e.g. a span kind with no cost concept,
    // must not crash on a missing field or be flagged as a reporting failure
    // the way the non-finite case above is.
    const s = new SpanStream()
    const { usd: _usd, ...baseNoUsd } = base
    const sp = s.emit({ ...baseNoUsd, kind: "read", name: "slice", argsDigest: "h1" })
    expect(sp.usd).toBe(0)
    expect(sp.ok).toBe(true)
    expect(sp.error).toBeUndefined()
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

  it("fans out every span to two consumers started before any emit, in the same order", async () => {
    // A web view, a CLI renderer, and a cost tracker all tap the same run. Each must see the
    // whole log, a shared waiter queue that hands each span to only one consumer would silently
    // split the audit trail, which is the same failure shape as a non-finite cost reading $0.00.
    const s = new SpanStream()
    const got1: number[] = []
    const got2: number[] = []
    const c1 = (async () => {
      for await (const sp of s.stream()) got1.push(sp.seq)
    })()
    const c2 = (async () => {
      for await (const sp of s.stream()) got2.push(sp.seq)
    })()
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "a" })
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "b" })
    s.close()
    await Promise.all([c1, c2])
    expect(got1).toEqual([1, 2])
    expect(got2).toEqual([1, 2])
  })

  it("terminates every attached consumer cleanly when close() fires", async () => {
    const s = new SpanStream()
    const got1: number[] = []
    const got2: number[] = []
    const c1 = (async () => {
      for await (const sp of s.stream()) got1.push(sp.seq)
    })()
    const c2 = (async () => {
      for await (const sp of s.stream()) got2.push(sp.seq)
    })()
    s.close()
    // Both consumers must resolve, neither may be left parked on a waiter nobody wakes.
    await Promise.all([c1, c2])
    expect(got1).toEqual([])
    expect(got2).toEqual([])
  })

  it("a consumer that breaks out early stops accumulating while the other keeps receiving", async () => {
    const s = new SpanStream()
    const got1: number[] = []
    const got2: number[] = []
    const c1 = (async () => {
      for await (const sp of s.stream()) {
        got1.push(sp.seq)
        if (got1.length === 1) break
      }
    })()
    const c2 = (async () => {
      for await (const sp of s.stream()) got2.push(sp.seq)
    })()
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "a" })
    s.emit({ ...base, kind: "search", name: "serp", argsDigest: "b" })
    s.close()
    await Promise.all([c1, c2])
    expect(got1).toEqual([1])
    expect(got2).toEqual([1, 2])
  })
})
