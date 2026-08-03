import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Span } from "@open-kb/core"

/** Fresh module per test: `configured()` reads env, and vitest caches modules. */
async function load() {
  vi.resetModules()
  return import("./supabase")
}

function span(seq: number): Span {
  return {
    seq,
    ts: "2026-08-03T00:00:00.000Z",
    runId: "r1",
    agentId: "sweep",
    parentId: null,
    kind: "search",
    name: "serp",
    argsDigest: "proxy network",
    ms: 10,
    ok: true,
    usd: 0.0015,
    runningUsd: 0.0015,
  }
}

describe("the supabase store", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("reports itself unconfigured when either variable is missing", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "")
    expect((await load()).configured()).toBe(false)
  })

  /**
   * The whole fallback contract. Every call site does `if (db.configured())`,
   * but a store that threw on an unset key would still take a route down
   * through any path that forgot to ask.
   */
  it("writes nothing and returns empty when unconfigured, rather than throwing", async () => {
    vi.stubEnv("SUPABASE_URL", "")
    vi.stubEnv("SUPABASE_SECRET_KEY", "")
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const db = await load()

    await expect(db.appendSpans("r1", [span(0)])).resolves.toBeUndefined()
    await expect(db.upsertRun({ id: "r1", domain: "a.com", queries: 1, status: "running", started_at: "x" })).resolves.toBeUndefined()
    await expect(db.listRuns()).resolves.toEqual([])
    await expect(db.getSpans("r1")).resolves.toEqual([])
    await expect(db.getRunRow("r1")).resolves.toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  /**
   * A store that is down must never end a run. By the time a span is written
   * the SERP call it describes is already paid for, so losing the bookkeeping
   * is strictly better than losing the run.
   */
  it("swallows a network failure", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED") }))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const db = await load()

    await expect(db.appendSpans("r1", [span(0)])).resolves.toBeUndefined()
    await expect(db.getSpans("r1")).resolves.toEqual([])
  })

  it("skips the round trip for an empty batch", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    await (await load()).appendSpans("r1", [])
    expect(f).not.toHaveBeenCalled()
  })

  it("appends spans keyed by (run_id, seq) so a retried batch cannot duplicate", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    const f = vi.fn(async () => new Response("", { status: 201 }))
    vi.stubGlobal("fetch", f)
    await (await load()).appendSpans("r1", [span(0), span(1)])

    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toContain("/rest/v1/run_spans")
    expect((init.headers as Record<string, string>).Prefer).toContain("ignore-duplicates")
    const body = JSON.parse(init.body as string) as { run_id: string; seq: number }[]
    expect(body.map((r) => r.seq)).toEqual([0, 1])
    expect(body.every((r) => r.run_id === "r1")).toBe(true)
  })

  it("asks for spans past the client's cursor, exclusive and in order", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    const f = vi.fn(async () => new Response(JSON.stringify([{ span: span(8) }]), { status: 200 }))
    vi.stubGlobal("fetch", f)
    const out = await (await load()).getSpans("r1", 7)

    const url = f.mock.calls[0]![0] as string
    expect(url).toContain("seq=gt.7")
    expect(url).toContain("order=seq.asc")
    expect(out[0]!.seq).toBe(8)
  })

  /** A row without a result is a run that has not finished. Listing it would
   *  put a card in the gallery that opens onto nothing. */
  it("does not present an unfinished run as a readable one", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: "r1", domain: "a.com", queries: 4, status: "running", started_at: "2026-08-03T00:00:00Z", result: null },
    ]), { status: 200 })))
    expect(await (await load()).listRuns()).toEqual([])
  })
})
