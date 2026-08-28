import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import KbIndex from "./page"
import { createRun, finishRun } from "@/lib/runs"

/**
 * app/kb/page.tsx had zero test coverage anywhere. D-scope, self-discovered
 * (docs/overnight-backlog.md is gone from this checkout, per 48c1eaa's note —
 * SELF-118 was the last used number, so this is SELF-119). Its sibling routes
 * (app/page.tsx, app/runs/page.tsx, app/runs/[id]/page.tsx) each have a test
 * built on `renderToStaticMarkup`; this one had none, despite carrying the same
 * three-way branch runs/page.test.tsx already exercises for its own route: a
 * registry that cannot be read, a registry with nothing in it, and one with a
 * map. The three are visually identical dashed-border panels in this file
 * (`error ? … : kbs.length === 0 ? … : <KbGallery/>`), which is exactly the
 * shape that lets one branch silently swallow another.
 *
 * OPENKB_RUNS_DIR="/" is the same fault api-error.ts's own doc comment measures
 * ("next start with OPENKB_RUNS_DIR=/") and checkedDir() in lib/runs.ts throws
 * it as a NamedFault, so this is the one caller-inducible error that reaches
 * `faultNotice` as a fixed, safe sentence rather than a raw errno.
 */

const dirRootNotice = /OPENKB_RUNS_DIR is &quot;\/&quot;, which resolves to \/ — the filesystem root/

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
  dir = await mkdtemp(path.join(tmpdir(), "openkb-kb-page-"))
  for (const k of ["OPENKB_RUNS_DIR", "OPENKB_DEMO", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    saved[k] = process.env[k]
  }
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
  process.env.OPENKB_RUNS_DIR = dir
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("/kb", () => {
  it("reports a registry it cannot read instead of claiming nothing is mapped", async () => {
    // The one directory checkedDir() refuses outright — no fixture run needed.
    process.env.OPENKB_RUNS_DIR = "/"

    const html = renderToStaticMarkup(await KbIndex())

    expect(html).toContain("Could not list knowledge bases")
    expect(html).toMatch(dirRootNotice)
    expect(html).not.toContain("Nothing mapped yet")
  })

  it("says nothing is mapped yet when the registry is empty, not unreadable", async () => {
    const html = renderToStaticMarkup(await KbIndex())

    expect(html).toContain("Nothing mapped yet")
    expect(html).not.toContain("Could not list knowledge bases")
  })

  it("renders the gallery for a completed run, not either empty-state panel", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)

    const html = renderToStaticMarkup(await KbIndex())

    expect(html).toContain("brightdata.com")
    expect(html).toContain(`href="/kb/${good.id}"`)
    expect(html).toContain("Filter by domain")
    expect(html).not.toContain("Nothing mapped yet")
    expect(html).not.toContain("Could not list knowledge bases")
  })
})
