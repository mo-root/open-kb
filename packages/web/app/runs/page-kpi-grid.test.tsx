import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import RunsPage from "./page"
import { createRun, failRun, finishRun } from "@/lib/runs"

/**
 * THE ORPHAN CELL. The KPI row's container was `grid grid-cols-2 ...
 * ${failedCount > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3"}` — conditional at
 * `sm:` only. Below `sm` it stayed a flat `grid-cols-2` regardless of tile
 * count. Three tiles (no failed run, the common case) in a 2-column grid
 * lay out 2-then-1: the third tile sits alone in row two, and the column
 * beside it is an unfilled grid cell, not a blank — the container paints
 * `bg-slate-800` behind the `gap-px` seams, and StatTile's own `bg-slate-900`
 * is what makes a real tile read as a tile, so the empty cell reads as a
 * flat slate block. That is the exact "a tile whose number failed to load"
 * shape the adjacent comment already reasons about preventing for `sm:` —
 * it was just never extended to the base breakpoint, where the common case
 * actually lives.
 *
 * This is its own file rather than a describe block in page.test.tsx on
 * purpose: `lib/runs.ts` keeps an in-memory registry that `listStoredRuns`
 * merges in "even when the disk refused" (see runs.ts's own comment on
 * that ordering), module-scoped and shared by every test in one file —
 * page.test.tsx's own failed-run describes already populate it, and a
 * fresh `OPENKB_RUNS_DIR` per test does not touch that registry. Vitest
 * isolates modules per test file by default, so a dedicated file is a
 * fresh `runs.ts` and therefore an empty registry — the only reliable way
 * to assert "zero failed runs" here.
 */

const PROVIDER_FAULT = new Error("OpenRouter 401 no auth credentials found")

function sweepResult(anchor: string) {
  return {
    anchor,
    decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
    queries: [],
    entities: [{ name: "a", domain: "a.com", kind: "company", what: "w", relation: "competitor", why: "y" }],
    edges: [],
    stats: {
      queries: 12,
      results: 40,
      hosts: 9,
      kept: 1,
      tokIn: 0,
      tokOut: 0,
      tokReasoning: 0,
      serpCalls: 12,
      unlockerCalls: 0,
      usd: 1.25,
      seconds: 90,
    },
    report: { domain: anchor, kept: 1, usd: 1.25 },
  }
}

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-runs-page-kpi-"))
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("/runs' KPI row never leaves an orphan cell for the grid to paint solid", () => {
  /* `grid-cols-2` appears in this page's markup only on the KPI row's own
   * container — confirmed by grep, runs/[id]/page.tsx has its own,
   * unrelated one and this test never renders that page — so a substring
   * check on RunsPage's own render is unambiguous. */
  it("uses a fixed three-column grid, not the two-column base that orphans the third tile, when nothing failed", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)

    const html = renderToStaticMarkup(await RunsPage())
    expect(html).toContain("grid-cols-3")
    expect(html).not.toContain("grid-cols-2")
  })

  it("uses a two-column base and a four-column sm grid, exactly filling both, once a run has failed", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)
    const bad = createRun("resend.com", 0)
    await failRun(bad.id, PROVIDER_FAULT)

    const html = renderToStaticMarkup(await RunsPage())
    expect(html).toContain("grid-cols-2 sm:grid-cols-4")
  })
})
