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

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
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

    const url = (f.mock.calls[0] as unknown as [string])[0]
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

  /* A FAILED RUN IS A RUN, and the rule above used to swallow it.

     `toStored` returned null for any row with no `result`, and `failRun` never
     writes one — it writes `status: "failed"` and a reason. So a run that
     crashed, was cancelled, or hit the spend ceiling was readable from exactly
     one place in the world: the process that had happened to run it. Every
     other instance was told "no such run", which is not merely unhelpful, it is
     false, and the client acts on it — `runIsOver()` reads a 404 as "cannot
     tell, keep reading", so the page that started the run spins for ever over a
     run that is definitively over.

     The second half of these is the leak that keeping the row opens. The column
     carries the operator's cause as well as the reader's sentence, which was
     safe only while nothing read the column back. */
  describe("a row for a run that failed", () => {
    const NOTICE =
      "the server could not handle this request — quote ref a1b2c3d4e5f6, the server log has the cause"
    const CAUSE =
      "Error: OpenRouter 401 no auth credentials found (request_id 0f3c9ab2, key sk-or-v1-2b7d)\n    at sweep (/app/sweep.ts:1:1)"
    const LEAKS = ["sk-or-v1-2b7d", "0f3c9ab2", "OpenRouter", "no auth credentials"]

    function row(over: Record<string, unknown> = {}) {
      return {
        id: "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704",
        domain: "resend.com",
        queries: 12,
        status: "failed",
        started_at: "2026-08-03T00:00:00Z",
        ended_at: "2026-08-03T00:04:00Z",
        error: `${NOTICE}\ncause: ${CAUSE}`,
        result: null,
        ...over,
      }
    }

    function serving(rows: unknown[]) {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })))
    }

    it("reads back as a failure rather than as nothing at all", async () => {
      serving([row()])
      const got = await (await load()).getRunRow("9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704")

      expect(got).not.toBeNull()
      expect(got?.status).toBe("failed")
      expect(got?.domain).toBe("resend.com")
      // Absent, not an empty map. A zeroed `SweepResult` would render as a
      // market this deployment searched and found nothing in, which is a
      // measurement and the wrong one.
      expect(got?.result).toBeUndefined()
      expect(got?.endedAt).toBe(Date.parse("2026-08-03T00:04:00Z"))
    })

    it("hands over the reader's sentence and never the provider's words", async () => {
      serving([row()])
      const got = await (await load()).getRunRow("9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704")

      expect(got?.error).toBe(NOTICE)
      for (const leak of LEAKS) expect(got?.error ?? "").not.toContain(leak)
      // The ref is the whole point of the sentence: it is what joins what the
      // reader can see to the line in the log that has the cause.
      expect(got?.error).toMatch(/quote ref [0-9a-f]{12}/)
    })

    it("is listed, so a gallery can show it", async () => {
      serving([row()])
      const listed = await (await load()).listRuns()
      expect(listed).toHaveLength(1)
      expect(listed[0]?.status).toBe("failed")
    })

    it("survives a column written before the cause was appended", async () => {
      // Rows already in the table, and anything else that ever writes this
      // column. No separator means the whole value is the notice.
      serving([row({ error: "Stopped. Everything found before you stopped it is kept." })])
      const got = await (await load()).getRunRow("9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704")
      expect(got?.error).toBe("Stopped. Everything found before you stopped it is kept.")
    })

    it("KEEPS a running row, because the browser watching it is always somewhere else", async () => {
      // This assertion is the inverse of what it used to be, and the reversal
      // is the fix rather than a relaxation of it.
      //
      // It read `toBeNull()` on the reasoning that an unfinished run is not a
      // readable map. True of the GALLERY, and `listRuns` still enforces it —
      // there is a test for that above. False of `getRunRow`, whose caller is
      // the stream route asking "is this id real?" about a run that is, by
      // definition, still running.
      //
      // Measured on the deployment with the old rule in place: POST /api/map
      // returned an id, the browser opened /api/run/<id>/stream, that request
      // landed on an instance whose registry had never heard of the run, it
      // fell through to Postgres, Postgres said null — and the browser was
      // told `{"error":"no such run"}` about a run that was working perfectly.
      // Zero frames for three minutes, then a finished map appearing in the
      // gallery with no explanation.
      serving([row({ status: "running", ended_at: null, error: null })])
      const stored = await (await load()).getRunRow("9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704")
      expect(stored?.status).toBe("running")
      // And it carries no result, because there is not one yet. A reader must
      // be able to tell "running" from "finished with an empty map".
      expect(stored?.result).toBeUndefined()
    })

    it("joins the two halves of the column in one place, so nothing has to spell the separator", async () => {
      // The write side of the same fact. `failRun` calls this rather than
      // building the string itself, which is what keeps `noticeIn` able to find
      // the joint it is looking for.
      const column = (await load()).errorColumn(NOTICE, new Error("boom"))
      expect(column.startsWith(`${NOTICE}\ncause: `)).toBe(true)
      expect(column).toContain("boom")
    })
  })
})
