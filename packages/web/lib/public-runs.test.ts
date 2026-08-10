import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * THE DOOR A STRANGER WALKS THROUGH, and the number that decides how wide it is.
 *
 * Worth its own file for lib/demo.test.ts's reason, one step further along:
 * that file covers the boolean that decides whether there is a spending door at
 * all, and this covers the one that decides how many people may walk through it
 * today. A wrong answer here is wrong on the deployment whose URL is handed to
 * strangers, and it is wrong in the direction of a bill.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE BORING ONE: with nothing configured,
 * nothing changes. Every clone, every dev server, every deployment that exists
 * today sets neither variable, and none of them may notice this feature. That
 * is asserted first and from both sides — the flag reads 0, and the gate a
 * read-only demo gets back is byte for byte the refusal it already had.
 */

/** The store, in the tests' hands. `runGate` refuses when it cannot count, and
 *  a suite that reached a real PostgREST would be measuring the network. */
const countRunsSince = vi.fn<(since: string) => Promise<number | null>>()
vi.mock("./store/supabase", () => ({ countRunsSince }))

const {
  RUNS_PER_DAY_VAR,
  dayEndsAt,
  dayStartedAt,
  publicRunsPerDay,
  runGate,
  servesOwnRuns,
  untilReset,
  MEASURED,
} = await import("./public-runs")
const { DEMO_REFUSAL } = await import("./demo")

const KEYS = ["OPENKB_DEMO", "OPENKB_PUBLIC_RUNS_PER_DAY"] as const
const saved: Record<string, string | undefined> = {}
for (const k of KEYS) saved[k] = process.env[k]

/** Every variable this module can see, set from scratch. */
function env(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(values)) process.env[k] = v
}

beforeEach(() => {
  countRunsSince.mockReset()
  countRunsSince.mockResolvedValue(0)
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/* --------------------------------------------------------------------- flag */

describe("publicRunsPerDay", () => {
  it("is 0 when the variable is unset — the default is a deployment that spends nothing new", () => {
    env({})
    expect(publicRunsPerDay()).toBe(0)
  })

  it("is the number an operator wrote", () => {
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: "25" })
    expect(publicRunsPerDay()).toBe(25)
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: " 3 " })
    expect(publicRunsPerDay()).toBe(3)
  })

  it.each(["0", "", "-1", "lots", "true", "yes", "0.4", "NaN", "1e400"])(
    "reads %j as closed, because a typo may cost a demo and never a bill",
    (value) => {
      // The asymmetry is deliberate and it is the same one `truthy()` in
      // lib/demo.ts is built on, pointing the same way: a spelling that fails
      // to open the door costs a visitor a run, and one that opens it by
      // accident costs the owner an account.
      env({ OPENKB_PUBLIC_RUNS_PER_DAY: value })
      expect(publicRunsPerDay()).toBe(0)
    },
  )

  it("floors a fraction rather than rounding it up", () => {
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: "5.9" })
    expect(publicRunsPerDay()).toBe(5)
  })

  it("is read per call, not captured at import", () => {
    // The bug `ceilingUsd()` in the map route already shipped once: a
    // module-scope `process.env` read is inlined at build time and the guard
    // compiles to a constant. Here the constant would be 0 in an image built
    // without the variable — a deployment that set an allowance in its host
    // dashboard and refuses every visitor while claiming to allow some.
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: "4" })
    expect(publicRunsPerDay()).toBe(4)
    env({})
    expect(publicRunsPerDay()).toBe(0)
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: "4" })
    expect(publicRunsPerDay()).toBe(4)
  })

  it("is spelled the same everywhere", () => {
    // The name travels into DEPLOY.md and into the refusal sentences. One
    // constant, so a rename cannot leave documentation pointing at a variable
    // nothing reads.
    expect(RUNS_PER_DAY_VAR).toBe("OPENKB_PUBLIC_RUNS_PER_DAY")
  })
})

/* ------------------------------------------------------ the privacy boundary */

describe("servesOwnRuns", () => {
  it("is true on any deployment that is not a demo", () => {
    env({})
    expect(servesOwnRuns()).toBe(true)
  })

  it("is false on a read-only demo — the fifteen-maps leak stays shut", () => {
    // A demo pointed at a configured Supabase served nine of the operator's own
    // unpublished runs alongside the committed six. That is what this keeps
    // closed, and an allowance must not reopen it by accident.
    env({ OPENKB_DEMO: "1" })
    expect(servesOwnRuns()).toBe(false)
  })

  it("is true on a demo with an allowance, because the visitor's own run has to open", () => {
    // The narrow permission: `getStoredRun` may answer BY ID. `listStoredRuns`
    // is not asked and still serves the committed six — proved next door in
    // app/page.test.tsx, which counts the cards on a public front page.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "5" })
    expect(servesOwnRuns()).toBe(true)
  })
})

/* ------------------------------------------------------------------- window */

describe("the day the count is taken over", () => {
  const noon = Date.parse("2026-08-09T12:34:56.000Z")

  it("starts at midnight UTC and ends at the next one", () => {
    expect(dayStartedAt(noon).toISOString()).toBe("2026-08-09T00:00:00.000Z")
    expect(dayEndsAt(noon).toISOString()).toBe("2026-08-10T00:00:00.000Z")
  })

  it("says how long is left in words a sentence can carry", () => {
    expect(untilReset(noon)).toBe("11h 26m")
    expect(untilReset(Date.parse("2026-08-09T23:53:00.000Z"))).toBe("7m")
    // Never "0h 7m", which reads as a broken template.
    expect(untilReset(Date.parse("2026-08-09T23:59:59.000Z"))).not.toContain("h")
  })

  it("is a fixed window rather than a rolling one, so a quoted count stays true", () => {
    // Two instants inside the same UTC day ask the store the same question. A
    // rolling 24 hours would move the boundary between the number a visitor
    // read on the front page and the number the route checked when they typed.
    const morning = Date.parse("2026-08-09T06:00:00.000Z")
    const evening = Date.parse("2026-08-09T22:00:00.000Z")
    expect(dayStartedAt(morning).getTime()).toBe(dayStartedAt(evening).getTime())
  })
})

/* --------------------------------------------------------------------- gate */

describe("with no allowance configured — nothing changes", () => {
  it("an ordinary deployment is open, unmetered, and asks the store nothing", async () => {
    env({})
    const gate = await runGate()

    expect(gate.open).toBe(true)
    expect(gate).toMatchObject({ limit: 0, used: null, remaining: null })
    // The load-bearing half: no round trip on the front page or the map route
    // of every deployment that exists today.
    expect(countRunsSince).not.toHaveBeenCalled()
  })

  it("a demo is closed, with the refusal it already had", async () => {
    env({ OPENKB_DEMO: "1" })
    const gate = await runGate()

    expect(gate.open).toBe(false)
    if (gate.open) return
    expect(gate.reason).toBe("read-only")
    expect(gate.status).toBe(403)
    // The same constant the route has always answered with, not a new sentence
    // that happens to mean the same thing. app/api/map/demo.test.ts asserts the
    // body carries it; this asserts the decision does.
    expect(gate.refusal).toBe(DEMO_REFUSAL)
    expect(countRunsSince).not.toHaveBeenCalled()
  })
})

describe("with an allowance", () => {
  it("counts today's runs and reports what is left", async () => {
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(7)
    const gate = await runGate(Date.parse("2026-08-09T12:00:00.000Z"))

    expect(gate.open).toBe(true)
    expect(gate).toMatchObject({ limit: 20, used: 7, remaining: 13 })
    expect(countRunsSince).toHaveBeenCalledWith("2026-08-09T00:00:00.000Z")
  })

  it("refuses with 429 once the day is spent, and says when it resets", async () => {
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(20)
    const gate = await runGate(Date.parse("2026-08-09T12:34:56.000Z"))

    expect(gate.open).toBe(false)
    if (gate.open) return
    expect(gate.reason).toBe("used-up")
    expect(gate.status).toBe(429)
    expect(gate.remaining).toBe(0)
    // A refusal that leaves the reader with a next step. "Tomorrow" is a next
    // step; "no" is not.
    expect(gate.refusal).toMatch(/00:00 UTC/)
    expect(gate.refusal).toMatch(/11h 26m/)
    expect(gate.refusal).toMatch(/20 maps a day/)
    // And it does not claim a fault, for the same reason DEMO_REFUSAL does not.
    for (const lie of ["error", "failed", "sorry", "went wrong"]) {
      expect(gate.refusal.toLowerCase()).not.toContain(lie)
    }
  })

  it("refuses a count that has already overshot the limit", async () => {
    // Two instances can each pass the check and each start a run. The overshoot
    // is bounded by concurrency, and the arithmetic must not turn it into a
    // negative remaining that reads as fresh allowance.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "3" })
    countRunsSince.mockResolvedValue(9)
    const gate = await runGate()

    expect(gate.open).toBe(false)
    if (gate.open) return
    expect(gate.remaining).toBe(0)
  })

  it("fails CLOSED when the store cannot answer", async () => {
    // The whole safety argument. `countRunsSince` returns null for a store that
    // is absent, unreachable or answering an error, and a null read is not a
    // licence to spend — the same direction the map route's spend ceiling
    // already fails in. A deployment that allowed runs it could not count would
    // have no limit at all on the day its database went down.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(null)
    const gate = await runGate()

    expect(gate.open).toBe(false)
    if (gate.open) return
    expect(gate.reason).toBe("uncountable")
    // 503 and not 403: this deployment intends to allow the run, so "later" is
    // true here where it would be a lie on the read-only demo.
    expect(gate.status).toBe(503)
    expect(gate.refusal).toMatch(/cannot reach the database/i)
  })

  it("meters a deployment that is not a demo too", async () => {
    // The allowance is about spending, not about the gallery. An owner who caps
    // their own password-protected instance gets the cap.
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: "2" })
    countRunsSince.mockResolvedValue(2)
    const gate = await runGate()

    expect(gate.open).toBe(false)
    if (gate.open) return
    expect(gate.reason).toBe("used-up")
  })

  it("reads the singular when the allowance is one", async () => {
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "1" })
    countRunsSince.mockResolvedValue(1)
    const gate = await runGate()

    expect(gate.open).toBe(false)
    if (gate.open) return
    expect(gate.refusal).toContain("1 map a day")
    expect(gate.refusal).not.toContain("1 maps")
  })
})

/* ----------------------------------------------------------- the quoted run */

describe("what the front page tells a visitor a run is", () => {
  it("quotes time and size, both inside the measured range", () => {
    // The box says "about 4 minutes" and "roughly 230 entities". Those are
    // roundings of six real hosted runs, and a rounding that fell outside the
    // range it came from would be a number nobody measured.
    const [minS, maxS] = MEASURED.seconds
    const [minE, maxE] = MEASURED.entities
    expect(MEASURED.aboutMinutes * 60).toBeGreaterThanOrEqual(minS)
    expect(MEASURED.aboutMinutes * 60).toBeLessThanOrEqual(maxS)
    expect(MEASURED.aboutEntities).toBeGreaterThanOrEqual(minE)
    expect(MEASURED.aboutEntities).toBeLessThanOrEqual(maxE)
  })

  it("keeps the price the owner pays, which the visitor is never quoted", () => {
    // Not shown to a stranger — see the box in BuildWorkflow — but recorded
    // here, because "twenty cents a visitor" is the number the allowance is
    // sized against and it should not live only in a commit message.
    const [lo, hi] = MEASURED.usd
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeLessThan(0.5)
  })
})
