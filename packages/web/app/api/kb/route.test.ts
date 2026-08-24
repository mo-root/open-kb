import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GET } from "./route"

/**
 * `GET /api/kb` is `listStoredRuns` filtered to `isCompleted` and mapped
 * through `summaryOf` — both already pinned end to end (`runs.test.ts`,
 * `kb-from-run.test.ts`), so what is untested here is the wiring: does the
 * route apply the filter and hand back the summary shape, not the raw run.
 */

const UUID = "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704"

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

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-kb-list-route-"))
  for (const k of ["OPENKB_RUNS_DIR", "OPENKB_DEMO", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    saved[k] = process.env[k]
  }
  process.env.OPENKB_RUNS_DIR = dir
  process.env.OPENKB_DEMO = ""
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SECRET_KEY
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
})

describe("GET /api/kb — an empty runs/", () => {
  it("answers with an empty list rather than a fault", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kbs: [] })
  })
})

describe("GET /api/kb — one completed run on disk", () => {
  beforeAll(async () => {
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

  it("answers with that run's summary, not the raw run", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kbs: Array<{ slug: string; notes: number }> }
    expect(body.kbs).toHaveLength(1)
    // `summaryOf`'s own shape (`slug`, `manifest`, `counts`, …) is
    // `kb-from-run.test.ts`'s to pin; this only checks the route reaches it —
    // `slug` is the run id and a raw `SweepResult` has no such field.
    expect(body.kbs[0]!.slug).toBe(UUID)
    expect("result" in body.kbs[0]!).toBe(false)
  })
})
