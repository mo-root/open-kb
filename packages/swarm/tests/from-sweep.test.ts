import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { LanguageModel } from "ai"
import type { FetchPort, Ledger, SearchPort } from "@open-kb/core"
import {
  DEFAULT_RECALL_GAP_THRESHOLD,
  DEFAULT_VERIFY_COUNT,
  fromSweepArgv,
  GAP_CLUSTER_CAP,
  GAP_CLUSTER_SIZE,
  RECALL_GAP_NAMES,
  runSwarm,
  sweepSeedMissions,
  validateSweepRun,
  type SwarmOptions,
  type SweepRunLike,
} from "../src/index.js"

/**
 * The sweep→swarm handoff: a swarm run seeded from a sweep run's map — verify
 * the head, chase the gaps. The sweep run is CONTEXT, never claims: the swarm
 * map starts empty and its own mint/admit re-proves everything a verify
 * mission re-records. These tests pin the minting (deterministic selection
 * over the real brightdata sweep, reduced to the fields the handoff reads),
 * the caps, and the orchestrator wiring offline.
 */

const FIXTURE = new URL("./fixtures/sweep-brightdata-com-202608051650.json", import.meta.url)
const brightdataSweep = (): SweepRunLike => JSON.parse(readFileSync(FIXTURE, "utf8")) as SweepRunLike

const BD = { anchor: "brightdata.com", coinages: ["brightdata.com", "brightdata"] }

// ── verify missions: the head, re-proven ─────────────────────────────────────

describe("sweepSeedMissions: verify missions from the real sweep", () => {
  it("selects the top-8 competitor/substitute hosts by foundBy weight, seenIn tie-break, alpha last — deterministic", () => {
    const missions = sweepSeedMissions(brightdataSweep(), BD)
    const verify = missions.filter((m) => m.dedupeKey.startsWith("verify:"))
    expect(verify.map((m) => m.dedupeKey)).toEqual([
      "verify:scrapeless.com", // foundBy 5, seenIn 18
      "verify:decodo.com", // foundBy 5, seenIn 16
      "verify:scrapfly.io", // foundBy 4, seenIn 36
      "verify:firecrawl.dev", // foundBy 4, seenIn 26
      "verify:oxylabs.io", // foundBy 4, seenIn 25
      "verify:scraperapi.com", // foundBy 4, seenIn 24
      "verify:octoparse.com", // foundBy 4, seenIn 16
      "verify:iproyal.com", // foundBy 4, seenIn 15
    ])
    expect(verify).toHaveLength(DEFAULT_VERIFY_COUNT)
  })

  it("verify missions are peek-tier own-page questions in the 70..63 band, seeded with the host's own site", () => {
    const verify = sweepSeedMissions(brightdataSweep(), BD).filter((m) => m.dedupeKey.startsWith("verify:"))
    expect(verify.map((m) => m.priority)).toEqual([70, 69, 68, 67, 66, 65, 64, 63])
    for (const m of verify) {
      expect(m.tier).toBe("peek")
      expect(m.lens).toBe("verify")
      const host = m.dedupeKey.slice("verify:".length)
      expect(m.seeds).toEqual([`https://${host}`])
      expect(m.brief).toContain(`Open ${host}'s own site`)
      expect(m.brief).toContain("Confirm from its own pages or correct the record")
    }
  })

  it("the sweep's own why rides the brief verbatim — the mission carries what the sweep believed", () => {
    const [top] = sweepSeedMissions(brightdataSweep(), BD)
    expect(top!.dedupeKey).toBe("verify:scrapeless.com")
    expect(top!.brief).toContain("genuinely competitor to brightdata.com")
    expect(top!.brief).toContain(
      "Sells competing web scraping APIs, scraping browsers, and residential/ISP proxies to developers " +
        "and enterprise buyers who would otherwise use brightdata.com.",
    )
  })

  it("the anchor's own row never becomes a verify mission — the sweep's brightdata.com entity is excluded", () => {
    const missions = sweepSeedMissions(brightdataSweep(), BD)
    expect(missions.some((m) => m.dedupeKey === "verify:brightdata.com")).toBe(false)
  })

  it("verifyCount caps the head: 3 mints exactly the top three", () => {
    const verify = sweepSeedMissions(brightdataSweep(), { ...BD, verifyCount: 3 }).filter((m) =>
      m.dedupeKey.startsWith("verify:"),
    )
    expect(verify.map((m) => m.dedupeKey)).toEqual([
      "verify:scrapeless.com",
      "verify:decodo.com",
      "verify:scrapfly.io",
    ])
  })
})

// ── gap missions: what the sweep could not decide ────────────────────────────

describe("sweepSeedMissions: unknown-cluster gap missions", () => {
  it("clusters the highest-weight unknowns into read missions, capped at 2, five hosts each", () => {
    const gaps = sweepSeedMissions(brightdataSweep(), BD).filter((m) => m.dedupeKey.startsWith("gap:unknowns"))
    expect(gaps.map((m) => m.dedupeKey)).toEqual(["gap:unknowns-1", "gap:unknowns-2"])
    expect(gaps).toHaveLength(GAP_CLUSTER_CAP)
    for (const m of gaps) {
      expect(m.tier).toBe("read")
      expect(m.priority).toBe(62)
      expect(m.lens).toBe("unknowns")
    }
    // The first cluster is the sweep's loudest undecided hosts, in weight order.
    for (const host of ["youtube.com", "reddit.com", "linkedin.com", "quora.com", "medium.com"]) {
      expect(gaps[0]!.brief).toContain(host)
    }
    // The second cluster picks up where the first stopped — parsehub.com is the
    // real weak spot in this run: a working competitor the sweep never settled.
    for (const host of ["g2.com", "parsehub.com"]) expect(gaps[1]!.brief).toContain(host)
    expect(gaps[0]!.brief.match(/[a-z0-9.-]+\.[a-z]{2,}/g)!.length).toBeLessThanOrEqual(GAP_CLUSTER_SIZE + 2)
  })

  it("an unknown seen by a single lane does not qualify — high seenIn is the bar", () => {
    const run: SweepRunLike = {
      anchor: "anchor.com",
      entities: [
        { name: "lone", domain: "lone.com", kind: "unknown", relation: "unknown", why: "", foundBy: ["One Lane"] },
      ],
    }
    const missions = sweepSeedMissions(run, { anchor: "anchor.com" })
    expect(missions.some((m) => m.dedupeKey.startsWith("gap:unknowns"))).toBe(false)
  })
})

// ── the recall-gap mission ───────────────────────────────────────────────────

describe("sweepSeedMissions: the recall-gap mission", () => {
  it("a pooled recall below the threshold mints one read mission naming up to 6 unfound vendors", () => {
    const missions = sweepSeedMissions(brightdataSweep(), BD) // pooled 0.234 < 0.5
    const recall = missions.find((m) => m.dedupeKey === "gap:recall")
    expect(recall).toBeDefined()
    expect(recall!.tier).toBe("read")
    expect(recall!.priority).toBe(61)
    // Rarest-first: a host nearly every probe page links (github.com in 6 of 7)
    // is page furniture; the genuine miss is the vendor one roundup names.
    for (const host of ["922proxy.com", "9kw.eu", "9proxy.com", "abcproxy.com", "ahrefs.com", "anypicker.com"]) {
      expect(recall!.brief).toContain(host)
    }
    expect(recall!.brief).not.toContain("github.com")
    // The junk the sweep's own host-capture bug shipped never becomes a question.
    expect(recall!.brief).not.toContain("?ref=")
    // The anchor's alias sites are not missing vendors.
    expect(recall!.brief).not.toContain("brightdata.de")
    expect(recall!.brief).toContain("23%")
  })

  it("the threshold is configurable, and a pooled recall above it mints nothing", () => {
    expect(DEFAULT_RECALL_GAP_THRESHOLD).toBe(0.5)
    const missions = sweepSeedMissions(brightdataSweep(), { ...BD, recallGapThreshold: 0.2 })
    expect(missions.some((m) => m.dedupeKey === "gap:recall")).toBe(false)
  })

  it("a run with no recall report, or a null pooled figure, mints no recall mission", () => {
    const bare: SweepRunLike = {
      anchor: "anchor.com",
      entities: [{ name: "r", domain: "rival.com", kind: "company", relation: "competitor", why: "same job" }],
    }
    expect(sweepSeedMissions(bare, { anchor: "anchor.com" }).some((m) => m.dedupeKey === "gap:recall")).toBe(false)
    const nullPooled: SweepRunLike = {
      ...bare,
      report: { recall: { pooled: null, probes: [] } },
    }
    expect(sweepSeedMissions(nullPooled, { anchor: "anchor.com" }).some((m) => m.dedupeKey === "gap:recall")).toBe(
      false,
    )
  })
})

// ── the orchestrator wiring, offline ─────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rivalHtml =
  `<html><body><h1>Rival</h1><p>Rival sells a fraud scoring API to online merchants. ` +
  `The platform scores every checkout in real time and flags stolen cards before authorization.</p></body></html>`

const HIT = { url: "https://rival.com", title: "Rival", description: "Rival sells fraud scoring to online merchants" }

function fakeSearch(): SearchPort {
  return {
    async search(queries) {
      return queries.map((query) => ({ query, hits: [HIT], ok: true, usd: 0.001, ms: 1 }))
    },
  }
}

function fakeFetch(): FetchPort {
  return {
    async get(url) {
      return { url, httpStatus: 200, body: rivalHtml, ms: 1, usd: 0 }
    },
  }
}

const SKILL = "# Doctrine\nProve what you claim with a quote from bytes this run fetched.\nRecord as you go."

const call = (id: string, toolName: string, input: unknown) => [
  { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
]
const text = (s: string) => [{ type: "text" as const, text: s }]
const usage = (inTok = 100, outTok = 20) => ({
  inputTokens: { total: inTok, noCache: inTok, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: outTok, text: outTok, reasoning: 0 },
})
const reply = <C,>(content: C, done: boolean, u = usage()) => ({
  content,
  finishReason: { unified: done ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
  usage: u,
  warnings: [],
})
const leadTurnOf = (prompt: ReadonlyArray<{ role: string }>) => prompt.filter((m) => m.role === "user").length
const invTurnOf = (prompt: ReadonlyArray<{ role: string }>) => prompt.filter((m) => m.role === "tool").length

/** The orient seed: one search, one company recorded off the snippet, then a
 *  short sleep so the seed lands after the lead's first turn settled. */
const orientingSeed = () =>
  new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const turn = invTurnOf(prompt)
      if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
      if (turn === 1)
        return reply(
          call("r1", "remember", {
            nodes: [
              {
                name: "Rival",
                domain: "rival.com",
                kind: "company",
                what: "fraud scoring",
                relation: "competitor",
                why: "same capability sold to the same buyer, per the engine's snippet",
                evidence: [{ url: "https://rival.com", quote: "Rival sells fraud scoring" }],
              },
            ],
            why: "orientation records the field it found",
          }),
          false,
        )
      await sleep(40)
      return reply(text("oriented."), true)
    },
  })

/** A handoff-mission investigator: one turn, no tools — lands with zero nodes. */
const quietModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => reply(text("the handoff's question noted."), true),
  })

const zero = { inUsdPerM: 0, outUsdPerM: 0 }

function mkOpts(o: {
  lead: LanguageModel
  seed: LanguageModel
  logs?: string[]
  over?: Partial<SwarmOptions>
}): SwarmOptions {
  const quiet = quietModel()
  return {
    domain: "anchor.com",
    skill: SKILL,
    search: fakeSearch(),
    fetch: fakeFetch(),
    models: { lead: o.lead, peek: quiet, read: quiet, dig: o.seed },
    pricing: { lead: zero, peek: zero, read: zero, dig: zero },
    ...(o.logs ? { onLog: (l: string) => o.logs!.push(l) } : {}),
    ...(o.over ?? {}),
  }
}

const balanced = (ledger: Ledger) =>
  Math.abs(ledger.spendable() + ledger.spentUsd() + ledger.finishReserveUsd - ledger.ceilingUsd) < 1e-9

/** A small sweep run whose handoff mints exactly four missions: two verify,
 *  one unknown cluster, one recall gap. */
const miniSweep = (): SweepRunLike => ({
  anchor: "anchor.com",
  entities: [
    {
      name: "Rival",
      domain: "rival.com",
      kind: "company",
      relation: "competitor",
      why: "same fraud scoring sold to the same merchants",
      foundBy: ["Scoring", "Checkout"],
    },
    {
      name: "Rules",
      domain: "rules.com",
      kind: "product",
      relation: "substitute",
      why: "a hand-written rules engine instead of scoring",
      foundBy: ["Scoring"],
    },
    { name: "maybe.com", domain: "maybe.com", kind: "unknown", relation: "unknown", why: "", foundBy: ["Scoring", "Checkout"] },
    { name: "maybe2.com", domain: "maybe2.com", kind: "unknown", relation: "unknown", why: "", foundBy: ["Scoring", "Checkout"] },
  ],
  report: {
    recall: {
      pooled: 0.25,
      probes: [{ url: "https://roundup.com/best", vendors: ["missed.com", "rival.com"], found: ["rival.com"] }],
    },
  },
  searched: [{ hits: [{ url: "https://rival.com/pricing" }] }],
})

const MINI_KEYS = ["verify:rival.com", "verify:rules.com", "gap:unknowns-1", "gap:recall"]

describe("runSwarm: fromSweep seeds the board when orientation lands", () => {
  it("the handoff's missions fund and run; the family floor stays closed by default — the sweep already asked those questions", async () => {
    const logs: string[] = []
    const turns: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        turns[turn] = JSON.stringify(prompt.filter((m) => m.role === "user").at(-1)?.content ?? "")
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 5 }, why: "the seed plus the handoff" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), logs, over: { fromSweep: miniSweep() } }))

    expect(run.ending.reason).toBe("lead-finished")
    const landedKeys = run.landings.map((l) => l.mission.dedupeKey)
    expect(landedKeys).toContain("orient:anchor.com")
    for (const k of MINI_KEYS) expect(landedKeys).toContain(k)
    expect(run.landings).toHaveLength(5)
    // Funded in priority order, narrated per mission.
    const funded = logs
      .map((l) => /sweep handoff: p\d+ ((?:verify|gap):\S+) funded/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined)
    expect(funded).toEqual(MINI_KEYS)
    // The family floor never opened: no floor narration, no family:* rows.
    expect(logs.some((l) => l.includes("family floor"))).toBe(false)
    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com", ...MINI_KEYS])
    expect(run.families.every((f) => f.status === "landed")).toBe(true)
    // The handoff's questions count as families: the scorecard's denominator is real.
    expect(run.scorecard.familiesWithPageTier.den).toBe(5)
    // The lead heard the handoff in-band, with the honesty line.
    expect(turns[2]).toContain("the sweep handoff opened 4")
    expect(turns[2]).toContain("context, never claims")
    expect(balanced(run.ledger)).toBe(true)
  })

  it("an explicit familyFloor runs beside the handoff — the handoff's targeted questions fund first", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 7 }, why: "seed, handoff, floor" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({ lead, seed: orientingSeed(), logs, over: { fromSweep: miniSweep(), familyFloor: 2 } }),
    )

    expect(run.ending.reason).toBe("lead-finished")
    // Both opened; the handoff's rows precede the floor's — targeted questions
    // take their money first, and at equal priority the board's insertion
    // tie-break runs them first too.
    expect(run.families.map((f) => f.dedupeKey)).toEqual([
      "orient:anchor.com",
      ...MINI_KEYS,
      "family:market",
      "family:competitors",
    ])
    expect(run.landings).toHaveLength(7)
    expect(balanced(run.ledger)).toBe(true)
  })

  it("a pool too small funds the handoff partially, wearing spawn's refusal sentence — no ledger row, no residue", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 5 }, why: "what the pool funds" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    // Seven unknowns make the handoff five missions: two peeks ($0.06), two
    // cluster reads ($0.20), the recall read ($0.10) — $0.36 asked. Ceiling
    // $0.45: reserve $0.12, pool $0.33. The seed dig holds $0.25 (spendable
    // stays above a peek, so no budget-floor wake) and settles at ~$0.001;
    // $0.329 funds everything but the last read — gap:recall finds $0.069
    // and is refused with the same sentence spawn gives the lead.
    const rich = miniSweep()
    for (let i = 3; i <= 7; i++) {
      rich.entities.push({
        name: `maybe${i}.com`,
        domain: `maybe${i}.com`,
        kind: "unknown",
        relation: "unknown",
        why: "",
        foundBy: ["Scoring", "Checkout"],
      })
    }
    const run = await runSwarm(
      mkOpts({ lead, seed: orientingSeed(), logs, over: { fromSweep: rich, ceilingUsd: 0.45 } }),
    )

    expect(run.ending.reason).toBe("lead-finished")
    const funded = logs
      .map((l) => /sweep handoff: p\d+ ((?:verify|gap):\S+) funded/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined)
    expect(funded).toEqual(["verify:rival.com", "verify:rules.com", "gap:unknowns-1", "gap:unknowns-2"])
    expect(
      logs.some((l) => l.includes("sweep handoff: gap:recall not funded — the pool no longer funds a read; re-tier it or drop it")),
    ).toBe(true)
    expect(run.families.map((f) => f.dedupeKey)).toEqual([
      "orient:anchor.com",
      "verify:rival.com",
      "verify:rules.com",
      "gap:unknowns-1",
      "gap:unknowns-2",
    ])
    expect(run.ending.residue.map((r) => r.dedupeKey)).not.toContain("gap:recall")
    // The lead heard the refusal in-band on its next turn.
    expect(run.landings).toHaveLength(5)
    expect(balanced(run.ledger)).toBe(true)
  })

  it("a sweep run with nothing to hand off is narrated, not seeded", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "the seed alone" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    // Every entity is the anchor itself or a none: nothing qualifies.
    const empty: SweepRunLike = {
      anchor: "anchor.com",
      entities: [
        { name: "anchor", domain: "anchor.com", kind: "company", relation: "competitor", why: "itself" },
        { name: "blog", domain: "blog.example.com", kind: "publisher", relation: "none", why: "" },
      ],
    }
    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), logs, over: { fromSweep: empty } }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com"])
    expect(logs.some((l) => l.includes("sweep handoff: the sweep run offered nothing to verify or chase"))).toBe(true)
  })
})

// ── the CLI seam: argv and run-file validation ───────────────────────────────

describe("fromSweepArgv: the --from-sweep flag, out of a positional argv", () => {
  it("pulls the flag and its path, leaving the positionals in order", () => {
    expect(fromSweepArgv(["brightdata.com", "--from-sweep", "runs/sweep.json", "2.5"])).toEqual({
      rest: ["brightdata.com", "2.5"],
      path: "runs/sweep.json",
      problem: null,
    })
    expect(fromSweepArgv(["--from-sweep", "runs/sweep.json", "brightdata.com"])).toEqual({
      rest: ["brightdata.com"],
      path: "runs/sweep.json",
      problem: null,
    })
  })

  it("accepts the = spelling", () => {
    expect(fromSweepArgv(["brightdata.com", "--from-sweep=runs/sweep.json"])).toEqual({
      rest: ["brightdata.com"],
      path: "runs/sweep.json",
      problem: null,
    })
  })

  it("no flag means no path and untouched positionals", () => {
    expect(fromSweepArgv(["brightdata.com", "1.5"])).toEqual({ rest: ["brightdata.com", "1.5"], path: null, problem: null })
    expect(fromSweepArgv([])).toEqual({ rest: [], path: null, problem: null })
  })

  it("a flag without a path is a problem in words, not a silent nothing", () => {
    expect(fromSweepArgv(["brightdata.com", "--from-sweep"]).problem).toBe(
      "--from-sweep needs a path to a sweep run JSON",
    )
    expect(fromSweepArgv(["--from-sweep", "--something", "brightdata.com"]).problem).toBe(
      "--from-sweep needs a path to a sweep run JSON",
    )
    expect(fromSweepArgv(["--from-sweep=", "brightdata.com"]).problem).toBe(
      "--from-sweep needs a path to a sweep run JSON",
    )
  })
})

describe("validateSweepRun: the run file must be a sweep run of the same market", () => {
  const good = (): unknown => ({
    anchor: "brightdata.com",
    entities: [{ name: "r", domain: "rival.com", kind: "company", relation: "competitor", why: "same job" }],
  })

  it("accepts a sweep-shaped run of the same domain, www and subdomain spellings included", () => {
    const v = validateSweepRun(good(), "brightdata.com")
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.run.anchor).toBe("brightdata.com")
    expect(validateSweepRun(good(), "www.brightdata.com").ok).toBe(true)
  })

  it("refuses a different market by name — a handoff verifies the same market", () => {
    const v = validateSweepRun(good(), "resend.com")
    expect(v).toEqual({
      ok: false,
      reason: "the sweep mapped brightdata.com; this swarm is aimed at resend.com — a handoff verifies the same market, not a different one",
    })
  })

  it("refuses non-run shapes with the missing piece named", () => {
    expect(validateSweepRun(null, "x.com")).toMatchObject({ ok: false, reason: expect.stringContaining("not a run object") })
    expect(validateSweepRun([], "x.com")).toMatchObject({ ok: false, reason: expect.stringContaining("not a run object") })
    expect(validateSweepRun({ entities: [] }, "x.com")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no anchor"),
    })
    expect(validateSweepRun({ anchor: "x.com", entities: [] }, "x.com")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no entities"),
    })
    expect(validateSweepRun({ anchor: "x.com", entities: [{ name: "a" }] }, "x.com")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("entity 0"),
    })
  })

  it("the committed brightdata fixture validates as-is", () => {
    const v = validateSweepRun(JSON.parse(readFileSync(FIXTURE, "utf8")), "brightdata.com")
    expect(v.ok).toBe(true)
  })
})
