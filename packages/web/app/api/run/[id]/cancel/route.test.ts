import { afterEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { createRun, cancelRun, failRun, getRun } from "@/lib/runs"

/**
 * POST /api/run/[id]/cancel had no test of its own wiring.
 *
 * `lib/runs.ts`'s `cancelRun` — the abort-and-return-a-boolean — is already
 * pinned by `runs.test.ts` (it is exercised as a setup step in the stopped-run
 * tests there). What had zero coverage was this route: does a `true` become
 * `{cancelled: true}` at 200, does a `false` become the 409 with a reason a
 * client can branch on, and does the id actually reach `cancelRun` rather than
 * some other value. Coverage gap found sweeping `scripts/*.ts beyond sweep.ts`
 * (D-scope), which led to checking every route beside the ones SELF-37 already
 * covered — this is the one CRUD-shaped route SELF-37 did not reach because it
 * is not under `app/api/kb/`.
 */

function req(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`https://kb.test/api/run/${id}/cancel`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  ]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("POST /api/run/[id]/cancel", () => {
  it("cancels a running run and answers 200", async () => {
    const run = createRun("resend.com", 12)
    expect(run.status).toBe("running")

    const res = await POST(...req(run.id))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cancelled: true })
    expect(getRun(run.id)?.abort.signal.aborted).toBe(true)
  })

  it("answers 409 with a reason once the run has actually ended", async () => {
    // `cancelRun` only signals the abort — `status` stays "running" until the
    // engine unwinds and the map route calls `failRun`, same as a run that
    // finished or errored on its own. This is what a second cancel, or any
    // cancel of a run that is no longer live, actually lands on.
    const run = createRun("resend.com", 12)
    expect(cancelRun(run.id)).toBe(true)
    await failRun(run.id, new Error("aborted"))

    const res = await POST(...req(run.id))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ cancelled: false, reason: "not running" })
  })

  it("answers 409 for an id this process never held", async () => {
    const res = await POST(...req("7c3d5e21-0f44-4a88-9bb1-2e6d7c4a1053"))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ cancelled: false, reason: "not running" })
  })
})
