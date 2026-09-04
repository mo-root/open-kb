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
   * `config()`'s `url.replace(/\/+$/, "")` had no test anywhere — every other
   * test in this file stubs `SUPABASE_URL` bare, with no trailing slash, so
   * the strip could be deleted and the whole suite would stay green. A
   * Supabase project's dashboard shows the URL as
   * `https://xyz.supabase.co/`, one click from a copy-paste into `.env`, and
   * `rest()` builds every request as `${cfg.url}/rest/v1/${path}` — without
   * the strip that becomes `https://xyz.supabase.co//rest/v1/runs`, which
   * PostgREST does not treat as the same route as the single-slash form.
   * Coverage gap found sweeping web/lib/store (D-scope: "areas nobody has
   * swept"), same file SELF-12/139-adjacent tests already covered other
   * branches of.
   */
  it("strips trailing slashes from SUPABASE_URL so the REST path never doubles up", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co///")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    const f = vi.fn(async () => new Response("[]", { status: 200 }))
    vi.stubGlobal("fetch", f)
    await (await load()).listRuns()
    const url = (f.mock.calls[0] as unknown as [string])[0]
    expect(url).toBe("https://x.supabase.co/rest/v1/runs?select=*&order=started_at.desc&limit=100")
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

  /**
   * `getSpans` had its unconfigured path (line 78) and its network-throw path
   * (line 96) under test, but never the non-2xx branch — `if (!res || !res.ok)
   * return []` reads as one line and only half of it had a test driving it.
   * Same shape as `listRuns`'s and `countRunsSince`'s own non-2xx tests above.
   *
   * The body carries a real span rather than an empty or malformed one:
   * `quiet()` catches a `.json()` parse failure too, so a body of `"nope"` or
   * `"[]"` would read [] from EITHER branch and pass whether `.ok` is checked
   * or not. Only a well-formed body with content makes the two branches
   * disagree — checked `.ok` drops it, an unchecked one would return it — so
   * this is the one shape that actually exercises the status check rather
   * than `quiet`'s catch-all.
   *
   * Coverage gap found sweeping web/lib/store (D-scope: "areas nobody has
   * swept").
   */
  it("returns an empty list rather than the body, when the store answers non-2xx", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([{ span: span(8) }]), { status: 500 }),
    ))
    expect(await (await load()).getSpans("r1")).toEqual([])
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

  it("is null when no row matches the id, rather than throwing on the empty array", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("SUPABASE_SECRET_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })))
    expect(await (await load()).getRunRow("no-such-id")).toBeNull()
  })

  /**
   * `listRuns` had its unconfigured path and its running-row-dropped path
   * under test, but never the non-2xx branch, the `limit` param it builds
   * into the query, or a listing of more than one row — so the `flatMap`
   * that is the whole point of the function (drop running, drop anything
   * `toStored` cannot read, keep the rest) had never run over a mix.
   * Coverage gap found sweeping web/lib/store (D-scope: "areas nobody has
   * swept"), same file B1-B4/SELF-12 already covered other branches of.
   */
  describe("listRuns", () => {
    it("returns an empty list rather than throwing when the store answers non-2xx", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })))
      expect(await (await load()).listRuns()).toEqual([])
    })

    it("passes the limit through to the query, defaulting to 100", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      const f = vi.fn(async () => new Response("[]", { status: 200 }))
      vi.stubGlobal("fetch", f)
      const db = await load()

      await db.listRuns()
      expect((f.mock.calls[0] as unknown as [string])[0]).toContain("limit=100")

      await db.listRuns(7)
      expect((f.mock.calls[1] as unknown as [string])[0]).toContain("limit=7")
    })

    it("keeps complete and failed rows but drops running ones, in one listing", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
        { id: "r1", domain: "a.com", queries: 4, status: "complete", started_at: "2026-08-03T00:00:00Z", result: { entities: [], edges: [] } },
        { id: "r2", domain: "b.com", queries: 2, status: "running", started_at: "2026-08-03T00:01:00Z", result: null },
        { id: "r3", domain: "c.com", queries: 6, status: "failed", started_at: "2026-08-03T00:02:00Z", result: null, error: "the run failed" },
      ]), { status: 200 })))
      const listed = await (await load()).listRuns()

      expect(listed.map((r) => r.id)).toEqual(["r1", "r3"])
      expect(listed.every((r) => r.status !== "running")).toBe(true)
    })

    // toStored's guard (supabase.ts:418) is `!r.result && status !== "failed"
    // && status !== "running"` — and RunStatus is only those three values, so
    // the guard's one remaining shape is "complete" with no result. Every
    // existing fixture pairs complete with a real result and running/failed
    // with null, so this row (a write that set status before result, then
    // never got the second write) had never reached the guard's true branch.
    it("drops a row marked complete with no result, rather than render an empty map for it", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
        { id: "r1", domain: "a.com", queries: 4, status: "complete", started_at: "2026-08-03T00:00:00Z", result: { entities: [], edges: [] } },
        { id: "r2", domain: "b.com", queries: 2, status: "complete", started_at: "2026-08-03T00:01:00Z", result: null },
      ]), { status: 200 })))
      const listed = await (await load()).listRuns()

      expect(listed.map((r) => r.id)).toEqual(["r1"])
    })
  })

  /**
   * `upsertRun` and `appendSpans` had only the unconfigured path and the
   * throw path under test — never the configured, 2xx-request-shape path,
   * nor the branch that logs a non-2xx response instead of throwing (the
   * write must never end the run over a store hiccup; see `quiet`'s own
   * doc comment). Coverage gap found sweeping web/lib/store (D-scope:
   * "areas nobody has swept"), same file SELF-12 already covered for
   * countRunsSince/claimRun.
   */
  describe("upsertRun", () => {
    it("posts a merge-duplicates upsert with an updated_at stamp", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      const f = vi.fn(async () => new Response("", { status: 201 }))
      vi.stubGlobal("fetch", f)
      await (await load()).upsertRun({
        id: "r1", domain: "a.com", queries: 4, status: "complete", started_at: "2026-08-03T00:00:00Z",
      })

      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain("/rest/v1/runs")
      expect((init.headers as Record<string, string>).Prefer).toContain("resolution=merge-duplicates")
      const [body] = JSON.parse(init.body as string) as Record<string, unknown>[]
      expect(body).toMatchObject({ id: "r1", domain: "a.com", status: "complete" })
      expect(typeof body!.updated_at).toBe("string")
    })

    it("logs but does not throw when the store answers non-2xx", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => new Response("conflict", { status: 409 })))
      await expect(
        (await load()).upsertRun({ id: "r1", domain: "a.com", queries: 4, status: "complete", started_at: "x" }),
      ).resolves.toBeUndefined()
      expect(err).toHaveBeenCalledWith(expect.stringContaining("upsertRun 409"))
    })
  })

  describe("appendSpans", () => {
    it("logs but does not throw when the store answers non-2xx", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })))
      await expect((await load()).appendSpans("r1", [span(0)])).resolves.toBeUndefined()
      expect(err).toHaveBeenCalledWith(expect.stringContaining("appendSpans 500"))
    })
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

    // D-scope, self-discovered: `errorColumn`'s cause branch had one test, and
    // it only ever passed `new Error(...)`, which is `instanceof Error` AND has
    // a `.stack` — so neither of its two other outcomes (a thrown value that is
    // not an Error at all, or an Error whose `.stack` V8 never populated) had
    // run. `failRun(id, error: unknown)` hands this whatever the sweep threw,
    // and `throw` accepts any value in JS — a rejected fetch or an aborted
    // stream can reject with a plain string or object, not only an Error.
    it("stringifies the cause when it was never an Error", async () => {
      const column = (await load()).errorColumn(NOTICE, "socket hang up")
      expect(column).toBe(`${NOTICE}\ncause: socket hang up`)
    })

    it("falls back to the message when an Error has no stack", async () => {
      const cause = new Error("boom")
      cause.stack = undefined
      const column = (await load()).errorColumn(NOTICE, cause)
      expect(column).toBe(`${NOTICE}\ncause: boom`)
    })
  })

  /**
   * `countRunsSince` and `claimRun` had zero tests despite both gating real
   * money: `lib/public-runs.ts` treats a `null` count as "refuse the run" and
   * `lib/spend-limits.ts` treats anything but `{kind: "claimed"}` as "refuse
   * the run" — see the doctrine comments on both in supabase.ts explaining why
   * "could not tell" must never collapse into "nothing today". Coverage gap
   * found sweeping web/lib/store (D-scope: "areas nobody has swept").
   */
  describe("countRunsSince", () => {
    it("is null, not zero, when unconfigured — a full allowance must never come from a laptop", async () => {
      vi.stubEnv("SUPABASE_URL", "")
      vi.stubEnv("SUPABASE_SECRET_KEY", "")
      const f = vi.fn()
      vi.stubGlobal("fetch", f)
      expect(await (await load()).countRunsSince("2026-08-03T00:00:00Z")).toBeNull()
      expect(f).not.toHaveBeenCalled()
    })

    it("reads the total out of Content-Range", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response("[]", { status: 200, headers: { "content-range": "0-0/137" } }),
      ))
      expect(await (await load()).countRunsSince("2026-08-03T00:00:00Z")).toBe(137)
    })

    it("reads zero from the `*/0` shape PostgREST sends for no match", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response("[]", { status: 200, headers: { "content-range": "*/0" } }),
      ))
      expect(await (await load()).countRunsSince("2026-08-03T00:00:00Z")).toBe(0)
    })

    it("is null, never zero, when the header is missing or unparseable", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })))
      expect(await (await load()).countRunsSince("2026-08-03T00:00:00Z")).toBeNull()
    })

    it("is null when the store answers non-2xx", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })))
      expect(await (await load()).countRunsSince("2026-08-03T00:00:00Z")).toBeNull()
    })

    it("is null rather than throwing on a network failure", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED") }))
      expect(await (await load()).countRunsSince("2026-08-03T00:00:00Z")).toBeNull()
    })
  })

  describe("claimRun", () => {
    const ARGS = {
      id: "r1",
      domain: "a.com",
      queries: 4,
      startedAt: "2026-08-03T00:00:00Z",
      visitor: "h:abc",
      since: "2026-08-03T00:00:00Z",
      windowMs: 86_400_000,
      runCapUsd: 1,
      dayCapUsd: 10,
      perVisitorPerDay: 3,
      atOnce: 2,
    }

    it("is unconfigured without a round trip when the store has no key", async () => {
      vi.stubEnv("SUPABASE_URL", "")
      vi.stubEnv("SUPABASE_SECRET_KEY", "")
      const f = vi.fn()
      vi.stubGlobal("fetch", f)
      expect(await (await load()).claimRun(ARGS)).toEqual({ kind: "unconfigured" })
      expect(f).not.toHaveBeenCalled()
    })

    it("claims against rpc/claim_run and reports the counts Postgres computed", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      const f = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, by_visitor: 1, spent_usd: 0.4, in_flight: 1 }), { status: 200 }),
      )
      vi.stubGlobal("fetch", f)
      const got = await (await load()).claimRun(ARGS)

      expect(got).toEqual({ kind: "claimed", byVisitor: 1, spentUsd: 0.4, inFlight: 1 })
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain("/rest/v1/rpc/claim_run")
      const body = JSON.parse(init.body as string)
      expect(body).toMatchObject({ p_id: "r1", p_domain: "a.com", p_at_once: 2 })
    })

    it("defaults each count to 0 rather than NaN, when a count is missing or unreadable", async () => {
      // supabase.ts:289-291's `Number(x) || 0` guards a count that is present
      // but not numeric — a function deployed from an older schema.sql, or any
      // other jsonb producer, could send a string or omit a field entirely
      // (`Number(undefined)` is NaN, same as `Number("not-a-number")`; both
      // want the same 0). Every test above always supplies all three as real
      // numbers, so this fallback had never run.
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, spent_usd: "not-a-number" }), { status: 200 }),
      ))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "claimed", byVisitor: 0, spentUsd: 0, inFlight: 0 })
    })

    it("is refused with the limit Postgres named, when the transaction says no", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, limit: "day", by_visitor: 3, spent_usd: 10, in_flight: 0 }), { status: 200 }),
      ))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "refused", limit: "day", byVisitor: 3, spentUsd: 10, inFlight: 0 })
    })

    it("is unavailable, never refused, when Postgres declines without naming a limit", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, by_visitor: 0, spent_usd: 0, in_flight: 0 }), { status: 200 }),
      ))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "unavailable", why: "the store refused a run without saying which limit" })
    })

    it("names the missing migration on a 404, rather than reading as an outage", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({
        kind: "unavailable",
        why: "this deployment has no claim_run function — re-run scripts/supabase-schema.sql",
      })
    })

    it("is unavailable on any other non-2xx", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "unavailable", why: "the store answered 500" })
    })

    it("still names the status, even when the error body itself fails to read", async () => {
      // supabase.ts:270's `res.text().catch(() => "")` is a second, inner catch
      // nested inside the one at supabase.ts:299 — every non-2xx test above uses
      // a real `Response` whose `.text()` always resolves, so that inner catch
      // had never run. A body stream that errors mid-read (connection dropped
      // after the status line but before the body finishes) is a real fetch
      // failure, not a hypothetical one, and without its own catch the rejection
      // would escape to the OUTER catch instead — reporting "the store could not
      // be reached" for a request that did reach the store and answer 500, and
      // for a 404 losing the one message an operator can act on (re-run the
      // migration).
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const brokenBody = new ReadableStream({
        start(controller) {
          controller.error(new Error("stream broke"))
        },
      })
      vi.stubGlobal("fetch", vi.fn(async () => new Response(brokenBody, { status: 500 })))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "unavailable", why: "the store answered 500" })
      expect(errorSpy).toHaveBeenCalledWith("[supabase] claimRun 500: ")
    })

    it("is unavailable, not claimed, when the body has no readable `ok`", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 })))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "unavailable", why: "the store answered something the budget could not read" })
    })

    it("is unavailable rather than throwing on a network failure — the fallback must never spend", async () => {
      vi.stubEnv("SUPABASE_URL", "https://x.supabase.co")
      vi.stubEnv("SUPABASE_SECRET_KEY", "k")
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED") }))
      const got = await (await load()).claimRun(ARGS)
      expect(got).toEqual({ kind: "unavailable", why: "the store could not be reached" })
    })
  })
})
