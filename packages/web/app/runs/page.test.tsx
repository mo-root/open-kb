import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import RunsPage from "./page"
import RunReport from "./[id]/page"
import { createRun, failRun, finishRun } from "@/lib/runs"

/**
 * WHAT A FAILED RUN LOOKS LIKE TO A PERSON.
 *
 * The store and the route are tested where they live; this is the other end of
 * the same wire, and it is the end the item is about. A failed run was
 * unreadable from every instance but one, so what an operator saw was a list of
 * the runs that worked — six successes and no sign of the four that burned
 * money and died. Making the row readable is only half a fix if the page then
 * renders it as a map of nothing.
 *
 * TWO THINGS ARE PINNED, and the second matters more than the first.
 *
 *   That the failure appears at all: the row, the badge, and the run's own
 *   bounded sentence.
 *
 *   That nothing is INVENTED for it. A failed run measured no hosts, no
 *   entities and no cost, and the tempting shape — a zeroed `SweepResult` so
 *   every existing reader keeps working — would put "0 entities, $0.00" in the
 *   table as a measurement. It is not one. `$0.00` against a run that spent
 *   real money before it died is a worse lie than the omission it replaced.
 *
 * Rendered with `renderToStaticMarkup` rather than in a browser, following
 * app/global-error.test.tsx: these are async Server Components with no client
 * state, so awaiting the component and rendering the tree is the whole of them.
 */

const NOTICE = /quote ref [0-9a-f]{12}/

/** The provider's own words, which must not reach a page. Shaped like the real
 *  thing — this is what an OpenRouter failure actually carries. */
const PROVIDER_FAULT = new Error(
  "OpenRouter 401 no auth credentials found (request_id 0f3c9ab2, key sk-or-v1-2b7d)",
)
const LEAKS = ["sk-or-v1-2b7d", "0f3c9ab2", "OpenRouter", "no auth credentials"]

/** A run that DID produce a map, so the failed row is read against a real one
 *  rather than against an empty page. */
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
  dir = await mkdtemp(path.join(tmpdir(), "openkb-runs-page-"))
  for (const k of ["OPENKB_RUNS_DIR", "OPENKB_DEMO", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    saved[k] = process.env[k]
  }
  // Empty, and no store: every run on the page is one this test just made, so
  // the assertions are about those and not about whatever is on this disk.
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

describe("/runs, with a run that failed in it", () => {
  it("lists the failure beside the runs that worked, and says which is which", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)
    const bad = createRun("resend.com", 0)
    await failRun(bad.id, PROVIDER_FAULT)

    const html = renderToStaticMarkup(await RunsPage())

    // Both rows are there. Before this, the second one could not be.
    expect(html).toContain("brightdata.com")
    expect(html).toContain("resend.com")
    expect(html).toContain(">failed<")
    // The run's own sentence, and the ref that joins it to the server log.
    expect(html).toMatch(NOTICE)
    for (const leak of LEAKS) expect(html).not.toContain(leak)
  })

  it("counts the failure as a failure and not as a run that mapped nothing", async () => {
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)
    const bad = createRun("resend.com", 0)
    await failRun(bad.id, PROVIDER_FAULT)

    const html = renderToStaticMarkup(await RunsPage())

    // The totals are of what was MEASURED, so the successful run's $1.25 stands
    // alone rather than being averaged against a fabricated zero.
    expect(html).toContain("$1.2500")
    expect(html).toContain("Failed")
    // And the failed row prints no measurement of its own: no cost cell, no
    // host count, no duration. It says it has no map and why.
    expect(html).toContain("no map —")
  })

  it("does not link a failed run to a map that does not exist", async () => {
    // The successful row carries a `kb →` link. The failed one must not: a
    // dangling link inside a knowledge-base product is the one class of defect
    // this project refuses to ship, and `/kb/<id>` for this run is a dead end.
    const bad = createRun("resend.com", 0)
    await failRun(bad.id, PROVIDER_FAULT)

    const html = renderToStaticMarkup(await RunsPage())
    expect(html).toContain(`href="/runs/${bad.id}"`)
    expect(html).not.toContain(`href="/kb/${bad.id}"`)
  })
})

describe("/runs/[id], for a run that failed", () => {
  it("reports the failure instead of a report full of holes", async () => {
    const bad = createRun("resend.com", 40)
    await failRun(bad.id, PROVIDER_FAULT)

    const html = renderToStaticMarkup(
      await RunReport({ params: Promise.resolve({ id: bad.id }) }),
    )

    expect(html).toContain("resend.com")
    expect(html).toContain("how it ended")
    expect(html).toMatch(NOTICE)
    for (const leak of LEAKS) expect(html).not.toContain(leak)
  })

  it("shows no cost rather than a cost of zero", async () => {
    /* THE LIE THIS REFUSES. A sweep bills as it goes; a run that died at minute
       eleven spent eleven minutes of SERP and model calls. It never reached the
       line that totals them, so the total is UNKNOWN, and "$0.00" is not the
       unknown — it is a claim that the run was free. */
    const bad = createRun("resend.com", 40)
    await failRun(bad.id, PROVIDER_FAULT)

    const html = renderToStaticMarkup(
      await RunReport({ params: Promise.resolve({ id: bad.id }) }),
    )
    expect(html).not.toContain("$0.00")
    expect(html).not.toContain("Open map")
  })

  it("still renders the whole report for a run that worked", async () => {
    // The branch above must not have been bought by breaking the one below it.
    const good = createRun("brightdata.com", 0)
    await finishRun(good.id, sweepResult("brightdata.com") as never)

    const html = renderToStaticMarkup(
      await RunReport({ params: Promise.resolve({ id: good.id }) }),
    )
    expect(html).toContain("what it found")
    expect(html).toContain("$1.2500")
    expect(html).toContain("Open map")
  })
})
