import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import KbPage from "./page"
import { createRun, failRun, finishRun } from "@/lib/runs"
import * as db from "@/lib/store/supabase"

/**
 * app/kb/[id]/page.tsx had zero test coverage anywhere. D-scope, self-discovered
 * — docs/overnight-backlog.md is gone from this checkout (481fa6d untracked it
 * and named git log's `Backlog item: <id>` trailers the record instead), and
 * SELF-119 was the last number used, so this is SELF-120.
 *
 * The sibling routes (app/page.tsx, app/kb/page.tsx, app/runs/page.tsx,
 * app/runs/[id]/page.tsx) each have a test built on `renderToStaticMarkup`;
 * this one had none, despite carrying more branches than either "index" route:
 * running / failed / not-found all reach the same dead-end panel this file's
 * own comment calls "THREE STATES, NOT TWO", each printing a different
 * headline, and a not-found id additionally tries to offer near matches (a
 * truncated address-bar autocomplete) with its own listing failure caught
 * independently of the primary lookup.
 *
 * TWO MECHANICS THAT ARE NOT OBVIOUS FROM THE PAGE ALONE, both found by
 * writing this test and watching it fail against the real module rather than
 * against a guess:
 *
 * `getStoredRun`'s in-memory branch (lib/runs.ts's `storedFrom`) returns null
 * for a run whose status is still "running" — a still-running run is
 * deliberately unreadable from THAT process's own memory, because the branch
 * this page renders for it ("is still running") exists for the multi-instance
 * case: a visitor's browser opened the map before the instance that started
 * the run wrote it anywhere durable. The only way `getStoredRun` can hand back
 * a "running" row is through the store (`db.getRunRow`), which is what a
 * second instance reads. Reaching that offline means mocking `db.getRunRow`
 * rather than creating a real live run — this project runs no live services.
 *
 * `getStoredRun` calls `runsDir()` — the call that throws on
 * `OPENKB_RUNS_DIR=/` — UNCONDITIONALLY once the in-memory check misses, for
 * every id shape, not only ones that reach disk. So a throwing `getStoredRun`
 * (which goes straight to app/error.tsx, never to this page's own catch — see
 * the page's own comment on that ordering) is what happens for ANY not-found
 * id under a broken `OPENKB_RUNS_DIR`. The one way to reach this page's OWN
 * catch (the near-match listing failing) is a run the in-memory check finds
 * WITHOUT calling `runsDir()` at all — i.e. an already-ended (failed) run
 * still held in this process's memory — so only that combination is testable
 * here without also asserting on app/error.tsx's separate behaviour.
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

async function render(id: string) {
  return renderToStaticMarkup(
    (await KbPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as never,
  )
}

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-kb-id-page-"))
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

describe("/kb/[id]", () => {
  it("says no knowledge base by that id, and nothing else has been mapped", async () => {
    const html = await render("does-not-exist")

    expect(html).toContain("No knowledge base called")
    expect(html).toContain("does-not-exist")
    expect(html).toContain("Nothing has been mapped yet.")
    expect(html).not.toContain("Did you mean")
    expect(html).not.toContain("failed, so it built no map")
  })

  it("offers near matches for a truncated id, not a correction to a typo", async () => {
    // The address bar autocompletes a long id down to a prefix — offer the
    // full run as "did you mean", not "no knowledge base called <prefix>".
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)

    const html = await render(good.id.slice(0, 8))

    expect(html).toContain("Did you mean one of these?")
    expect(html).toContain(`href="/kb/${good.id}"`)
    expect(html).not.toContain("Nothing has been mapped yet.")
  })

  it("reports a failed run as failed, not as a missing knowledge base", async () => {
    const bad = createRun("resend.com", 0)
    await failRun(bad.id, new Error("boom"))

    const html = await render(bad.id)

    expect(html).toContain("failed, so it built no map")
    expect(html).toContain("See what happened")
    expect(html).toContain(`href="/runs/${bad.id}"`)
    expect(html).not.toContain("No knowledge base called")
    expect(html).not.toContain("Did you mean")
  })

  it("sends a still-running visitor to the live run, not a dead end", async () => {
    // Not a real live run — see the header comment on why `getStoredRun`'s own
    // in-memory branch can never surface "running", and why the store is
    // mocked rather than left unconfigured to reach this branch offline.
    const id = "9c6c9b6b-df6a-4b5a-8f3a-9b7a1c9d9a11"
    const getRunRow = vi.spyOn(db, "getRunRow").mockResolvedValue({
      id,
      domain: "resend.com",
      queries: 0,
      startedAt: Date.now(),
      status: "running",
    })

    const html = await render(id)
    getRunRow.mockRestore()

    expect(html).toContain("is still running")
    expect(html).toContain(`href="/runs/${id}"`)
    expect(html).not.toContain("No knowledge base called")
    expect(html).not.toContain("failed, so it built no map")
  })

  it("reports a near-match registry it cannot list, not silence", async () => {
    // A FAILED run this process already holds in memory: `storedFrom` returns
    // it without `getStoredRun` ever calling `runsDir()`, so — unlike a
    // not-found id — the primary lookup survives `OPENKB_RUNS_DIR=/` and this
    // page's own catch (around the near-match listing) is what fires. See the
    // header comment for why every other id shape throws before reaching it.
    const bad = createRun("resend.com", 0)
    await failRun(bad.id, new Error("boom"))
    process.env.OPENKB_RUNS_DIR = "/"

    const html = await render(bad.id)

    expect(html).toContain("failed, so it built no map")
    expect(html).toContain("Nothing to suggest instead")
    expect(html).toMatch(dirRootNotice)
    expect(html).not.toContain("Other knowledge bases this deployment holds")
  })

  it("renders the knowledge base browser for a completed run", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)

    const html = await render(good.id)

    expect(html).toContain("brightdata.com")
    expect(html).toContain("Products &amp; Ecosystem")
    expect(html).not.toContain("No knowledge base called")
  })
})
