import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import RunReport from "./page"
import { createRun, finishRun } from "@/lib/runs"

/**
 * app/runs/[id]/page.tsx's two most consequential branches had no test
 * anywhere. D-scope, self-discovered — docs/overnight-backlog.md is gone from
 * this checkout (481fa6d untracked it, git log's `Backlog item: <id>` trailers
 * are the record instead), and SELF-121 was the last number used.
 *
 * `app/runs/page.test.tsx` already covers this page's failed-run report and
 * one happy-path render, so this file is deliberately narrower and does not
 * repeat either. Two branches that test never reaches:
 *
 * `notFound()` — every fixture on this route, in both test files, starts from
 * a run this test itself created, so a run id that never existed at all was
 * never exercised. Next's `notFound()` does not return an error to catch in
 * the usual sense; it throws an Error tagged with a `digest` the framework's
 * own rendering pipeline recognizes (`NEXT_HTTP_ERROR_FALLBACK;404`, read
 * straight out of `next/dist/client/components/http-access-fallback` — there
 * is no public constant to import instead). Asserting on that digest is the
 * only way to tell "this route correctly gave up" from "this route threw for
 * an unrelated reason", which for an untested branch are otherwise
 * indistinguishable failures.
 *
 * The itemized-bill branch (`cost ? <CostBreakdown .../> : <p>…predates…`) —
 * every `sweepResult` fixture in this file's siblings omits `report.cost`
 * entirely, so `readRunCost` returns null on every existing test and only the
 * "predates the itemised bill" fallback paragraph has ever rendered. The
 * branch that is this page's actual reason for reading `report.cost` in the
 * first place — a run recorded with a real bill — had zero coverage.
 */

function sweepResult(anchor: string, report: Record<string, unknown> = {}) {
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
    report: { domain: anchor, kept: 1, usd: 1.25, ...report },
  }
}

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-runs-id-page-"))
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

describe("/runs/[id]", () => {
  it("gives up with Next's own not-found signal for an id that matches no run", async () => {
    await expect(
      RunReport({ params: Promise.resolve({ id: "does-not-exist" }) }),
    ).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404$/) })
  })

  it("renders the itemized bill when the run's report carried one", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(
      good.id,
      sweepResult("brightdata.com", {
        cost: {
          usd: 1.25,
          elapsedMs: 90_000,
          calls: 12,
          tokens: 4_000,
          ceilingUsd: 5,
          byKind: [{ label: "serp", calls: 12, failures: 0, usd: 1.25, ms: 0 }],
          byAgent: [],
        },
      }) as never,
    )

    const html = renderToStaticMarkup(
      await RunReport({ params: Promise.resolve({ id: good.id }) }),
    )

    expect(html).toContain("what it cost")
    expect(html).not.toContain("predates the itemised bill")
  })

  it("falls back to the one recorded total when the report carries no itemized bill", async () => {
    // The behavior every other fixture in this file's siblings exercises by
    // accident (their `report` omits `cost` too) — pinned here on purpose so
    // the branch above cannot regress into the only one anything asserts on.
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)

    const html = renderToStaticMarkup(
      await RunReport({ params: Promise.resolve({ id: good.id }) }),
    )

    expect(html).toContain("predates the itemised bill")
    expect(html).not.toContain("what it cost")
  })
})
