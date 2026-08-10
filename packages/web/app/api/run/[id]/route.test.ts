import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"

/**
 * ONE ANSWER, WHICHEVER HALF OF THE REGISTRY IT CAME FROM.
 *
 * The route had two branches that had silently disagreed about what `result`
 * means. The live branch — a run this process is still holding — returned
 * `run.result.report`, the run's own summary. The stored branch, two lines
 * below it, returned the whole `SweepResult`.
 *
 * That is two defects wearing one line of code:
 *
 *   SHAPE. `BuildWorkflow`'s fallback poll puts `body.result` straight into
 *   `ResultPanel`, which renders `kept`, `kinds`, `relations`, `usd` — all
 *   fields of `report`. A `SweepResult` has none of them at the top level, so
 *   `body.result.kept` was `undefined` and a run recovered from disk or from
 *   Postgres drew an empty card. The stored branch had been serving a shape no
 *   client reads.
 *
 *   SIZE. Measured over the 71 artifacts in `runs/`, serialised the way
 *   `Response.json` serialises: the vercel.com sweep is a 4.77MB `SweepResult`
 *   against a 4.5MB response cap on the target host, and stripe.com is 4.13MB.
 *   Their reports are 30.4KB and 12.8KB. The biggest map in the corpus answered
 *   413; the summary that every reader actually wants is three orders of
 *   magnitude smaller.
 *
 * These drive the route rather than a helper, because the defect was the two
 * branches drifting and only the route has both.
 */

/* ------------------------------------------------------------------ fixtures */

const UUID = "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704"
const FAILED_UUID = "1b0c8f42-5d7a-4e19-9c33-7a2f6e5b40d1"

/** A distinctive string planted in the parts of a `SweepResult` that must never
 *  reach the wire. If it is in the body, the whole run was serialised. */
const BULK = "ENTITY-BULK-MARKER"

function sweepResult() {
  return {
    anchor: "resend.com",
    decomposition: {
      sells: "transactional email",
      buyer: "developers",
      products: [],
      capabilities: [],
      coinages: [],
    },
    // The three heavy fields. On the real corpus these are where the megabytes
    // are: `entities` carries every classified host with its prose, `queries`
    // every search and its hits.
    queries: [{ q: `${BULK} query`, family: "f", hits: [] }],
    entities: [
      { name: BULK, domain: "postmarkapp.com", kind: "company", what: BULK, relation: "competitor", why: BULK },
    ],
    edges: [],
    stats: {
      queries: 12,
      results: 40,
      hosts: 9,
      kept: 7,
      tokIn: 10,
      tokOut: 20,
      tokReasoning: 0,
      serpCalls: 12,
      unlockerCalls: 1,
      usd: 0.42,
      seconds: 120,
    },
    // The summary, and the only part a reader wants.
    report: { domain: "resend.com", kept: 7, noise: 2, usd: 0.42, seconds: 120, kinds: { company: 7 } },
  }
}

function req(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`https://kb.test/api/run/${id}`),
    { params: Promise.resolve({ id }) },
  ]
}

/* ------------------------------------------------------------------- harness */

let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-run-route-"))
  for (const k of ["OPENKB_RUNS_DIR", "OPENKB_DEMO", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    saved[k] = process.env[k]
  }
  process.env.OPENKB_RUNS_DIR = dir
  process.env.OPENKB_DEMO = ""
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SECRET_KEY

  await writeFile(
    path.join(dir, `run-${UUID}.json`),
    JSON.stringify({
      id: UUID,
      domain: "resend.com",
      queries: 12,
      startedAt: 1_754_000_000_000,
      endedAt: 1_754_000_600_000,
      status: "complete",
      result: sweepResult(),
    }),
    "utf8",
  )
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* --------------------------------------------------------------------- tests */

describe("GET /api/run/[id] — a run this process is not holding", () => {
  it("answers with the run's summary, which is what the client reads", async () => {
    const res = await GET(...req(UUID))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; result: Record<string, unknown> }

    expect(body.status).toBe("complete")
    // `body.result.kept` is the exact expression `BuildWorkflow` evaluates when
    // the stream closed without a `complete` frame, which is the whole reason
    // this endpoint exists. It was `undefined`.
    expect(body.result.kept).toBe(7)
    expect(body.result).toEqual(sweepResult().report)
  })

  it("does not put the whole run on the wire", async () => {
    const res = await GET(...req(UUID))
    const text = await res.text()

    // The two heavy arrays, by their contents rather than by their names —
    // `report` legitimately carries `entities` and `queries` as COUNTS, so a
    // key check would fail on the fixed code for the wrong reason.
    expect(text).not.toContain(BULK)
    // And the shape that made it heavy: a `SweepResult` has these at the top
    // level of `result` and a report does not.
    const body = JSON.parse(text) as { result: Record<string, unknown> }
    expect(Array.isArray(body.result.entities)).toBe(false)
    expect(Array.isArray(body.result.queries)).toBe(false)
    expect(body.result.decomposition).toBeUndefined()
  })

  it("says the same things the live branch says, field for field", async () => {
    // The drift this pins is not one branch being wrong, it is the two being
    // written separately. Both now come out of one function, so the key set is
    // a property of the route rather than of which half answered.
    const res = await GET(...req(UUID))
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["domain", "endedAt", "queries", "result", "startedAt", "status"].sort(),
    )
  })

  it("still 404s an id that names nothing", async () => {
    const res = await GET(...req("7c3d5e21-0f44-4a88-9bb1-2e6d7c4a1053"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: "unknown" })
  })
})

describe("GET /api/run/[id] — a run that failed on another instance", () => {
  const NOTICE =
    "the server could not handle this request — quote ref a1b2c3d4e5f6, the server log has the cause"
  const CAUSE = "Error: OpenRouter 401 no auth credentials found (request_id 0f3c9ab2, key sk-or-v1-2b7d)"

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://store.test"
    process.env.SUPABASE_SECRET_KEY = "k"
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes(FAILED_UUID)
          ? new Response(
              JSON.stringify([
                {
                  id: FAILED_UUID,
                  domain: "stripe.com",
                  queries: 40,
                  status: "failed",
                  started_at: "2026-08-03T00:00:00Z",
                  ended_at: "2026-08-03T00:04:00Z",
                  error: `${NOTICE}\ncause: ${CAUSE}`,
                  result: null,
                },
              ]),
              { status: 200 },
            )
          : new Response("[]", { status: 200 }),
      ),
    )
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
  })

  it("is a failure, not a 404", async () => {
    /* THE BUG IN ONE ASSERTION. The client treats a non-ok response as "cannot
       tell whether this run is over — keep reading", so a 404 here left the
       page that started the run spinning a live indicator for ever over a run
       that had definitively died. */
    const res = await GET(...req(FAILED_UUID))
    expect(res.status).toBe(200)

    const body = (await res.json()) as { status: string; domain: string; error: string }
    expect(body.status).toBe("failed")
    expect(body.domain).toBe("stripe.com")
    expect(body.error).toBe(NOTICE)
  })

  it("tells the reader why without telling them the provider's words", async () => {
    const res = await GET(...req(FAILED_UUID))
    const text = await res.text()
    for (const leak of ["sk-or-v1-2b7d", "0f3c9ab2", "OpenRouter", "no auth credentials"]) {
      expect(text).not.toContain(leak)
    }
    expect(text).toContain("quote ref a1b2c3d4e5f6")
  })

  it("carries no result at all, rather than an empty one", async () => {
    // An empty `report` would render as a run that finished and mapped nothing.
    // The absence of the key is what makes the client take its `body.error`
    // branch instead of its `body.result` branch.
    const body = (await (await GET(...req(FAILED_UUID))).json()) as Record<string, unknown>
    expect("result" in body).toBe(false)
  })
})
