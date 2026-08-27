import { afterEach, describe, expect, it, vi } from "vitest"
import type { Span } from "@open-kb/core"

/**
 * `app/api/run/[id]/stream/route.ts` had no test of its own — the one route
 * `find packages/web/app/api -name route.ts` turns up with no colocated
 * `route.test.ts` beside it, every one of its siblings already covered (this
 * is the same D-scope sweep as SELF-37's `cancel/route.test.ts`, which found
 * the same gap shape one route over). `stream-adapter.test.ts` pins
 * `adapterFor`/`isNamespace` in isolation and `runs.test.ts` pins
 * `createRun`/`getRun`; neither exercises this route's own branching: the
 * `!run` fork that reads Postgres for a run this process no longer holds
 * (spans found, no spans but a row, neither), the namespace/startIndex query
 * parsing shared by both forks, and the live fork's own span-to-frame loop.
 *
 * `@/lib/store/supabase` is mocked down to the three exports this route
 * actually calls (`configured`, `getSpans`, `getRunRow`) — same shape as
 * `public-runs.test.ts`'s mock of the same module, one directory further
 * from it, so the specifier here is the alias the route itself imports
 * rather than that file's relative one; both resolve to the same module.
 */

const configured = vi.fn<() => boolean>()
const getSpans = vi.fn<(id: string) => Promise<Span[]>>()
const getRunRow = vi.fn<(id: string) => Promise<unknown>>()
vi.mock("@/lib/store/supabase", () => ({ configured, getSpans, getRunRow }))

const { GET } = await import("./route")
const { createRun } = await import("@/lib/runs")

function span(seq: number, overrides: Partial<Span> = {}): Span {
  return {
    seq,
    ts: "2026-08-03T00:00:00.000Z",
    runId: "r1",
    agentId: "sweep",
    parentId: null,
    kind: "search",
    name: "serp",
    argsDigest: "acme rivals",
    ms: 10,
    ok: true,
    usd: 0.001,
    runningUsd: 0.001 * seq,
    ...overrides,
  }
}

function req(id: string, qs = ""): [Request, { params: Promise<{ id: string }> }] {
  return [new Request(`https://kb.test/api/run/${id}/stream${qs}`), { params: Promise.resolve({ id }) }]
}

/** Every frame the route wrote, one JSON value per NDJSON line. */
async function frames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  configured.mockReset()
  getSpans.mockReset()
  getRunRow.mockReset()
})

describe("GET /api/run/[id]/stream — a run this process no longer holds", () => {
  it("404s an unknown id with no store configured", async () => {
    configured.mockReturnValue(false)
    const res = await GET(...req("7c3d5e21-0f44-4a88-9bb1-2e6d7c4a1053"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "no such run" })
  })

  it("404s when the store has neither spans nor a row for the id", async () => {
    configured.mockReturnValue(true)
    getSpans.mockResolvedValue([])
    getRunRow.mockResolvedValue(null)
    const res = await GET(...req("00000000-0000-4000-8000-000000000000"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "no such run" })
  })

  it("opens quiet, not 404, when the row exists but no span has landed yet", async () => {
    configured.mockReturnValue(true)
    getSpans.mockResolvedValue([])
    getRunRow.mockResolvedValue({ id: "row" })
    const res = await GET(...req("00000000-0000-4000-8000-000000000000"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
  })

  it("replays stored spans as frames on the requested namespace", async () => {
    configured.mockReturnValue(true)
    getSpans.mockResolvedValue([span(1), span(2, { kind: "fetch", name: "unlocker" })])
    const res = await GET(...req("00000000-0000-4000-8000-000000000000", "?ns=trace"))
    expect(res.status).toBe(200)
    const rows = await frames(res)
    expect(rows.map((r) => r.tool)).toEqual(["serp", "unlocker"])
  })

  it("skips frames already delivered, by startIndex", async () => {
    configured.mockReturnValue(true)
    getSpans.mockResolvedValue([span(1), span(2)])
    const res = await GET(...req("00000000-0000-4000-8000-000000000000", "?ns=trace&startIndex=1"))
    const rows = await frames(res)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.seq).toBe(2)
  })

  it("400s a namespace the adapter does not know", async () => {
    configured.mockReturnValue(true)
    getSpans.mockResolvedValue([span(1)])
    const res = await GET(...req("00000000-0000-4000-8000-000000000000", "?ns=bogus"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown namespace "bogus"' })
  })
})

describe("GET /api/run/[id]/stream — a run still in this process", () => {
  it("streams the run's own spans as frames and closes once the log does", async () => {
    const run = createRun("acme.com", 12)
    run.spans.emit({ runId: run.id, agentId: "sweep", parentId: null, kind: "search", name: "serp", argsDigest: "acme rivals", ms: 5, ok: true, usd: 0.001 })
    run.spans.emit({ runId: run.id, agentId: "sweep", parentId: null, kind: "fetch", name: "unlocker", argsDigest: "https://acme.com", ms: 8, ok: true, usd: 0.002 })
    run.spans.close()

    const res = await GET(...req(run.id, "?ns=trace"))
    expect(res.status).toBe(200)
    const rows = await frames(res)
    expect(rows.map((r) => r.tool)).toEqual(["serp", "unlocker"])
  })

  it("honours startIndex on the live path too, so a reconnect does not double-count", async () => {
    const run = createRun("acme.com", 12)
    run.spans.emit({ runId: run.id, agentId: "sweep", parentId: null, kind: "search", name: "serp", argsDigest: "acme rivals", ms: 5, ok: true, usd: 0.001 })
    run.spans.emit({ runId: run.id, agentId: "sweep", parentId: null, kind: "search", name: "serp", argsDigest: "acme substitutes", ms: 5, ok: true, usd: 0.001 })
    run.spans.close()

    const res = await GET(...req(run.id, "?ns=trace&startIndex=1"))
    const rows = await frames(res)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.argsDigest).toBe("acme substitutes")
  })

  it("400s a namespace the adapter does not know before opening the stream", async () => {
    const run = createRun("acme.com", 12)
    const res = await GET(...req(run.id, "?ns=bogus"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown namespace "bogus"' })
    run.spans.close()
  })
})
