import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GET } from "./route"

/**
 * `findKb` (missing/failed id) and `viewOf` (the envelope's shape) are each
 * pinned on their own — `kb-lookup.test.ts`, `kb-from-run.test.ts` — and that
 * file's own comment names this route as one of the four that had never
 * exercised either through its actual HTTP wiring. This is that test.
 */

const UUID = "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704"

function sweepResult() {
  return {
    anchor: "resend.com",
    decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
    queries: [],
    entities: [{ name: "postmarkapp.com", domain: "postmarkapp.com", kind: "company", what: "w", relation: "competitor", why: "y" }],
    edges: [],
    stats: { queries: 4, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, serpCalls: 0, unlockerCalls: 0, usd: 0, seconds: 1 },
    report: {},
  }
}

function req(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [new Request(`https://kb.test/api/kb/${id}`), { params: Promise.resolve({ id }) }]
}

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-kb-id-route-"))
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

describe("GET /api/kb/[id]", () => {
  it("404s an id that names no run — findKb's refusal, unwrapped", async () => {
    const res = await GET(...req("00000000-0000-4000-8000-000000000000"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "no such knowledge base" })
  })

  it("answers with viewOf's envelope, not the raw run", async () => {
    const res = await GET(...req(UUID))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { slug: string; notes: unknown[] }
    // `slug` and an array `notes` are `viewOf`'s own shape (pinned in
    // kb-from-run.test.ts); a raw StoredRun has neither.
    expect(body.slug).toBe(UUID)
    expect(Array.isArray(body.notes)).toBe(true)
    expect(body.notes.length).toBeGreaterThan(0)
  })
})
