import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/* POST /api/map with the demo flag on, and — just as importantly — off.
   ---------------------------------------------------------------------------
   THE ONE ROUTE THAT SPENDS. Audited rather than assumed: this is the only
   handler in the app that imports the engine or reaches a paid provider. Every
   other route reads a finished run off disk, and the only other outbound
   `fetch()` anywhere in the server tree is the PostgREST call in
   lib/store/supabase.ts, which goes to the operator's own database. So this
   file is the whole boundary between a public URL and the owner's balance, and
   `OPENKB_DEMO` is the thing that closes it.

   SEPARATE FROM route.test.ts, which drives the same handler for a different
   property — that a run which succeeds is durable before the invocation ends.
   That suite needs a sweep that returns, a store that answers and an `after`
   that captures. This one needs the opposite: a sweep that cannot be called and
   a registry that cannot be reached, because the whole assertion is that
   nothing happens. Two sets of mocks that contradict each other are two files.

   NOTHING HERE MAY SPEND. `sweep` and `createRun` are mocked to throw. The
   assertion is not that a refused run behaves well — it is that no run is
   started at all, and a mock that throws is louder than an expectation that
   counts calls. */

const sweep = vi.fn(() => {
  throw new Error("sweep() was called — this suite must never start a run")
})
vi.mock("@open-kb/sweep", () => ({ sweep }))

const createRun = vi.fn(() => {
  throw new Error("createRun() was called — this suite must never register a run")
})
vi.mock("@/lib/runs", () => ({ createRun, finishRun: vi.fn(), failRun: vi.fn() }))

/** The route hands its background work to `after`. Nothing below should reach
 *  that line, and a stub that records is how the last test proves it. */
const afterTasks: unknown[] = []
vi.mock("next/server", () => ({ after: (task: unknown) => afterTasks.push(task) }))

/** Never construct a real provider — it reads a key at module scope, and this
 *  suite must not so much as look like it could reach OpenRouter. */
vi.mock("@openrouter/ai-sdk-provider", () => ({
  openrouter: () => ({}),
  createOpenRouter: () => () => ({}),
}))

/** The store, so `runGate` can be told what today looks like without a network.
 *  Nothing else in this handler's path touches PostgREST — `@/lib/runs` is
 *  already a stub above. */
const countRunsSince = vi.fn<(since: string) => Promise<number | null>>()
vi.mock("@/lib/store/supabase", () => ({ countRunsSince }))

let POST: (req: Request) => Promise<Response>

const KEYS = ["OPENKB_DEMO", "OPENKB_PUBLIC_RUNS_PER_DAY", "OPENKB_CEILING_USD"] as const
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k]
  // No ceiling, so the flag-unset cases never ask OpenRouter what it has spent.
  process.env.OPENKB_CEILING_USD = ""
  ;({ POST } = await import("./route"))
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  process.env.OPENKB_CEILING_USD = ""
  sweep.mockClear()
  createRun.mockClear()
  afterTasks.length = 0
})

beforeEach(() => {
  countRunsSince.mockReset()
  // A quiet day by default: an allowance that is configured is an allowance
  // that is open, unless a test says otherwise.
  countRunsSince.mockResolvedValue(0)
})

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://demo.example/api/map", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )
}

describe("with OPENKB_DEMO on", () => {
  it("refuses a perfectly valid request, and starts nothing", async () => {
    process.env.OPENKB_DEMO = "1"
    const res = await post({ domain: "resend.com" })

    expect(res.status).toBe(403)
    expect(createRun).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
    // Not even registered as background work: the handler returns before the
    // line that hands anything to the host.
    expect(afterTasks).toHaveLength(0)
  })

  it("answers with the sentence the page shows, and a flag a client can branch on", async () => {
    // One string, two surfaces. BuildWorkflow renders `DEMO_REFUSAL` above a
    // disabled button and this body carries the same constant, so a visitor who
    // opens the network tab reads what the page told them rather than a second,
    // differently-worded refusal.
    process.env.OPENKB_DEMO = "1"
    const body = (await (await post({ domain: "resend.com" })).json()) as {
      error?: string
      demo?: boolean
      repo?: string
    }
    const { DEMO_REFUSAL, DEMO_REPO } = await import("@/lib/demo")
    expect(body.error).toBe(DEMO_REFUSAL)
    expect(body.demo).toBe(true)
    expect(body.repo).toBe(DEMO_REPO)
  })

  it("is not a 500 and carries no fault ref — nothing went wrong", async () => {
    // `guarded` never sees this: a refusal is a `return`, so it keeps its
    // status and stays out of the log. A demo answering 500 would look broken
    // to every visitor and bury the real faults under its own noise.
    process.env.OPENKB_DEMO = "1"
    const res = await post({ domain: "resend.com" })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(403)
    expect(body).not.toHaveProperty("ref")
    expect(String(body.error)).not.toMatch(/could not handle/i)
  })

  it("refuses before it reads the body, so no input can route around it", async () => {
    // The guard is about the deployment, not the request. A body that is not
    // JSON at all still gets the demo answer rather than "body must be JSON":
    // there is no ordering of bad input that reaches `createRun`.
    process.env.OPENKB_DEMO = "1"
    for (const body of [
      "not json at all",
      {},
      { domain: "" },
      { domain: "resend.com", queries: 9999 },
    ]) {
      const label = JSON.stringify(body)
      const res = await post(body)
      expect(res.status, label).toBe(403)
      expect(((await res.json()) as { demo?: boolean }).demo, label).toBe(true)
    }
    expect(createRun).not.toHaveBeenCalled()
  })

  it.each(["true", "yes", "on"])("is on for %j too, matching isDemo", async (value) => {
    // The route must not re-implement the flag with its own `=== "1"`. Two
    // readings of one variable is how a UI ends up saying "read-only" over an
    // endpoint that spends.
    process.env.OPENKB_DEMO = value
    expect((await post({ domain: "resend.com" })).status).toBe(403)
  })
})

describe("with OPENKB_DEMO unset", () => {
  it("goes back to being the handler it was — the ordinary refusals return", async () => {
    // The regression case for every existing deployment. Not a run, which would
    // cost money: the first ordinary refusal is enough to prove the demo branch
    // fell through, and it is the one refusal that needs no credentials.
    delete process.env.OPENKB_DEMO
    const res = await post("not json at all")

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe("body must be JSON")
  })

  it("still refuses a domain that names no company, with its own sentence", async () => {
    delete process.env.OPENKB_DEMO
    const res = await post({ domain: "   " })

    expect(res.status).toBe(400)
    expect(String(((await res.json()) as { error?: string }).error)).toMatch(
      /does not name a company/,
    )
    expect(createRun).not.toHaveBeenCalled()
  })

  it("says nothing about a demo in any of its answers", async () => {
    // The other half of "nothing changes": a deployment that is not a demo must
    // not mention one, in the body or in a stray flag some client might read.
    delete process.env.OPENKB_DEMO
    const body = (await (await post({ domain: "" })).json()) as Record<string, unknown>

    expect(body).not.toHaveProperty("demo")
    expect(String(body.error)).not.toMatch(/demo/i)
  })

  it.each(["", "0", "false"])("treats %j as unset, not as on", async (value) => {
    // `OPENKB_DEMO=false` reading as a demo would be the more surprising bug of
    // the two, and it is the one an "any non-empty string" implementation ships.
    process.env.OPENKB_DEMO = value
    const res = await post("not json at all")
    expect(res.status).toBe(400)
  })
})

/**
 * THE DOOR, OPENED — `OPENKB_DEMO=1` plus `OPENKB_PUBLIC_RUNS_PER_DAY`.
 *
 * The demo stops refusing. Everything asserted here is asserted WITHOUT
 * starting a run: `createRun` and `sweep` still throw if they are so much as
 * touched, so "the guard let this through" is proved by the handler reaching
 * its NEXT refusal rather than by watching it spend. That is the only way to
 * test a spending endpoint honestly, and it is the same trick the flag-unset
 * block above already uses.
 */
describe("with a daily allowance and room left in it", () => {
  it("stops refusing — the demo guard is no longer the answer", async () => {
    // The whole item, in one assertion. The same request that got a 403 above
    // now falls through to the ordinary body check, which is exactly as far as
    // a test that must not spend can follow it.
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    const res = await post("not json at all")

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe("body must be JSON")
    expect(createRun).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
  })

  it("counts the day before it decides, from midnight UTC", async () => {
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    await post("not json at all")

    expect(countRunsSince).toHaveBeenCalledTimes(1)
    expect(countRunsSince.mock.calls[0]![0]).toMatch(/T00:00:00\.000Z$/)
  })

  it("says nothing about a demo now that it is not refusing as one", async () => {
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    const body = (await (await post({ domain: "   " })).json()) as Record<string, unknown>

    // The ordinary refusal, with its own sentence and no allowance chatter.
    expect(String(body.error)).toMatch(/does not name a company/)
    expect(body).not.toHaveProperty("demo")
    expect(body).not.toHaveProperty("repo")
  })
})

describe("with the allowance spent", () => {
  it("refuses with 429 and starts nothing", async () => {
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    countRunsSince.mockResolvedValue(20)
    const res = await post({ domain: "resend.com" })

    expect(res.status).toBe(429)
    expect(createRun).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
    expect(afterTasks).toHaveLength(0)
  })

  it("answers with the numbers as well as the sentence", async () => {
    // A client that would rather read a quota than parse prose gets one. The
    // sentence is for a person; these two are so a caller does not have to
    // match on English that will be reworded.
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    countRunsSince.mockResolvedValue(20)
    const body = (await (await post({ domain: "resend.com" })).json()) as {
      error?: string
      demo?: boolean
      runsPerDay?: number
      remainingToday?: number
    }

    expect(body.runsPerDay).toBe(20)
    expect(body.remainingToday).toBe(0)
    expect(body.error).toMatch(/resets at 00:00 UTC/)
    // NOT flagged as a demo refusal, deliberately. A client that read `demo`
    // here would send its user off to clone the repo when the true answer is
    // "tomorrow", and the repo is not the remedy for a spent allowance.
    expect(body).not.toHaveProperty("demo")
    expect(body).not.toHaveProperty("repo")
  })

  it("refuses before it reads the body, so no input can route around it", async () => {
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    countRunsSince.mockResolvedValue(99)
    for (const body of ["not json at all", {}, { domain: "" }, { domain: "resend.com", queries: 9999 }]) {
      const label = JSON.stringify(body)
      expect((await post(body)).status, label).toBe(429)
    }
    expect(createRun).not.toHaveBeenCalled()
  })

  it("meters a deployment that is not a demo too", async () => {
    // The allowance is about spending, not about the gallery — an owner capping
    // their own password-protected instance gets the cap.
    delete process.env.OPENKB_DEMO
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "2"
    countRunsSince.mockResolvedValue(2)
    const res = await post({ domain: "resend.com" })

    expect(res.status).toBe(429)
    expect(createRun).not.toHaveBeenCalled()
  })
})

describe("with an allowance it cannot count against", () => {
  it("fails closed with a 503 rather than spending an uncounted run", async () => {
    // The safety argument, at the endpoint. `countRunsSince` returns null for a
    // store that is absent, unreachable, or answering an error, and a null read
    // is not a licence to spend — a deployment that ran what it could not count
    // would have no limit at all on the day its database went down.
    process.env.OPENKB_DEMO = "1"
    process.env.OPENKB_PUBLIC_RUNS_PER_DAY = "20"
    countRunsSince.mockResolvedValue(null)
    const res = await post({ domain: "resend.com" })
    const body = (await res.json()) as { error?: string; demo?: boolean }

    expect(res.status).toBe(503)
    expect(body.error).toMatch(/cannot reach the database/i)
    expect(body).not.toHaveProperty("demo")
    expect(createRun).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
    expect(afterTasks).toHaveLength(0)
  })
})

describe("with an allowance nobody can act on", () => {
  it.each(["0", "off", "lots", "-3", ""])(
    "reads %j as no allowance, so a demo stays read-only",
    async (value) => {
      // The expensive direction of a typo is a door that opens. This is the
      // cheap one, and it is the one this parser is tuned for: an unreadable
      // allowance leaves the deployment exactly as it was.
      process.env.OPENKB_DEMO = "1"
      process.env.OPENKB_PUBLIC_RUNS_PER_DAY = value
      const res = await post({ domain: "resend.com" })

      expect(res.status).toBe(403)
      expect(((await res.json()) as { demo?: boolean }).demo).toBe(true)
      // And nothing was counted, because there was nothing to count against.
      expect(countRunsSince).not.toHaveBeenCalled()
    },
  )
})
