import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { FakeFetch, FakeSearch } from "@open-kb/core/testing"
import { queriesThatFit, runSeconds } from "@open-kb/core"
import type { SearchHit } from "@open-kb/core"

/**
 * `POST /api/map` MUST BUY A RUN THAT FITS THE CLOCK IT WAS GIVEN.
 *
 * WHAT WAS BROKEN. The route passed no query budget, so the engine dealt its
 * own hand — right on a terminal, where nothing is timing it, and fatal here.
 * One measured Vercel run (clerk.com, 481 spans) bought 132 SERP searches over
 * three minutes and the watchdog stopped it at 270s having just STARTED the
 * phase that turns hosts into a map: $0.7099 spent, no map, and nothing about
 * it looked like a failure from the inside. The route is the only thing in this
 * system that knows `maxDuration`, so the route is where the size of a run has
 * to be decided.
 *
 * WHY THIS DRIVES THE REAL HANDLER AND THE REAL ENGINE. The defect was in the
 * join between them: every part was individually correct and nobody passed the
 * number. So only the two ports and the model are replaced — `SweepOptions.ports`
 * is the seam the engine already exposes — and everything between the HTTP body
 * and `FakeSearch.calls` is the production path: the budget arithmetic, the
 * catalog, the opening hand, the anchor-name filter, the widening loop, the
 * ceiling, the rank pool. The assertions are against queries that reached the
 * PORT, because a budget enforced anywhere later is a budget already spent.
 *
 * WHY `maxDuration` IS NOT VARIED HERE. It is a build-time literal Next
 * requires to be statically analysable (an expression fails collection with
 * "Invalid segment configuration export detected"), so there is no runtime in
 * which this module has a different one. The pair of claims is therefore split:
 * this file proves the route spends EXACTLY what its own limit affords, and
 * that the affording is a derivation rather than a constant — a bigger limit
 * buys a bigger run, at the two limits this repo actually deploys under.
 */

const hoisted = vi.hoisted(() => ({
  afterTasks: [] as unknown[],
  /** Every options object the route handed the engine. */
  sweepOpts: [] as Record<string, unknown>[],
  /** The ports and model the test injects into the real engine. */
  ports: null as unknown,
  model: null as unknown,
}))

vi.mock("next/server", () => ({
  after: (task: unknown) => {
    hoisted.afterTasks.push(task)
  },
}))

/** The route builds its model from this. Handing back the mock means the real
 *  `sweep()` runs its real `generateObject` calls against a scripted model
 *  instead of OpenRouter. */
vi.mock("@openrouter/ai-sdk-provider", () => ({
  openrouter: () => hoisted.model,
  createOpenRouter: () => () => hoisted.model,
}))

/**
 * The REAL engine, with the two ports replaced and the options recorded.
 *
 * Not a stub: `importOriginal` gives the shipped `sweep()`, and the spread puts
 * `ports` on top of whatever the route passed (it passes none), which is the
 * documented both-or-neither seam. A stub here would test that the route
 * computes a number and prove nothing about whether the engine obeys it.
 */
vi.mock("@open-kb/sweep", async (importOriginal) => {
  const real = await importOriginal<typeof import("@open-kb/sweep")>()
  return {
    ...real,
    sweep: (opts: Record<string, unknown>) => {
      hoisted.sweepOpts.push(opts)
      return real.sweep({ ...opts, ports: hoisted.ports } as Parameters<typeof real.sweep>[0])
    },
  }
})

const { POST, maxDuration } = await import("./route")

/* ------------------------------------------------------------------- market */

const ANCHOR = "pellucid.example"

/** Six products, so the uncapped opening hand is comfortably wider than any
 *  budget a 300s host can afford — otherwise a passing test would only mean the
 *  company was small. */
const PRODUCTS = [
  "Log Search Cloud",
  "Uptime Alerts",
  "Trace Explorer",
  "Metric Rollups",
  "Incident Timeline",
  "Access Audit",
] as const

const page = (heading: string, body: string): string =>
  `<html><head><title>${heading}</title></head><body><h1>${heading}</h1><p>${body}</p>` +
  `<p>Teams adopt this after an incident review shows nobody could answer a question about ` +
  `production in time. It runs as a hosted service, it keeps a retention window their auditors ` +
  `accept, and it bills on ingested volume rather than per seat.</p></body></html>`

const LLMS_TXT =
  `# Pellucid\n\nPellucid is a hosted observability suite for small platform teams.\n\n` +
  `## Products\n\n${PRODUCTS.map((p) => `- ${p}: part of the suite.`).join("\n")}\n\n` +
  `## Buyers\n\nPlatform teams of five to fifty engineers who arrive after an incident nobody ` +
  `could explain and cannot staff an observability team of their own.\n`

/** Twelve vendors, each with a readable front page, so the rank phase has real
 *  work and the hosts a query returns are hosts a run has to pay to judge. */
const VENDORS = Array.from({ length: 12 }, (_, i) => `vendor${i}.example`)

const FETCH_TABLE: Record<string, { httpStatus: number; body: string; contentType?: string }> = {
  [`https://${ANCHOR}/llms.txt`]: { httpStatus: 200, body: LLMS_TXT, contentType: "text/plain" },
  [`https://${ANCHOR}/`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("Pellucid — see production", "Pellucid runs an observability suite for platform teams."),
  },
  ...Object.fromEntries(
    VENDORS.map((v, i) => [
      `https://${v}/`,
      {
        httpStatus: 200,
        contentType: "text/html",
        body: page(`Vendor ${i}`, `Vendor ${i} sells hosted observability to platform teams.`),
      },
    ]),
  ),
}

/**
 * Every query answers, and each returns three vendors chosen by a rolling
 * offset — so more queries really do mean more hosts, which is the relationship
 * the whole budget rests on.
 */
class RollingSearch extends FakeSearch {
  constructor() {
    super({})
  }
  override async search(queries: string[]): Promise<
    Awaited<ReturnType<FakeSearch["search"]>>
  > {
    ;(this.calls as string[][]).push([...queries])
    return [...new Set(queries)].map((query, n) => {
      const hits: SearchHit[] = Array.from({ length: 3 }, (_, i) => {
        const v = VENDORS[(this.calls.length * 3 + n + i) % VENDORS.length]!
        return { url: `https://${v}/`, title: v, description: "a vendor in this market" }
      })
      return { query, hits, ok: true, usd: 0.001, ms: 5 }
    })
  }
}

/* -------------------------------------------------------------------- model */

/** The engine's five calls, told apart by the schema each one asks for — the
 *  same routing `packages/sweep/tests/fixture.ts` uses, and for the same
 *  reason: the schema IS the contract under test. */
function phaseOf(schema: unknown): "understand" | "catalog" | "assess" | "classify" | "link" {
  const props = Object.keys(
    (schema as { schema?: { properties?: Record<string, unknown> } })?.schema?.properties ?? {},
  )
  if (props.includes("capabilities")) return "understand"
  if (props.includes("generic")) return "catalog"
  if (props.includes("enough")) return "assess"
  if (props.includes("spans")) return "classify"
  if (props.includes("edges")) return "link"
  throw new Error(`unrecognised generateObject schema: {${props.join(", ")}}`)
}

const productOf = (prompt: string): string => /the product\s{2,}(.+)/.exec(prompt)?.[1]?.trim() ?? ""

function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ responseFormat, prompt }) => {
      const text = prompt
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]) : []))
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
      const phase = phaseOf(responseFormat)
      const object =
        phase === "understand"
          ? {
              sells: "a hosted observability suite for small platform teams",
              buyer: "a platform team that has just had an incident nobody could explain",
              brand: "Pellucid",
              products: PRODUCTS.map((name) => ({ name, does: `runs ${name.toLowerCase()}`, foundAt: "" })),
              capabilities: PRODUCTS.map((name) => ({
                name: name.toLowerCase(),
                does: `does the ${name.toLowerCase()} job`,
                covers: [name],
                centrality: "core",
              })),
              coinages: ["Pellucid"],
            }
          : phase === "catalog"
            ? {
                terms: [productOf(text).toLowerCase().replace(/ cloud$/, "")],
                generic: false,
                queries: [
                  { q: `who solves ${productOf(text).toLowerCase()} without a vendor`, intent: "pain", platform: "web", why: "the buyer in trouble", market: productOf(text).toLowerCase() },
                  { q: `what teams use instead of ${productOf(text).toLowerCase()}`, intent: "switching", platform: "web", why: "the switcher", market: productOf(text).toLowerCase() },
                ],
              }
            : phase === "assess"
              ? { enough: false, missing: "the substitutes are thin", draw: [], queries: [] }
              : phase === "classify"
                ? {
                    name: "a vendor",
                    kind: "company",
                    what: "sells hosted observability to platform teams",
                    relation: "competitor",
                    why: "answers the same question for the same team",
                    spans: ["sells hosted observability to platform teams"],
                  }
                : { edges: [] }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(object) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 250, text: 250, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
}

/* ----------------------------------------------------------------- harness */

function post(body: unknown): Request {
  return new Request("https://kb.test/api/map", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

let dir: string
let search: RollingSearch
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-map-budget-"))
  for (const k of [
    "OPENKB_RUNS_DIR",
    "OPENKB_DEMO",
    "OPENKB_CEILING_USD",
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
  process.env.OPENKB_DEMO = ""
  process.env.OPENKB_CEILING_USD = ""
  // No store, so nothing here has a reason to reach PostgREST.
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SECRET_KEY
  process.env.BRIGHTDATA_API_TOKEN = "not-a-token"
  process.env.BRIGHTDATA_SERP_ZONE = "none"
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "none"
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
  hoisted.sweepOpts = []
  search = new RollingSearch()
  hoisted.ports = { search, fetch: new FakeFetch(FETCH_TABLE) }
  hoisted.model = scriptedModel()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  // Anything that escapes the injected ports is a real request. It must
  // explode, not bill someone.
  vi.stubGlobal("fetch", () => {
    throw new Error("REAL NETWORK CALL ATTEMPTED FROM THE MAP ROUTE TEST")
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Run the route end to end and hand back everything worth asserting on. */
async function map(body: unknown = { domain: ANCHOR }) {
  const res = await POST(post(body))
  const json = (await res.json()) as {
    runId?: string
    budget?: { maxQueries: number; clockSeconds: number; hostSeconds: number; estimatedSeconds: number }
    error?: string
  }
  await hoisted.afterTasks[0]
  const { getRun } = await import("@/lib/runs")
  return {
    status: res.status,
    json,
    opts: hoisted.sweepOpts[0]!,
    asked: search.calls.flat(),
    run: json.runId ? getRun(json.runId) : undefined,
  }
}

/* ------------------------------------------------------------------- tests */

const BUDGET = queriesThatFit(maxDuration - 30)

describe("the route buys a run its own host can finish", () => {
  it("hands the engine a ceiling derived from maxDuration, and the same instant the watchdog counts to", async () => {
    const before = Date.now()
    const { opts, json } = await map()

    expect(opts.maxQueries).toBe(BUDGET)
    expect(json.budget?.maxQueries).toBe(BUDGET)
    expect(json.budget?.hostSeconds).toBe(maxDuration)
    expect(json.budget?.clockSeconds).toBe(maxDuration - 30)

    // The deadline is the watchdog's own instant: start + limit − margin. Both
    // are derived from one expression in the route, and a run paced against a
    // different instant than the one that kills it is the bug this replaces.
    const deadline = opts.deadlineAt as number
    expect(deadline).toBeGreaterThanOrEqual(before + (maxDuration - 30) * 1000)
    expect(deadline).toBeLessThanOrEqual(Date.now() + (maxDuration - 30) * 1000)
  }, 60_000)

  it("and the engine spends exactly that, opening hand and widening rounds together", async () => {
    // The join under test. Six products deal a hand far wider than the budget,
    // and the planner asks for more on top of it; what reached the port is the
    // ceiling and not one query above it.
    const { asked, run } = await map()
    expect(asked.length).toBe(BUDGET)
    expect(new Set(asked).size).toBe(asked.length)

    // THAT THE CUT ACTUALLY HAPPENED, named rather than inferred from a total.
    // Six products deal five queries each and the company hand adds three — 33
    // written — so the tail of the catalog must be missing, and the head must
    // not be. Without this a hand that happened to come to `BUDGET` on its own
    // would satisfy the count above and prove nothing.
    expect(asked).toContain("log search")
    expect(asked).toContain("Log Search Cloud alternatives")
    expect(asked).not.toContain("Access Audit alternatives")
    expect(asked).not.toContain("Pellucid alternatives")
    // And it FINISHED, which is the entire point: a record, a map, a bill.
    expect(run?.status).toBe("complete")
    expect((run?.result?.report as { queries: number }).queries).toBe(BUDGET)
  }, 60_000)

  it("promises a run that fits, with the margin the arithmetic was chosen for", async () => {
    const { json } = await map()
    expect(json.budget!.estimatedSeconds).toBeLessThanOrEqual(json.budget!.clockSeconds)
    // One more query would not fit — this is the largest run the host affords,
    // not a comfortable one chosen by feel.
    expect(runSeconds(BUDGET + 1)).toBeGreaterThan(maxDuration - 30)
  }, 60_000)

  it("keeps the ceiling in the run's own report, so a stored map can explain its size", async () => {
    const { run } = await map()
    const budget = (run?.result?.report as { budget: Record<string, number | null> }).budget
    expect(budget.maxQueries).toBe(BUDGET)
    expect(budget.clockSeconds).toBe(maxDuration - 30)
    expect(budget.fired).toBe(BUDGET)
    // Everything this run found, it judged. On this host, at this budget, the
    // clock is not what limited the map — the budget was chosen so it would not
    // be, and if this ever goes red the coefficients need re-measuring.
    expect(budget.unjudged).toBe(0)
  }, 60_000)

  it("a caller asking for more than the host can finish still gets a run that finishes", async () => {
    // `queries` is the caller's ask and it still clamps the catalog. It cannot
    // raise the ceiling: the clock is not theirs to spend.
    const { asked, opts } = await map({ domain: ANCHOR, queries: 120 })
    expect(opts.queries).toBe(120)
    expect(opts.maxQueries).toBe(BUDGET)
    expect(asked.length).toBe(BUDGET)
  }, 60_000)
})

describe("the budget is a derivation, not a constant", () => {
  it("a smaller host buys a smaller hand and a bigger one buys more", () => {
    // The two limits this repo deploys under — 300 on Hobby, 800 on Pro, both
    // less the watchdog's 30s — plus the degenerate small host. `maxDuration`
    // itself cannot be varied at runtime (see the header), so what is proven
    // here is the function the route calls with it, at the exact values that
    // matter, and above the test that the route calls it with its own limit.
    expect(queriesThatFit(60 - 30)).toBeLessThan(queriesThatFit(300 - 30))
    expect(queriesThatFit(300 - 30)).toBeLessThan(queriesThatFit(800 - 30))
    expect(queriesThatFit(800 - 30)).toBeLessThan(queriesThatFit(1800 - 30))
    // Raising the plan really does raise the map rather than nudging it.
    expect(queriesThatFit(800 - 30)).toBeGreaterThan(3 * queriesThatFit(300 - 30))
  })

  it("never asks for nothing, however small the host", () => {
    // A budget of zero is a sweep that buys nothing and returns an empty map,
    // which a visitor reads as a quiet market rather than as a host too small.
    expect(queriesThatFit(1)).toBeGreaterThanOrEqual(1)
  })
})

describe("the time box is the WEB's, and only the web's", () => {
  it("every run this route starts carries both the ceiling and the deadline", async () => {
    // There is no branch here that starts an unbounded web run — not for a
    // caller who names a query count, not for one who names none. The CLI's
    // freedom is proved where it lives, against the engine
    // (packages/sweep/tests/sweep-fits-the-clock-it-was-given.test.ts), which
    // is the only place "no options, no clock, same run as before" can be
    // stated about the thing that would break.
    for (const body of [{ domain: ANCHOR }, { domain: ANCHOR, queries: 3 }]) {
      hoisted.sweepOpts = []
      search = new RollingSearch()
      hoisted.ports = { search, fetch: new FakeFetch(FETCH_TABLE) }
      hoisted.model = scriptedModel()
      hoisted.afterTasks = []
      const res = await POST(post(body))
      expect(res.status).toBe(200)
      await hoisted.afterTasks[0]
      expect(hoisted.sweepOpts[0]!.maxQueries).toBe(BUDGET)
      expect(typeof hoisted.sweepOpts[0]!.deadlineAt).toBe("number")
    }
  }, 60_000)
})
