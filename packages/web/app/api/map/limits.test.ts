import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { FakeFetch, FakeSearch } from "@open-kb/core/testing"
import type { SearchHit } from "@open-kb/core"

/**
 * `POST /api/map` MUST NOT SPEND MORE THAN IT IS ALLOWED TO, and must say so in
 * a sentence a stranger can act on.
 *
 * WHAT WAS BROKEN. The route had one guard on the money and it was weak three
 * separate ways. It read the OpenRouter KEY's cumulative usage, which counts
 * every other project on that key — measured $548 lifetime, of which $42.90 was
 * this one. It metered no Bright Data at all, which is 58% to 77% of a run's
 * bill. And it was checked once, before the run, so a run that started a cent
 * under the ceiling could spend for four unwatched minutes. On top of that,
 * `Number("$5")` is `NaN` and `NaN > 0` is false, so the single likeliest typo
 * removed the guard entirely while the deployment went on reporting one.
 *
 * WHY EVERY TEST HERE DRIVES THE REAL HANDLER. Each limit is a join: an
 * environment variable, a query against this deployment's own rows, a decision,
 * and — for the per-run cap — a span stream, a watchdog and an abort signal
 * reaching an engine. Every part can be individually correct while the money
 * still goes out, which is what happened. So the seams replaced are only the
 * two ports, the model, and the network the store speaks over; the limiter, the
 * route, the registry, the terminal writes and (where it matters) the engine
 * are the shipped code.
 *
 * THE FAKE STORE IS A STORE, not a stub that answers `[]`. Runs the route
 * starts land in it and are read back by the next request, because "the fourth
 * run of the day is refused" is only a real claim if the first three wrote
 * something the fourth could find.
 */

/* ────────────────────────────────────────────────────────────────── the seams */

interface SweepOpts {
  domain: string
  spans: { emit: (s: Record<string, unknown>) => unknown }
  signal?: AbortSignal
}

const hoisted = vi.hoisted(() => ({
  afterTasks: [] as unknown[],
  /** Set to a function to stand in for the engine; null runs the real one. */
  sweepImpl: null as null | ((opts: SweepOpts) => Promise<unknown>),
  ports: null as unknown,
  model: null as unknown,
}))

vi.mock("next/server", () => ({
  after: (task: unknown) => {
    hoisted.afterTasks.push(task)
  },
}))

vi.mock("@openrouter/ai-sdk-provider", () => ({
  openrouter: () => hoisted.model,
  createOpenRouter: () => () => hoisted.model,
}))

/** The real engine by default, with its two ports replaced — the documented
 *  both-or-neither seam. A test that is about a limit rather than about
 *  spending swaps in `hoisted.sweepImpl` and saves itself four seconds. */
vi.mock("@open-kb/sweep", async (importOriginal) => {
  const real = await importOriginal<typeof import("@open-kb/sweep")>()
  return {
    ...real,
    sweep: (opts: Record<string, unknown>) =>
      hoisted.sweepImpl
        ? hoisted.sweepImpl(opts as unknown as SweepOpts)
        : real.sweep({ ...opts, ports: hoisted.ports } as Parameters<typeof real.sweep>[0]),
  }
})

const { POST } = await import("./route")
const { getRun } = await import("@/lib/runs")
const {
  LIMIT_VARS,
  MEASURED_RUN_COST,
  UNKNOWN_VISITOR,
  clientIp,
  defaultRunCapUsd,
  resetLedger,
  runUsd,
  tripAtUsd,
  visitorOf,
} = await import("@/lib/spend-limits")

/* ─────────────────────────────────────────────────────────────── a tiny market
 *
 * Two products, because nothing here is measuring the size of a map. The one
 * test that runs the real engine is measuring whether it can be stopped.
 */

const ANCHOR = "meterco.example"

const PRODUCTS = ["Usage Ledger", "Invoice Runner"] as const

/** Over 300 characters of readable text, which is the engine's own threshold for
 *  a surface it will believe (`s.text.length > 300` in sweep.ts). A shorter
 *  fixture reads as an unreadable company and the run dies before it spends a
 *  cent — which is a perfectly good run to have, and not the one under test. */
const LLMS_TXT =
  `# Meterco\n\nMeterco is a hosted metering suite for finance teams who bill their customers ` +
  `on usage and cannot reconcile that usage by hand at the end of a month.\n\n## Products\n\n` +
  `${PRODUCTS.map((p) => `- ${p}: part of the metering suite, sold as a hosted service.`).join("\n")}\n\n` +
  `## Buyers\n\nFinance and revenue teams at companies that bill on consumption, arriving after a ` +
  `billing period they could not close on time and unable to staff a metering team of their own.\n`

const VENDORS = Array.from({ length: 8 }, (_, i) => `vendor${i}.example`)

const page = (h: string) =>
  `<html><head><title>${h}</title></head><body><h1>${h}</h1><p>${h} sells hosted metering to ` +
  `finance teams who bill on usage and cannot reconcile it by hand.</p>` +
  `<p>Teams adopt this after a billing period they could not close on time. It runs as a hosted ` +
  `service, it keeps a retention window their auditors accept, and it bills on ingested volume ` +
  `rather than per seat.</p></body></html>`

const FETCH_TABLE: Record<string, { httpStatus: number; body: string; contentType?: string }> = {
  [`https://${ANCHOR}/llms.txt`]: { httpStatus: 200, body: LLMS_TXT, contentType: "text/plain" },
  [`https://${ANCHOR}/`]: { httpStatus: 200, contentType: "text/html", body: page("Meterco") },
  ...Object.fromEntries(
    VENDORS.map((v) => [`https://${v}/`, { httpStatus: 200, contentType: "text/html", body: page(v) }]),
  ),
}

class RollingSearch extends FakeSearch {
  constructor() {
    super({})
  }
  override async search(queries: string[]): Promise<Awaited<ReturnType<FakeSearch["search"]>>> {
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

function phaseOf(schema: unknown): string {
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

/**
 * The scripted model, with a dial on what each call costs.
 *
 * `tokensIn` is how this suite makes a run expensive without touching the
 * pricing table or naming a real model: the route prices whatever it is given
 * at `priceForModel`'s rate, so a call reporting a million input tokens costs a
 * million tokens' worth of real arithmetic through the real cost path. That is
 * the same route by which a genuine runaway would arrive — the engine
 * discovering a market that needs far more calls than the budget assumed — with
 * the size of the surprise turned up so a test can watch it happen in a second.
 */
function scriptedModel(tokensIn = 1_000): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ responseFormat, prompt }) => {
      const text = prompt
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]) : []))
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
      const phase = phaseOf(responseFormat)
      const product = productOf(text).toLowerCase()
      const object =
        phase === "understand"
          ? {
              sells: "a hosted metering suite for finance teams",
              buyer: "a finance team that bills on usage and reconciles it by hand",
              brand: "Meterco",
              products: PRODUCTS.map((name) => ({
                name,
                does: `runs ${name.toLowerCase()}`,
                foundAt: "",
              })),
              capabilities: PRODUCTS.map((name) => ({
                name: name.toLowerCase(),
                does: `does the ${name.toLowerCase()} job`,
                covers: [name],
                centrality: "core",
              })),
              coinages: ["Meterco"],
            }
          : phase === "catalog"
            ? {
                terms: [product],
                generic: false,
                queries: [
                  { q: `who solves ${product} without a vendor`, intent: "pain", platform: "web", why: "the buyer in trouble", market: product },
                  { q: `what teams use instead of ${product}`, intent: "switching", platform: "web", why: "the switcher", market: product },
                ],
              }
            : phase === "assess"
              ? { enough: false, missing: "the substitutes are thin", draw: [], queries: [] }
              : phase === "classify"
                ? {
                    name: "a vendor",
                    kind: "company",
                    what: "sells hosted metering to finance teams",
                    relation: "competitor",
                    why: "answers the same question for the same team",
                    spans: ["sells hosted metering to finance teams"],
                  }
                : { edges: [] }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(object) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: tokensIn, noCache: tokensIn, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 250, text: 250, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
}

/* ────────────────────────────────────────────────────────────── the fake store
 *
 * PostgREST over a stubbed `fetch`, which is the seam lib/store/supabase.ts
 * actually speaks over — it has no injectable client, and giving it one to
 * satisfy a test would be a wider change than the thing under test.
 *
 * It keeps rows. `upsertRun` merges on id the way the real `Prefer:
 * resolution=merge-duplicates` does, and the budget's `select` filters and
 * projects them, so a run this route starts is a row the NEXT request reads. A
 * fake that always answered `[]` would pass every test in this file while the
 * limiter counted nothing.
 */

interface Row {
  id: string
  status: string
  started_at: string
  usd?: number
  visitor?: string | null
}

let rows: Row[]
/** Set to make the store fail the way a down store fails. */
let storeStatus = 200

function serveStore(url: string, init?: RequestInit): Response | null {
  if (!url.includes("/rest/v1/")) return null
  const method = (init?.method ?? "GET").toUpperCase()

  if (url.includes("/rest/v1/run_spans")) return new Response("", { status: 201 })

  // `claim_run`, in TypeScript. The real one is plpgsql in
  // scripts/supabase-schema.sql and takes an advisory lock; what a stubbed
  // fetch can check is the CONTRACT — which limit bound, in which order, on
  // which counts, and that a claim leaves a row the next request sees. The
  // serialization itself is a property of Postgres and is not tested here.
  if (url.includes("/rest/v1/rpc/claim_run")) {
    if (storeStatus !== 200) return new Response("boom", { status: storeStatus })
    const a = JSON.parse(String(init?.body ?? "{}")) as Record<string, string | number | null>
    const since = Date.parse(String(a.p_since))
    const at = Date.parse(String(a.p_started_at))
    const today = rows.filter((r) => Date.parse(r.started_at) >= since)
    let spentUsd = 0
    let inFlight = 0
    let byVisitor = 0
    for (const r of today) {
      if (a.p_visitor !== null && r.visitor === a.p_visitor) byVisitor++
      if (r.status === "running") {
        if (at - Date.parse(r.started_at) <= Number(a.p_window_ms)) inFlight++
        spentUsd += Number(a.p_run_cap ?? 0)
        continue
      }
      spentUsd += r.usd ?? 0
    }
    const counts = { by_visitor: byVisitor, spent_usd: spentUsd, in_flight: inFlight }
    const refuse = (which: string) => Response.json({ ok: false, limit: which, ...counts })
    if (a.p_per_visitor !== null && byVisitor >= Number(a.p_per_visitor)) return refuse("visitor")
    if (a.p_day_cap !== null && spentUsd + Number(a.p_run_cap ?? 0) > Number(a.p_day_cap)) return refuse("day")
    if (a.p_at_once !== null && inFlight >= Number(a.p_at_once)) return refuse("at-once")
    if (!rows.some((r) => r.id === a.p_id)) {
      rows.push({
        id: String(a.p_id),
        status: "running",
        started_at: String(a.p_started_at),
        usd: 0,
        visitor: a.p_visitor === null ? null : String(a.p_visitor),
      })
    }
    return Response.json({ ok: true, ...counts })
  }

  if (url.includes("/rest/v1/runs")) {
    if (method === "POST") {
      for (const r of JSON.parse(String(init?.body ?? "[]")) as Row[]) {
        const at = rows.findIndex((x) => x.id === r.id)
        if (at === -1) rows.push(r)
        else rows[at] = { ...rows[at], ...r }
      }
      return new Response("", { status: 201 })
    }
    if (storeStatus !== 200) return new Response("boom", { status: storeStatus })
    const since = /started_at=gte\.([^&]+)/.exec(url)?.[1]
    const from = since ? Date.parse(decodeURIComponent(since)) : 0
    const matching = rows.filter((r) => Date.parse(r.started_at) >= from)
    return Response.json(
      matching.map((r) => ({
        started_at: r.started_at,
        status: r.status,
        usd: r.usd ?? 0,
        visitor: r.visitor ?? null,
      })),
    )
  }
  return new Response("", { status: 201 })
}

/* ─────────────────────────────────────────────────────────────────── harness */

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://kb.test/api/map", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  })
}

/** One visitor, spelled as a header a proxy would have written. */
const VISITOR_A = { "x-forwarded-for": "203.0.113.9" }
const VISITOR_B = { "x-forwarded-for": "198.51.100.4" }

/** Run the route and wait for the background task, so the run's row has landed
 *  by the time the next request counts it. */
async function map(headers: Record<string, string> = VISITOR_A, body: unknown = { domain: ANCHOR }) {
  const before = hoisted.afterTasks.length
  const res = await POST(post(body, headers))
  const json = (await res.json()) as { runId?: string; error?: string }
  for (const task of hoisted.afterTasks.slice(before)) await task
  return { status: res.status, ...json, run: json.runId ? getRun(json.runId) : undefined }
}

/** An engine that spends a stated number of dollars and returns a map. */
function costing(usd: number) {
  return async ({ domain, spans }: SweepOpts) => {
    spans.emit({
      runId: "ignored",
      agentId: "sweep",
      parentId: null,
      kind: "search",
      name: "serp",
      argsDigest: "a query",
      ms: 10,
      ok: true,
      usd,
    })
    return {
      anchor: domain,
      decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
      queries: [],
      entities: [],
      edges: [],
      stats: {
        queries: 1, results: 0, hosts: 0, kept: 0, tokIn: 0, tokOut: 0, tokReasoning: 0,
        serpCalls: 1, unlockerCalls: 0, usd, seconds: 1,
      },
      report: { domain, kept: 0, usd },
    }
  }
}

let dir: string
let search: RollingSearch
const saved: Record<string, string | undefined> = {}

const ENV_KEYS = [
  "OPENKB_RUNS_DIR",
  "OPENKB_DEMO",
  "OPENKB_PUBLIC_RUNS_PER_DAY",
  "OPENKB_CEILING_USD",
  "OPENKB_CEILING_BASE_USD",
  "OPENKB_RUN_CAP_USD",
  "OPENKB_DAY_CAP_USD",
  "OPENKB_RUNS_PER_VISITOR_PER_DAY",
  "OPENKB_RUNS_AT_ONCE",
  "OPENKB_VISITOR_SALT",
  "OPENKB_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "BRIGHTDATA_API_TOKEN",
  "BRIGHTDATA_SERP_ZONE",
  "BRIGHTDATA_UNLOCKER_ZONE",
  "OPENROUTER_API_KEY",
] as const

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openkb-map-limits-"))
  for (const k of ENV_KEYS) saved[k] = process.env[k]
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
  // Cheap by default. The one suite that needs the real engine says so.
  hoisted.sweepImpl = costing(0.02)
  search = new RollingSearch()
  hoisted.ports = { search, fetch: new FakeFetch(FETCH_TABLE) }
  hoisted.model = scriptedModel()
  rows = []
  storeStatus = 200
  resetLedger()

  process.env.OPENKB_RUNS_DIR = dir
  process.env.OPENKB_DEMO = ""
  delete process.env.OPENKB_PUBLIC_RUNS_PER_DAY
  delete process.env.OPENKB_CEILING_USD
  delete process.env.OPENKB_CEILING_BASE_USD
  delete process.env.OPENKB_RUN_CAP_USD
  delete process.env.OPENKB_DAY_CAP_USD
  delete process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY
  delete process.env.OPENKB_RUNS_AT_ONCE
  delete process.env.OPENKB_VISITOR_SALT
  delete process.env.OPENKB_MODEL
  process.env.SUPABASE_URL = "https://store.test"
  process.env.SUPABASE_SECRET_KEY = "k"
  process.env.BRIGHTDATA_API_TOKEN = "not-a-token"
  process.env.BRIGHTDATA_SERP_ZONE = "none"
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "none"
  process.env.OPENROUTER_API_KEY = "sk-test"

  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const served = serveStore(url, init)
      if (served) return served
      // Anything else is a real request — the OpenRouter usage endpoint, a
      // provider, a page. It must explode, not bill someone.
      throw new Error(`REAL NETWORK CALL ATTEMPTED FROM THE LIMITS TEST: ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* ═════════════════════════════════════════════════ 1. the per-run cap stops it */

describe("the per-run cap stops a run that is overspending, mid-run", () => {
  it("aborts the real engine part way through, and lets it finish when it fits", async () => {
    // THE REAL ENGINE, twice, over the same market — once with room and once
    // without — because "the cap stopped it" is only a claim about the cap if
    // the identical run completes when the cap is raised. Everything between the
    // HTTP body and the abort signal is shipped code: the span stream, its
    // running total, the watchdog, `failRun`, and the engine's own checkpoints.
    //
    // The model is dialled to a million input tokens a call so the ceiling
    // arrives in the first few calls rather than in four minutes. That is a
    // scaled-up version of exactly how a real runaway arrives — the engine
    // finding a market that needs far more calls than the budget assumed.
    hoisted.sweepImpl = null
    hoisted.model = scriptedModel(1_000_000)
    process.env.OPENKB_RUN_CAP_USD = "off"

    const whole = await map()
    expect(whole.run?.status).toBe("complete")
    const wholeUsd = whole.run!.spans.totalUsd()
    expect(wholeUsd).toBeGreaterThan(0.5)

    // Now the same run against a ceiling under half of what it costs.
    hoisted.model = scriptedModel(1_000_000)
    search = new RollingSearch()
    hoisted.ports = { search, fetch: new FakeFetch(FETCH_TABLE) }
    const cap = Math.round(wholeUsd * 40) / 100
    process.env.OPENKB_RUN_CAP_USD = String(cap)

    const { status, runId, run } = await map(VISITOR_B)
    expect(status).toBe(200)
    expect(runId).toBeTruthy()

    // STOPPED, not finished. A cap that lets a run complete and then complains
    // is a cap that spent the money first.
    expect(run?.status).toBe("failed")
    expect(run?.result).toBeUndefined()

    // IT SPENT SOMETHING AND IT SPENT MUCH LESS. This is a mid-run stop, not a
    // refusal to start, and not a run that quietly finished anyway.
    const spent = run!.spans.totalUsd()
    expect(spent).toBeGreaterThan(tripAtUsd(cap))
    expect(spent).toBeLessThan(wholeUsd)

    // THE SENTENCE A VISITOR READS. Not a ref, not "something went wrong": the
    // cap, what was spent, and the fact that the partial map is theirs to keep.
    expect(run?.error).toContain(`$${cap.toFixed(2)}`)
    expect(run?.error).toContain("kept")
    expect(run?.error).not.toMatch(/quote ref/)
    // And NOT the cancellation sentence. The watchdog aborts before it records,
    // which is right with money in flight, so the signal is set by the time
    // `failRun` reads it — a reader who touched nothing must not be told they
    // stopped this.
    expect(run?.error).not.toContain("Stopped.")

    // THE ROW SAYS SO TOO, with the cost on it — the column tomorrow's budget
    // reads, and the reason a failed run cannot be counted as free.
    const row = rows.find((r) => r.id === runId)
    expect(row?.status).toBe("failed")
    expect(row?.usd).toBeCloseTo(spent, 6)
  }, 60_000)

  it("stops within its cap when the calls in flight are the size of real ones", async () => {
    // THE RESERVE, MEASURED. The test above dials one model call up to a fifth
    // of the whole ceiling, which is not a shape any real run has — a classify
    // call costs $0.0004. At a realistic per-span cost the run must end UNDER
    // its cap, not merely near it, and that is what the held-back reserve buys.
    //
    // The engine here is a stand-in, shaped like the phase that does the
    // spending: the rank pool judges eight hosts at a time, and when the stop
    // arrives all eight in flight still land and still bill. That pool is the
    // overrun the reserve is sized against, so the test emits in pools of eight
    // and checks the signal between them, exactly where the engine checks it.
    const POOL = 8
    const PER_CALL = 0.004
    process.env.OPENKB_RUN_CAP_USD = "0.40"
    hoisted.sweepImpl = async ({ spans, signal }) => {
      for (let round = 0; round < 1_000; round++) {
        if (signal?.aborted) throw new Error("aborted")
        for (let i = 0; i < POOL; i++) {
          spans.emit({
            runId: "x", agentId: "rank", parentId: null, kind: "model", name: "classify",
            argsDigest: `host${round}-${i}`, ms: 1, ok: true, usd: PER_CALL,
          })
        }
        await new Promise((r) => setTimeout(r, 0))
      }
      throw new Error("the cap never fired")
    }

    const { run } = await map()
    expect(run?.status).toBe("failed")
    const spent = run!.spans.totalUsd()
    expect(spent).toBeGreaterThan(tripAtUsd(0.4))
    // UNDER the cap, not merely near it. And by more than a hair: the reserve is
    // $0.10 and a whole pool in flight is $0.032, so there is room to spare.
    expect(spent).toBeLessThanOrEqual(0.4)
    expect(spent).toBeLessThanOrEqual(tripAtUsd(0.4) + POOL * PER_CALL)
  })

  it("does not fire on a run that stays inside it", async () => {
    hoisted.sweepImpl = null
    hoisted.model = scriptedModel()
    process.env.OPENKB_RUN_CAP_USD = "5"

    const { run } = await map()
    expect(run?.status).toBe("complete")
    expect(run?.result).toBeDefined()
    expect(run!.spans.totalUsd()).toBeLessThan(5)
  }, 60_000)

  it("holds back a reserve, so the run ends at its cap rather than past it", () => {
    // The margin is the money counterpart of `DEADLINE_MARGIN_S`: the trip is
    // below the cap by whatever can still be in flight when the line is crossed.
    for (const cap of [0.41, 1.51, 3.74]) {
      expect(tripAtUsd(cap)).toBeLessThan(cap)
      expect(cap - tripAtUsd(cap)).toBeGreaterThanOrEqual(0.05)
    }
    // And the trip still clears the worst run of its own size, or the cap would
    // be stopping healthy maps. 18 queries is what a 300s host affords at
    // the DEFAULT rank width of 8; OPENKB_RANK_CONCURRENCY moves it (24
    // yields 43, measured), so this figure is the floor, not the shape.
    expect(tripAtUsd(defaultRunCapUsd(18))).toBeGreaterThan(runUsd(18) * 1.25)
  })

  it("is derived from the host's own budget, not a constant", () => {
    // A literal would have killed every run on Pro, where a healthy map costs
    // $0.76 — the same trap `QUERY_BUDGET` documents avoiding one unit along.
    expect(defaultRunCapUsd(18)).toBeGreaterThan(runUsd(18))
    expect(defaultRunCapUsd(70)).toBeGreaterThan(runUsd(70))
    expect(defaultRunCapUsd(70)).toBeGreaterThan(defaultRunCapUsd(18) * 3)
    // Above the $0.202 the owner measured on the deployment, and below the
    // $0.7099 the one recorded runaway spent. That is the whole window.
    expect(defaultRunCapUsd(18)).toBeGreaterThan(0.202)
    expect(defaultRunCapUsd(18)).toBeLessThan(0.7099)
  })
})

/* ══════════════════════════════════════════════════ 2. the day cap stops them */

describe("the daily cap refuses the next run", () => {
  it("counts what this deployment spent today and refuses when a run no longer fits", async () => {
    process.env.OPENKB_DAY_CAP_USD = "1"
    process.env.OPENKB_RUN_CAP_USD = "0.30"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
    hoisted.sweepImpl = costing(0.25)

    // Three runs, $0.25 each. The fourth needs $0.30 of headroom and $0.75 is
    // already gone, so it does not fit.
    for (let i = 0; i < 3; i++) expect((await map()).status).toBe(200)

    const refused = await map()
    expect(refused.status).toBe(429)
    expect(refused.runId).toBeUndefined()
    // AND NO ROW WAS WRITTEN. A refusal that still registers a run has spent
    // nothing and counted something, which corrupts tomorrow's arithmetic too.
    expect(rows).toHaveLength(3)

    // THE SENTENCE. Why, the real numbers, when it lifts, and what to do
    // instead — every one of the four, because "rate limited" teaches nothing.
    expect(refused.error).toContain("$1.00")
    expect(refused.error).toContain("$0.75")
    expect(refused.error).toContain("00:00 UTC")
    expect(refused.error).toMatch(/\d+[hm]/)
    expect(refused.error).toContain("github.com/mo-root/open-kb")
  })

  it("counts a run that FAILED, because a failed run still bought its searches", async () => {
    process.env.OPENKB_DAY_CAP_USD = "1"
    process.env.OPENKB_RUN_CAP_USD = "0.30"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"

    // Two runs that spend and then throw. Nothing about them produces a
    // `result`, so a budget reading `result->stats->usd` would call them free
    // and let the day run on.
    hoisted.sweepImpl = async ({ spans }) => {
      spans.emit({
        runId: "x", agentId: "sweep", parentId: null, kind: "search", name: "serp",
        argsDigest: "a query", ms: 10, ok: true, usd: 0.4,
      })
      throw new Error("provider fell over")
    }
    for (let i = 0; i < 2; i++) expect((await map()).status).toBe(200)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === "failed")).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => (r.usd ?? 0) > 0.39)).toBe(true)

    hoisted.sweepImpl = costing(0.01)
    expect((await map()).status).toBe(429)
  })

  it("holds a run that is still going at its cap, so three at once cannot overshoot", async () => {
    // THE PROPERTY THAT MAKES THE DAY CAP A CEILING RATHER THAN A HOPE. A run in
    // flight has spent something and recorded nothing; counted at zero, N of
    // them walk the budget past its limit while every one reads as free. So it
    // is held at the most it can still become, and settles to its real cost when
    // it ends — `Ledger.reserve()` and `settle()`, in a table.
    process.env.OPENKB_DAY_CAP_USD = "1"
    process.env.OPENKB_RUN_CAP_USD = "0.40"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
    process.env.OPENKB_RUNS_AT_ONCE = "off"

    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    hoisted.sweepImpl = async (opts) => {
      await held
      return costing(0.02)(opts)
    }

    // Two runs in flight. Nothing has finished, so nothing has recorded a cost —
    // and yet $0.80 of the dollar is committed.
    const first = POST(post({ domain: ANCHOR }, VISITOR_A))
    expect((await first).status).toBe(200)
    const second = POST(post({ domain: ANCHOR }, VISITOR_A))
    expect((await second).status).toBe(200)

    const third = await POST(post({ domain: ANCHOR }, VISITOR_A))
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: string }).error).toContain("still running")

    release()
    for (const task of hoisted.afterTasks) await task

    // Settled at actuals, so the reservation was a hold and not a charge: two
    // runs at $0.02 leave the day almost untouched and the next one fits again.
    expect((await map()).status).toBe(200)
  })

  it("spends the last cents on nothing rather than on a map that stops half way", async () => {
    // A WHOLE CAP HAS TO FIT. Admitting a run into $0.12 of headroom hands the
    // visitor a map its own ceiling cut in half — worse than the refusal, and it
    // spends the money anyway.
    process.env.OPENKB_DAY_CAP_USD = "1"
    process.env.OPENKB_RUN_CAP_USD = "0.40"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
    hoisted.sweepImpl = costing(0.7)

    expect((await map()).status).toBe(200)
    // $0.30 left, which is real money and still not enough for one map.
    expect((await map()).status).toBe(429)
  })
})

/* ═══════════════════════════════════════════════ 3. one visitor, not everybody */

describe("the per-visitor limit refuses the same visitor and not a different one", () => {
  it("gives each address its own allowance", async () => {
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "2"
    process.env.OPENKB_DAY_CAP_USD = "off"

    expect((await map(VISITOR_A)).status).toBe(200)
    expect((await map(VISITOR_A)).status).toBe(200)

    const refused = await map(VISITOR_A)
    expect(refused.status).toBe(429)
    expect(refused.error).toContain("2 a day")
    expect(refused.error).toContain("00:00 UTC")
    expect(refused.error).toContain("github.com/mo-root/open-kb")

    // THE OTHER HALF OF THE CLAIM, and the one a global counter would fail: a
    // different visitor is not affected by the first one's allowance.
    expect((await map(VISITOR_B)).status).toBe(200)
  })

  it("is not fooled by a forged x-forwarded-for", async () => {
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "1"
    process.env.OPENKB_DAY_CAP_USD = "off"

    expect((await map({ "x-forwarded-for": "203.0.113.9" })).status).toBe(200)

    // The same visitor, now prepending an address of their own choosing. Every
    // proxy APPENDS, so the honest entry is the LAST one — a limiter reading the
    // head of the chain has a header field for "please do not count this".
    const dodged = await map({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" })
    expect(dodged.status).toBe(429)
  })

  it("counts an unidentifiable caller as one shared visitor rather than as a new one", async () => {
    // Not an exemption. A request that arrives with nothing identifying it must
    // not read as a fresh visitor every time, or the limit is off by default on
    // exactly the hosts where headers cannot be trusted.
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "1"
    process.env.OPENKB_DAY_CAP_USD = "off"

    expect((await map({})).status).toBe(200)
    expect((await map({})).status).toBe(429)
  })

  it("counts a run from the moment it starts, not from the moment it ends", async () => {
    // Three requests fired together have to be able to see each other. A run
    // recorded only at its ending is a run a shell loop can start twenty times.
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "1"
    process.env.OPENKB_DAY_CAP_USD = "off"
    process.env.OPENKB_RUNS_AT_ONCE = "off"

    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    hoisted.sweepImpl = async (opts) => {
      await held
      return costing(0.01)(opts)
    }

    expect((await POST(post({ domain: ANCHOR }, VISITOR_A))).status).toBe(200)
    // Still running, nothing written at its ending, and the allowance is gone.
    expect((await POST(post({ domain: ANCHOR }, VISITOR_A))).status).toBe(429)

    release()
    for (const task of hoisted.afterTasks) await task
  })
})

describe("who is asking — reading an address off a chain", () => {
  it("prefers the platform's header, and takes the LAST entry of a chain", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9")
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }))).toBe("203.0.113.9")
    expect(
      clientIp(
        new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "9.9.9.9" }),
      ),
    ).toBe("203.0.113.9")
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9")
    expect(clientIp(new Headers())).toBeNull()
  })

  it("drops a port, which changes on every request", () => {
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.9:51234" }))).toBe("203.0.113.9")
    expect(clientIp(new Headers({ "x-real-ip": "[2001:db8::1]:443" }))).toBe("2001:db8::1")
    // A bare IPv6 address is full of colons and must survive untouched.
    expect(clientIp(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1")
  })

  it("unwraps an IPv4 address written the long way, instead of pooling every one of them", () => {
    // A proxy terminating a dual-stack socket reports `::ffff:203.0.113.9`.
    // Left as IPv6 its first four groups are all zero, so the /64 rule below
    // would put EVERY IPv4 visitor on such a host into one bucket sharing one
    // allowance — a limiter that over-refuses everybody rather than counting
    // anybody.
    const wrapped = visitorOf(new Headers({ "x-real-ip": "::ffff:203.0.113.9" }))
    const plain = visitorOf(new Headers({ "x-real-ip": "203.0.113.9" }))
    const other = visitorOf(new Headers({ "x-real-ip": "::ffff:198.51.100.4" }))
    expect(wrapped).toBe(plain)
    expect(wrapped).not.toBe(other)
  })

  it("counts an IPv6 visitor by their /64, which is the smallest thing they cannot pick", () => {
    // Every residential and mobile allocation is a /64 or larger, so the low
    // half is free to change between requests. Without this the per-visitor
    // limit is decoration for anyone on IPv6.
    const one = visitorOf(new Headers({ "x-real-ip": "2001:db8:1234:5678:aaaa:bbbb:cccc:dddd" }))
    const two = visitorOf(new Headers({ "x-real-ip": "2001:db8:1234:5678:1111:2222:3333:4444" }))
    const elsewhere = visitorOf(new Headers({ "x-real-ip": "2001:db8:1234:9999::1" }))
    expect(one).toBe(two)
    expect(one).not.toBe(elsewhere)
  })

  it("is a hash and not an address, and the salt changes it", () => {
    const h = visitorOf(new Headers({ "x-real-ip": "203.0.113.9" }))
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(h).not.toContain("203")
    process.env.OPENKB_VISITOR_SALT = "pepper"
    expect(visitorOf(new Headers({ "x-real-ip": "203.0.113.9" }))).not.toBe(h)
  })

  it("has no address to go on: every such request lands in the same bucket, not a fresh one each time", () => {
    // spend-limits.ts's own doc comment on UNKNOWN_VISITOR: "a request that
    // arrives with nothing identifying it must not count as a fresh visitor
    // every time, or the limit is off by default on exactly the hosts where
    // headers cannot be trusted." Untested until now — every other case in
    // this describe block supplies an IP. This is the one that supplies none.
    expect(visitorOf(new Headers())).toBe(UNKNOWN_VISITOR)
    expect(visitorOf(new Headers({ "user-agent": "curl/8.0" }))).toBe(UNKNOWN_VISITOR)
  })
})

/* ═══════════════════════════════════════════════════ 4. how many at one time */

describe("the deployment runs a small number at once", () => {
  it("refuses a run while its slots are full, and says how long to wait", async () => {
    process.env.OPENKB_RUNS_AT_ONCE = "2"
    process.env.OPENKB_DAY_CAP_USD = "off"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"

    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    hoisted.sweepImpl = async (opts) => {
      await held
      return costing(0.01)(opts)
    }

    expect((await POST(post({ domain: ANCHOR }, VISITOR_A))).status).toBe(200)
    expect((await POST(post({ domain: ANCHOR }, VISITOR_B))).status).toBe(200)

    const busy = await POST(post({ domain: ANCHOR }, VISITOR_A))
    expect(busy.status).toBe(429)
    const { error } = (await busy.json()) as { error: string }
    // It lifts by the clock, not at midnight, so it must not say midnight.
    expect(error).toContain("2 maps at a time")
    expect(error).toMatch(/about \d+ minute/)
    expect(error).not.toContain("UTC")

    release()
    for (const task of hoisted.afterTasks) await task
    expect((await map()).status).toBe(200)
  })

  it("binds against a burst, where every request reads the same empty day", async () => {
    // THE ONE THIS EXISTS FOR. Every other test in this file fires requests one
    // after another, and a limiter that reads, decides, and writes later passes
    // all of them: the row from request N has landed before request N+1 counts.
    // Fired together, the reads all happen before any write, all fifty see an
    // empty day, and all fifty are individually right. That is $20.50 against a
    // $5.00 cap, and it is why the count and the insert are one transaction.
    //
    // Fails on the shape this replaced: with `usageSince` and a later
    // `upsertRun`, twenty of twenty are admitted here.
    process.env.OPENKB_RUNS_AT_ONCE = "3"
    process.env.OPENKB_DAY_CAP_USD = "off"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"

    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    hoisted.sweepImpl = async (opts) => {
      await held
      return costing(0.01)(opts)
    }

    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        POST(post({ domain: ANCHOR }, { "x-forwarded-for": `203.0.113.${i + 1}` })),
      ),
    )
    const admitted = burst.filter((r) => r.status === 200).length
    expect(admitted).toBe(3)
    expect(burst.filter((r) => r.status === 429).length).toBe(17)
    // And the three that got in are three rows, not three claims and no runs.
    expect(rows.filter((r) => r.status === "running").length).toBe(3)

    release()
    for (const task of hoisted.afterTasks) await task
  })

  it("holds a burst to what the day's budget can pay for", async () => {
    // The same race in the currency that matters. $1.00 a day against a $0.41
    // run cap pays for two whole caps, and the last $0.18 buys nothing rather
    // than buying a map that stops a third of the way through.
    process.env.OPENKB_DAY_CAP_USD = "1.00"
    process.env.OPENKB_RUN_CAP_USD = "0.41"
    process.env.OPENKB_RUNS_AT_ONCE = "off"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"

    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    hoisted.sweepImpl = async (opts) => {
      await held
      return costing(0.01)(opts)
    }

    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        POST(post({ domain: ANCHOR }, { "x-forwarded-for": `198.51.100.${i + 1}` })),
      ),
    )
    expect(burst.filter((r) => r.status === 200).length).toBe(2)
    // Nothing that was refused may have cost anything, so the worst the day can
    // owe is the two caps that were reserved.
    expect(rows.length * 0.41).toBeLessThanOrEqual(1.0)

    release()
    for (const task of hoisted.afterTasks) await task
  })

  it("does not count a run whose instance died as still running", async () => {
    // A `running` row nobody will ever close would otherwise hold a slot for
    // ever, and the deployment would refuse everything until midnight. Anything
    // older than the host's own function limit cannot still be alive.
    process.env.OPENKB_RUNS_AT_ONCE = "1"
    process.env.OPENKB_DAY_CAP_USD = "off"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
    rows.push({
      id: "dead",
      status: "running",
      started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      usd: 0,
      visitor: null,
    })
    expect((await map()).status).toBe(200)
  })
})

/* ═══════════════════════════════════════════════════════ 5. failing closed */

describe("a limit nobody can read refuses the run rather than waving it through", () => {
  it("refuses on a malformed amount, naming the variable and the value", async () => {
    // `Number("$5")` is NaN and every comparison against NaN is false, so this
    // exact value silently disabled the ceiling this replaces. It is the single
    // likeliest way to write it.
    process.env.OPENKB_DAY_CAP_USD = "$5"

    const refused = await map()
    expect(refused.status).toBe(503)
    expect(refused.error).toContain(LIMIT_VARS.dayCap)
    expect(refused.error).toContain('"$5"')
    expect(refused.error).toContain("misconfigured")
    expect(rows).toHaveLength(0)
  })

  it("refuses on a malformed count too, and on a count that is not whole", async () => {
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "lots"
    expect((await map()).status).toBe(503)

    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "2.5"
    const fractional = await map()
    expect(fractional.status).toBe(503)
    expect(fractional.error).toContain("whole number")
  })

  it("refuses a negative and an infinity, which parse as numbers and are not amounts", async () => {
    for (const value of ["-1", "Infinity", "NaN"]) {
      process.env.OPENKB_DAY_CAP_USD = value
      expect((await map()).status).toBe(503)
    }
  })

  it("refuses when the two caps contradict each other, instead of saying the day is spent", async () => {
    // Otherwise every run is refused with "today's budget is spent" on a day
    // nothing has run, and the operator has no way to tell that from a busy day.
    process.env.OPENKB_DAY_CAP_USD = "0.25"
    process.env.OPENKB_RUN_CAP_USD = "0.40"

    const refused = await map()
    expect(refused.status).toBe(503)
    expect(refused.error).toContain("no map can ever start")
    expect(refused.error).toContain(LIMIT_VARS.dayCap)
    expect(refused.error).toContain(LIMIT_VARS.runCap)
  })

  it("refuses when the store cannot be counted, rather than reading silence as an empty day", async () => {
    // THE BRANCH THAT MATTERS MOST. A store that is down answering "nothing
    // today" reads as a full budget and hands a stranger's script the account —
    // the same shape as the NaN bug, one layer down.
    storeStatus = 500

    const refused = await map()
    expect(refused.status).toBe(503)
    expect(refused.error).toContain("cannot reach the database")
    expect(rows).toHaveLength(0)
  })

  it("says nothing and costs nothing when every limit is deliberately off", async () => {
    // "off" is a word, not a number, so no typo and no empty string can produce
    // it. A deployment that has said it reaches the store not at all.
    process.env.OPENKB_DAY_CAP_USD = "off"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
    process.env.OPENKB_RUNS_AT_ONCE = "off"
    storeStatus = 500

    expect((await map()).status).toBe(200)
  })

  it("still refuses on a malformed OPENKB_CEILING_USD, which used to be the whole bug", async () => {
    // The provider-side backstop is not the budget any more, but it is still a
    // guard, and a guard that vanishes on a typo is worse than no guard because
    // it is invisible in the dashboard.
    process.env.OPENKB_CEILING_USD = "$5"
    const refused = await map()
    expect(refused.status).toBe(503)
    expect(refused.error).toContain("OPENKB_CEILING_USD")
  })
})

/* ═════════════════════════════════════════════ 6. the deployment with no store */

describe("a deployment with no store counts in this process and says so in the log", () => {
  it("still meters, because the alternative is a laptop with no limits at all", async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "1"
    process.env.OPENKB_DAY_CAP_USD = "off"

    expect((await map(VISITOR_A)).status).toBe(200)
    expect((await map(VISITOR_A)).status).toBe(429)
    expect((await map(VISITOR_B)).status).toBe(200)
  })

  it("settles an ended run at what it really cost", async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
    process.env.OPENKB_DAY_CAP_USD = "1"
    process.env.OPENKB_RUN_CAP_USD = "0.30"
    process.env.OPENKB_RUNS_PER_VISITOR_PER_DAY = "off"
    hoisted.sweepImpl = costing(0.05)

    // Held at $0.30 each while running and settled at $0.05 each after, so far
    // more than three fit — which they would not if the hold were permanent.
    for (let i = 0; i < 6; i++) expect((await map()).status).toBe(200)
  })
})

/* ══════════════════════════════ 7. a dearer model is said, not just measured */

describe("a model swap is warned about in the log, not just measured", () => {
  // route.ts:501-505 — `MEASURED_RUN_COST` is fit to one model's per-call price;
  // a dearer one bills 6-8x as much per query (two runs in `runs/` prove it),
  // so the derived run cap silently under-covers a run and it stops early. The
  // warning is the only place that surfaces before an operator notices maps
  // cutting off — nothing before this suite drove `OPENKB_MODEL` off its
  // default and read `console.warn`, on either branch of the guard.
  it("names the measured model, the running one, and the fix once they diverge", async () => {
    process.env.OPENKB_MODEL = "anthropic/claude-3-haiku"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect((await map()).status).toBe(200)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(MEASURED_RUN_COST.model))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("anthropic/claude-3-haiku"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(LIMIT_VARS.runCap))
  })

  it("stays silent once the operator has set their own run cap", async () => {
    process.env.OPENKB_MODEL = "anthropic/claude-3-haiku"
    process.env.OPENKB_RUN_CAP_USD = "5"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect((await map()).status).toBe(200)

    expect(warn).not.toHaveBeenCalled()
  })

  it("stays silent on the measured model itself, the default for every deployment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect((await map()).status).toBe(200)

    expect(warn).not.toHaveBeenCalled()
  })
})
