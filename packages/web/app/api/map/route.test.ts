import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A RUN THAT SUCCEEDS MUST LEAVE A RECORD, and the run is not over until it has.
 *
 * WHAT WAS BROKEN. `POST /api/map` starts the sweep in a detached async IIFE and
 * answers with the run id. When the sweep returned, the route called
 * `finishRun`, `finishRun` fired its three writes with `void` and returned, and
 * the IIFE resolved — with the result row still in flight. On a long-lived box
 * that is invisible: the process is still there a millisecond later and the
 * write lands. On a host that ends the invocation when the request's registered
 * work resolves, it is a run that WORKED ending with no result row, no map and
 * nothing in the gallery, having spent the money.
 *
 * WHY THE TEST DRIVES THE ROUTE AND NOT `finishRun`. The defect was never in one
 * function; it was in a chain of four links — the store write, `finishRun`, the
 * IIFE, and what the runtime is told to wait for — and any of them dropping the
 * await restores it. So the store's write is held open at the bottom, and the
 * assertion is made at the top, on the task the route hands to `after`. Nothing
 * in between can pass this by being individually correct.
 *
 * The gate is a real `fetch` the Supabase store makes, not an injected seam:
 * `lib/store/supabase.ts` speaks PostgREST over HTTP, so a stubbed global
 * `fetch` that does not resolve is exactly "the store has not answered yet".
 */

const hoisted = vi.hoisted(() => ({
  /** Every task the route registered with `after`, in order. */
  afterTasks: [] as unknown[],
  /** What the mocked sweep does. Set per test. */
  sweepImpl: null as null | ((opts: SweepOpts) => Promise<unknown>),
}))

interface SweepOpts {
  domain: string
  spans: { emit: (s: Record<string, unknown>) => unknown }
}

/** The seam the whole item is about. Capturing the task is the only way to ask
 *  "is this invocation finished?" from outside — which is the question the host
 *  asks, and the one nobody was answering. */
vi.mock("next/server", () => ({
  after: (task: unknown) => {
    hoisted.afterTasks.push(task)
  },
}))

/** Never construct a real provider: it reads a key at module scope and this
 *  suite must not so much as look like it could reach OpenRouter. */
vi.mock("@openrouter/ai-sdk-provider", () => ({
  openrouter: () => ({}),
  createOpenRouter: () => () => ({}),
}))

vi.mock("@open-kb/sweep", () => ({
  sweep: (opts: SweepOpts) => hoisted.sweepImpl!(opts),
}))

const { POST } = await import("./route")
const { getRun } = await import("@/lib/runs")

/* ------------------------------------------------------------------ fixtures */

/** The smallest thing `finishRun` will accept as a run's answer. `report` is the
 *  only part any reader wants; see app/api/run/[id]/route.ts. */
function sweepResult(anchor: string) {
  return {
    anchor,
    decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
    queries: [],
    entities: [],
    edges: [],
    stats: {
      queries: 1,
      results: 0,
      hosts: 0,
      kept: 0,
      tokIn: 0,
      tokOut: 0,
      tokReasoning: 0,
      serpCalls: 1,
      unlockerCalls: 0,
      usd: 0.42,
      seconds: 3,
    },
    report: { domain: anchor, kept: 0, usd: 0.42 },
  }
}

function post(body: unknown): Request {
  return new Request("https://kb.test/api/map", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Whether a promise has settled, decided by a timer rather than by a microtask.
 *
 * A `Promise.race` against `Promise.resolve()` only proves the task did not
 * settle in ONE microtask, which a chain of three awaits also would not — the
 * test would pass over a bug. A macrotask lets every pending microtask drain
 * first, so "pending" here means genuinely waiting on something.
 */
function state(p: Promise<unknown>): Promise<"settled" | "pending"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 25)),
  ])
}

/* ------------------------------------------------------------------- harness */

let dir: string
const saved: Record<string, string | undefined> = {}

/** Every PostgREST call the store made, as `table:status`. */
let calls: string[]
/** Held open by the fetch stub until a test lets it go. */
let openGate: () => void
let gate: Promise<void>
/** Which PostgREST paths the gate applies to. */
let gated: (url: string, body: string) => boolean

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-map-route-"))
  for (const k of [
    "OPENKB_RUNS_DIR",
    "OPENKB_DEMO",
    "OPENKB_CEILING_USD",
    "OPENKB_RUN_CAP_USD",
    "OPENKB_DAY_CAP_USD",
    "OPENKB_RUNS_PER_VISITOR_PER_DAY",
    "OPENKB_RUNS_AT_ONCE",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "BRIGHTDATA_API_TOKEN",
    "BRIGHTDATA_SERP_ZONE",
    "BRIGHTDATA_UNLOCKER_ZONE",
    "OPENROUTER_API_KEY",
  ]) {
    saved[k] = process.env[k]
  }
  process.env.OPENKB_RUNS_DIR = dir
  // Off, explicitly. A demo deployment refuses this endpoint at its first line,
  // and a suite that inherited the flag would pass by never running anything.
  process.env.OPENKB_DEMO = ""
  // No ceiling, so the handler never asks OpenRouter what it has spent.
  process.env.OPENKB_CEILING_USD = ""
  // Every spend limit off, and named one by one rather than left to a default.
  // This file is about a run reaching durable storage; the limits have their own
  // suite (limits.test.ts) which turns them on and drives the same route. A
  // suite that inherited them would eventually fail on its fourth run of the
  // day for a reason that has nothing to do with what it asserts, which is the
  // kind of failure that gets a real guard deleted.
  process.env.OPENKB_RUN_CAP_USD = "off"
  process.env.OPENKB_DAY_CAP_USD = "off"
  process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
  process.env.OPENKB_RUNS_AT_ONCE = "off"
  process.env.SUPABASE_URL = "https://store.test"
  process.env.SUPABASE_SECRET_KEY = "k"
  process.env.BRIGHTDATA_API_TOKEN = "t"
  process.env.BRIGHTDATA_SERP_ZONE = "serp"
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "unlocker"
  process.env.OPENROUTER_API_KEY = "sk-test"
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  hoisted.afterTasks = []
  hoisted.sweepImpl = async ({ domain }) => sweepResult(domain)
  calls = []
  gate = new Promise<void>((r) => {
    openGate = r
  })
  gated = () => false
  vi.spyOn(console, "error").mockImplementation(() => {})

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const body = String(init?.body ?? "")
      if (url.includes("/rest/v1/runs")) calls.push(`runs:${/"status":"(\w+)"/.exec(body)?.[1] ?? "?"}`)
      else if (url.includes("/rest/v1/run_spans")) calls.push("spans")
      else calls.push(url)
      if (gated(url, body)) await gate
      return new Response("", { status: 201 })
    }),
  )
})

afterEach(() => {
  // Never leave a gate shut: a test that fails before releasing would otherwise
  // hang the next one on a promise nothing will resolve.
  openGate()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* --------------------------------------------------------------------- tests */

describe("POST /api/map — the run is not over until it is durable", () => {
  it("registers the background run with the host instead of detaching it", async () => {
    const res = await POST(post({ domain: "resend.com" }))
    expect(res.status).toBe(200)

    // A detached `void (async () => …)()` registers nothing, and a host that is
    // told about no work is a host that may stop the moment it has replied.
    expect(hoisted.afterTasks).toHaveLength(1)
    expect(hoisted.afterTasks[0]).toBeInstanceOf(Promise)
    await hoisted.afterTasks[0]
  })

  it("does not resolve until the result row has landed", async () => {
    gated = (url, body) => url.includes("/rest/v1/runs") && body.includes('"status":"complete"')

    const res = await POST(post({ domain: "resend.com" }))
    const { runId } = (await res.json()) as { runId: string }
    const task = hoisted.afterTasks[0] as Promise<void>

    // The sweep is over and the store has been asked. This is the exact instant
    // the bug was in: the run's answer exists in memory and nowhere else.
    await vi.waitFor(() => expect(calls).toContain("runs:complete"))
    expect(getRun(runId)?.status).toBe("complete")

    expect(await state(task)).toBe("pending")

    openGate()
    await task
    expect(await state(task)).toBe("settled")
  })

  it("does not resolve until the run's own file has landed either", async () => {
    // The other terminal write, on the path a deployment with no store takes.
    // `finishRun` voided this one too, under a comment about not failing a run
    // for a slow disk — still true, and orthogonal: it may not fail the run, and
    // it may not be abandoned.
    const res = await POST(post({ domain: "resend.com" }))
    const { runId } = (await res.json()) as { runId: string }
    await (hoisted.afterTasks[0] as Promise<void>)

    expect(await readdir(dir)).toContain(`run-${runId}.json`)
  })

  it("does not resolve until the last spans have been flushed", async () => {
    // The tail of the run: `pump` batches spans and flushes whatever is in hand
    // when the stream closes. That flush was fired into the void as well, so the
    // final batch of a run — the most interesting part, the part that says how
    // it ended — landed only if the process happened to outlive the request.
    gated = (url) => url.includes("/rest/v1/run_spans")
    hoisted.sweepImpl = async ({ domain, spans }) => {
      spans.emit({
        runId: "ignored",
        agentId: "search",
        parentId: null,
        kind: "search",
        name: "serp",
        argsDigest: "transactional email",
        ms: 10,
        ok: true,
        usd: 0.01,
      })
      return sweepResult(domain)
    }

    const res = await POST(post({ domain: "resend.com" }))
    expect(res.status).toBe(200)
    const task = hoisted.afterTasks[0] as Promise<void>

    await vi.waitFor(() => expect(calls).toContain("spans"))
    expect(await state(task)).toBe("pending")

    openGate()
    await task
  })

  it("holds the same promise open when the run FAILS", async () => {
    // A failure is a record too, and the only one another instance can read.
    // Losing it is how a browser ends up polling a 404 for ever.
    gated = (url, body) => url.includes("/rest/v1/runs") && body.includes('"status":"failed"')
    hoisted.sweepImpl = async () => {
      throw new Error("OpenRouter 402 out of credit (request_id 0f3c9ab2)")
    }

    const res = await POST(post({ domain: "resend.com" }))
    const { runId } = (await res.json()) as { runId: string }
    const task = hoisted.afterTasks[0] as Promise<void>

    await vi.waitFor(() => expect(calls).toContain("runs:failed"))
    expect(getRun(runId)?.status).toBe("failed")
    expect(await state(task)).toBe("pending")

    openGate()
    await task
    // And it resolves rather than rejecting: a rejected task is an unhandled
    // rejection on the host, reported as a crash of a run that merely failed.
    await expect(task).resolves.toBeUndefined()
  })

  it("still answers with the run id long before any of that", async () => {
    /* The property the awaits must not cost. The response carries an id and
       nothing else precisely so a three-minute sweep is not a three-minute
       request, and the obvious wrong fix for everything above — awaiting the
       task in the handler — would turn this endpoint into one that times out
       and destroys work already paid for. */
    let releaseSweep!: () => void
    const sweeping = new Promise<void>((r) => {
      releaseSweep = r
    })
    hoisted.sweepImpl = async ({ domain }) => {
      await sweeping
      return sweepResult(domain)
    }

    const res = await POST(post({ domain: "resend.com" }))
    expect(res.status).toBe(200)
    expect((await res.json()) as { runId: string }).toHaveProperty("runId")

    const task = hoisted.afterTasks[0] as Promise<void>
    expect(await state(task)).toBe("pending")

    releaseSweep()
    await task
  })
})
