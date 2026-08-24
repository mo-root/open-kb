import { describe, expect, it, vi } from "vitest"
import type { SweepResult } from "@open-kb/sweep"
import type { StoredRun } from "./runs"

/**
 * `findKb` is the two-branch refusal every `/api/kb/[id]*` route opens with
 * (the envelope, the graph, one note, the zip), and none of the four route
 * tests exercise a missing or failed id — each route test that touches
 * `findKb` at all does so only via a run that already completed. Mocking
 * `./runs` the way `public-runs.test.ts` mocks `./store/supabase` keeps this
 * a unit test of the branching, not a filesystem test — `runs.test.ts`
 * already owns `getStoredRun` end to end.
 */
const getStoredRun = vi.fn<(id: string) => Promise<StoredRun | null>>()
vi.mock("./runs", () => ({
  getStoredRun,
  isCompleted: (run: StoredRun) => run.result !== undefined,
}))

const { findKb } = await import("./kb-lookup")

/** `findKb` never reads inside a `result` — it only asks whether one is
 *  present — so an opaque stand-in is honest here; a real `SweepResult`'s
 *  shape is `runs.test.ts`'s to pin, not this file's. */
function sweepResult(anchor: string): SweepResult {
  return { anchor } as unknown as SweepResult
}

function stored(over: Partial<StoredRun> = {}): StoredRun {
  return {
    id: "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704",
    domain: "a.com",
    queries: 4,
    startedAt: 0,
    status: "complete",
    ...over,
  }
}

describe("findKb", () => {
  it("refuses 'no such knowledge base' at 404 when nothing is stored at the id", async () => {
    getStoredRun.mockResolvedValueOnce(null)
    const got = await findKb("missing")

    expect("refusal" in got).toBe(true)
    if (!("refusal" in got)) throw new Error("expected a refusal")
    expect(got.refusal.status).toBe(404)
    expect(await got.refusal.json()).toEqual({ error: "no such knowledge base" })
  })

  it("refuses at 404 for a failed run, naming its status and pointing at /api/run/[id] for why", async () => {
    getStoredRun.mockResolvedValueOnce(stored({ status: "failed", result: undefined }))
    const got = await findKb("9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704")

    expect("refusal" in got).toBe(true)
    if (!("refusal" in got)) throw new Error("expected a refusal")
    expect(got.refusal.status).toBe(404)
    const body = (await got.refusal.json()) as { error: string; status: string }
    expect(body.status).toBe("failed")
    expect(body.error).toBe(
      "run 9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704 failed, so it built no knowledge base — ask /api/run/9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704 why",
    )
  })

  it("refuses a still-running run the same way — no result yet is no result yet, whatever the status", async () => {
    getStoredRun.mockResolvedValueOnce(stored({ status: "running", result: undefined }))
    const got = await findKb("r1")

    expect("refusal" in got).toBe(true)
    if (!("refusal" in got)) throw new Error("expected a refusal")
    expect(got.refusal.status).toBe(404)
    expect((await got.refusal.json() as { status: string }).status).toBe("running")
  })

  it("hands back the run itself, unwrapped, once it has completed", async () => {
    const completed = stored({ result: sweepResult("resend.com") })
    getStoredRun.mockResolvedValueOnce(completed)
    const got = await findKb(completed.id)

    expect("run" in got).toBe(true)
    if (!("run" in got)) throw new Error("expected a run")
    expect(got.run).toBe(completed)
  })
})
