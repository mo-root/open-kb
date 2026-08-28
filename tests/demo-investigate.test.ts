import { describe, expect, it } from "vitest"
import { demoRunRecord } from "../scripts/demo-investigate.js"

/**
 * `demoRunRecord` — the JSON shape `pnpm tsx scripts/demo-investigate.ts`
 * writes to `runs/demo-<slug>-<stamp>.json` — had no test anywhere. The
 * whole file ran at import time (a live BrightData/OpenRouter call via
 * top-level `await investigate`), so nothing in it was reachable from a test
 * process. Coverage gap found sweeping `scripts/*.ts beyond sweep.ts` for
 * the same "zero test coverage" class already fixed in audit.ts,
 * diff-runs.ts, read.ts, recall.ts, calibrate-kernel.ts, bakeoff.ts,
 * export-kb.ts and discover.ts (discover.test.ts's own comment names that
 * exact list; this file was the one it left out). Gated the CLI body behind
 * the same `invokedDirectly` guard those files use, un-indented per the
 * house convention (batch.ts/bench.ts/bakeoff.ts) — the `outPath` template
 * literal stays byte-identical to before, since packages/web/lib/
 * runs.test.ts's writer-shape scan reads it straight off the source and a
 * reshaped line would have failed that guard, not this one.
 */

describe("demoRunRecord", () => {
  const out = { nodes: 12, edges: 30, usd: 0.42, summary: "a market" }

  it("counts spans by kind and ok, independent of stats.nodes/edges", () => {
    const spanLog = [
      { kind: "search", ok: true },
      { kind: "search", ok: false },
      { kind: "fetch", ok: true },
      { kind: "assess", ok: true },
    ]
    const rec = demoRunRecord({
      anchor: "resend.com",
      out,
      elapsed: 61.4,
      pagesFetched: 7,
      spanLog,
      nodes: [{ id: "n1" }],
      edges: [{ from: "a", to: "b" }],
    })
    expect(rec.stats).toEqual({
      nodes: 12,
      edges: 30,
      usd: 0.42,
      seconds: 61.4,
      pagesFetched: 7,
      spans: 4,
      searches: 2,
      fetches: 1,
      failures: 1,
    })
    expect(rec.anchor).toBe("resend.com")
    expect(rec.summary).toBe("a market")
    expect(rec.spans).toBe(spanLog)
  })

  it("does not divide by the span count anywhere, so an empty spanLog is all zeros, not NaN", () => {
    const rec = demoRunRecord({
      anchor: "resend.com",
      out,
      elapsed: 0,
      pagesFetched: 0,
      spanLog: [],
      nodes: [],
      edges: [],
    })
    expect(rec.stats).toEqual({
      nodes: 12,
      edges: 30,
      usd: 0.42,
      seconds: 0,
      pagesFetched: 0,
      spans: 0,
      searches: 0,
      fetches: 0,
      failures: 0,
    })
  })
})
