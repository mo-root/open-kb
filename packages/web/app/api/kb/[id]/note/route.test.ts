import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GET } from "./route"

/**
 * The one route of the four with logic of its own beyond `findKb` plus a
 * transformer: it reads `?path=` off the URL and 400s when it is absent,
 * before `findKb` is even asked. `noteOf` itself is pinned in
 * `kb-from-run.test.ts`; this covers the query-param wiring around it —
 * untested anywhere, per `kb-lookup.test.ts`'s own comment.
 */

const UUID = "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704"
/** `noteOf`'s constant for the anchor's own note — see kb-from-run.ts. */
const ANCHOR_PATH = "company.md"

function sweepResult() {
  return {
    anchor: "resend.com",
    decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
    queries: [],
    entities: [],
    edges: [],
    stats: { queries: 4, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, serpCalls: 0, unlockerCalls: 0, usd: 0, seconds: 1 },
    report: {},
  }
}

function req(id: string, path?: string): [Request, { params: Promise<{ id: string }> }] {
  const url = path ? `https://kb.test/api/kb/${id}/note?path=${encodeURIComponent(path)}` : `https://kb.test/api/kb/${id}/note`
  return [new Request(url), { params: Promise.resolve({ id }) }]
}

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-kb-note-route-"))
  for (const k of ["OPENKB_RUNS_DIR", "OPENKB_DEMO", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    saved[k] = process.env[k]
  }
  process.env.OPENKB_RUNS_DIR = dir
  process.env.OPENKB_DEMO = ""
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SECRET_KEY

  await writeFile(
    path.join(dir, `run-${UUID}.json`),
    JSON.stringify({
      id: UUID,
      domain: "resend.com",
      queries: 4,
      startedAt: 0,
      endedAt: 1,
      status: "complete",
      result: sweepResult(),
    }),
    "utf8",
  )
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
})

describe("GET /api/kb/[id]/note", () => {
  it("400s when ?path= is missing, before findKb is even asked", async () => {
    // A bad id AND no path: if this answered 404 instead, the route would be
    // checking existence before shape, which is the wrong order — a caller
    // who forgot the query string should be told that regardless of the id.
    const res = await GET(...req("not-a-real-id"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "path is required" })
  })

  it("404s an id that names no run", async () => {
    const res = await GET(...req("00000000-0000-4000-8000-000000000000", ANCHOR_PATH))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "no such knowledge base" })
  })

  it("404s a path that names nothing on a real run", async () => {
    const res = await GET(...req(UUID, "players/no-such-host.md"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "nothing at players/no-such-host.md" })
  })

  it("answers with noteOf's view for a path that exists", async () => {
    const res = await GET(...req(UUID, ANCHOR_PATH))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; title: string }
    expect(body.path).toBe(ANCHOR_PATH)
    expect(body.title).toBe("resend.com")
  })
})
