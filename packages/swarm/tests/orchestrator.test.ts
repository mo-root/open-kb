import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { LanguageModel } from "ai"
import {
  computeScorecard,
  scorecardSentences,
  SpanStream,
  type FetchPort,
  type Ledger,
  type RecallReport,
  type SearchPort,
} from "@open-kb/core"
import {
  DEFAULT_CEILING_USD,
  DEFAULT_FAMILY_FLOOR,
  DEFAULT_GRACE_MS,
  DEFAULT_LANES,
  DEFAULT_STILLBORN_MS,
  DEFAULT_WALL_MS,
  runSwarm,
  seedMission,
  serializeSwarmRun,
  sweepSeedMissions,
  type SwarmEnding,
  type SwarmOptions,
  type SwarmRun,
  type SweepRunLike,
} from "../src/index.js"

/**
 * The orchestrator, offline: scripted models over fake ports. Every test runs
 * the real loop — fill/think/wake, the ledger, the board, the map — and only
 * the model replies and the wire are scripted.
 */

// ── fakes ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Padded past core's THIN_TEXT floor (200 extracted chars) so sniff() says found.
const rivalHtml =
  `<html><body><h1>Rival</h1><p>Rival sells a fraud scoring API to online merchants. ` +
  `The platform scores every checkout in real time, flags stolen cards before authorization, ` +
  `and hands risk teams a review queue so a small fraud team can cover a large storefront ` +
  `without writing rules by hand.</p></body></html>`

const HIT = { url: "https://rival.com", title: "Rival", description: "Rival sells fraud scoring to online merchants" }

function fakeSearch(o: { usd?: number; hits?: Array<typeof HIT> } = {}): SearchPort {
  return {
    async search(queries) {
      return [...new Set(queries)].map((query) => ({ query, hits: o.hits ?? [HIT], ok: true, usd: o.usd ?? 0.001, ms: 1 }))
    },
  }
}

function fakeFetch(rows: Record<string, { httpStatus: number; body: string; delayMs?: number; usd?: number }> = {}): FetchPort {
  return {
    async get(url) {
      const row = rows[url] ?? { httpStatus: 200, body: rivalHtml }
      if (row.delayMs) await sleep(row.delayMs)
      return { url, httpStatus: row.httpStatus, body: row.body, ms: 1, usd: row.usd ?? 0 }
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

/** Turn index for a lead script: the runner pushes one user message per turn. */
const leadTurnOf = (prompt: ReadonlyArray<{ role: string }>) => prompt.filter((m) => m.role === "user").length

/** Turn index for an investigator script: one tool result lands per turn taken. */
const invTurnOf = (prompt: ReadonlyArray<{ role: string }>) => prompt.filter((m) => m.role === "tool").length

/** A quick investigator: one search (which also proves the run alive), done. */
const quickInvestigator = () =>
  new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const turn = invTurnOf(prompt)
      if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
      return reply(text("done."), true)
    },
  })

const zero = { inUsdPerM: 0, outUsdPerM: 0 }

function mkOpts(o: {
  lead: LanguageModel
  inv?: LanguageModel
  tiers?: Partial<Record<"peek" | "read" | "dig", LanguageModel>>
  logs?: string[]
  over?: Partial<SwarmOptions>
}): SwarmOptions {
  const inv = o.inv ?? quickInvestigator()
  const logs = o.logs
  return {
    domain: "anchor.com",
    skill: SKILL,
    search: fakeSearch(),
    fetch: fakeFetch(),
    models: { lead: o.lead, peek: o.tiers?.peek ?? inv, read: o.tiers?.read ?? inv, dig: o.tiers?.dig ?? inv },
    pricing: { lead: zero, peek: zero, read: zero, dig: zero },
    ...(logs ? { onLog: (l: string) => logs.push(l) } : {}),
    ...(o.over ?? {}),
  }
}

/** Every ending, whatever the reason, ships the same complete frame — and a
 *  balanced ledger: no claim outstanding, so spendable + spent + the finish
 *  reserve reassembles the ceiling exactly. The aborted ending is the one
 *  caller that cannot hand a ledger over: the thrown error carries only the
 *  terminal frame. */
function expectEndingShape(e: SwarmEnding, ledger?: Ledger) {
  expect(e.kind).toBe("terminated")
  expect(typeof e.reason).toBe("string")
  expect(typeof e.humanReason).toBe("string")
  expect(e.humanReason.length).toBeGreaterThan(10)
  expect(typeof e.atSec).toBe("number")
  expect(typeof e.spentUsd).toBe("number")
  expect(typeof e.nodes).toBe("number")
  expect(typeof e.edges).toBe("number")
  expect(Array.isArray(e.residue)).toBe(true)
  if (ledger) {
    expect(
      Math.abs(ledger.spendable() + ledger.spentUsd() + ledger.finishReserveUsd - ledger.ceilingUsd),
    ).toBeLessThan(1e-9)
  }
}

const mission = (dedupeKey: string, priority: number, tier: string) => ({
  lens: "rivals",
  brief: `who else sells this (${dedupeKey})`,
  why: "the shortlist is what a reader checks first",
  priority,
  tier,
  dedupeKey,
})

// ── the config defaults ─────────────────────────────────────────────────────

describe("orchestrator: the config defaults every omitting test leans on", () => {
  // DEFAULT_LANES already gets pinned inline, twice below ("at DEFAULT lanes"),
  // because so many calls below build `over` without `lanes` and the test's
  // own assertions only hold at the fallback's actual value. The same is true
  // of its four siblings — MEASURED by grepping this file: of 24
  // `runSwarm(mkOpts(...))` calls, only 5 set `ceilingUsd`, 4 set `wallClockMs`,
  // 2 set `graceMs`, and 1 sets `stillbornWindowMs`, so the rest silently run
  // on whatever orchestrator.ts's `?? DEFAULT_*` falls back to — yet unlike
  // DEFAULT_LANES, none of the four had a single pin anywhere in this suite.
  // A change to any of them would pass every test here and only surface as a
  // behavior change in production.
  it("pins the ceiling, wall, grace and stillborn-window fallbacks", () => {
    expect(DEFAULT_CEILING_USD).toBe(1.5)
    expect(DEFAULT_WALL_MS).toBe(300_000)
    expect(DEFAULT_GRACE_MS).toBe(30_000)
    expect(DEFAULT_STILLBORN_MS).toBe(30_000)
  })
})

// ── the seed ────────────────────────────────────────────────────────────────

describe("seedMission: the harness's own first question", () => {
  it("asks the orient question at priority 100, tier dig, seeded from the domain", () => {
    const m = seedMission("anchor.com")
    expect(m.lens).toBe("orientation")
    expect(m.priority).toBe(100)
    expect(m.tier).toBe("dig")
    expect(m.dedupeKey).toBe("orient:anchor.com")
    expect(m.seeds).toEqual(["https://anchor.com"])
    expect(m.brief).toContain("anchor.com")
    expect(m.why.length).toBeGreaterThan(0)
  })

  it("keys on the registrable host, not the raw domain it is handed", () => {
    // registrableHost has its own tests for the general case (url.test.ts); what
    // matters here is that seedMission actually routes the domain through it
    // rather than keying the mission on whatever string the caller passed.
    const m = seedMission("www.docs.apify.com")
    expect(m.dedupeKey).toBe("orient:apify.com")
    expect(m.seeds).toEqual(["https://apify.com"])
    expect(m.brief).toContain("apify.com")
    expect(m.brief).not.toContain("docs.apify.com")
  })

  it("falls back to the raw domain when registrableHost has nothing to give back", () => {
    // registrableHost("") is "", which is falsy — the `|| domain` fallback is
    // what keeps seedMission from keying a mission on an empty string.
    const m = seedMission("")
    expect(m.dedupeKey).toBe("orient:")
    expect(m.seeds).toEqual(["https://"])
  })
})

// ── the loop ────────────────────────────────────────────────────────────────

describe("runSwarm: fill/think/wake", () => {
  it("processes landings while the lead is thinking — nothing barriers", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            call("1", "spawn", {
              missions: [mission("m1", 90, "read"), mission("m2", 80, "read")],
              why: "two lanes at once",
            }),
            false,
          )
        if (turn >= 2) {
          // The lead THINKS: this turn refuses to end until m2's landing has
          // been narrated. If landings needed the lead to be idle, this would
          // deadlock — the timeout below is the barrier detector. Turn 3 is
          // the same script restating finish after the gate's one refusal.
          const t = Date.now()
          while (!logs.some((l) => l.includes("lane frees: rivals (m2)"))) {
            if (Date.now() - t > 3_000) throw new Error("no landing arrived while the lead was thinking")
            await sleep(5)
          }
          return reply(
            call("2", "finish", { reason: "mapped", summary: "the map holds it", unresolved: [], why: "done" }),
            false,
          )
        }
        return reply(text("idle."), true)
      },
    })
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        await sleep(40)
        return reply(text("done."), true)
      },
    })

    const run = await runSwarm(mkOpts({ lead, inv, logs }))

    expect(run.ending.reason).toBe("lead-finished")
    expectEndingShape(run.ending, run.ledger)
    const keys = run.landings.map((l) => l.mission.dedupeKey)
    expect(keys).toContain("m1")
    expect(keys).toContain("m2")
    // The landing was narrated BEFORE the thinking turn came back: interleave.
    const landedAt = logs.findIndex((l) => l.includes("lane frees: rivals (m2)"))
    const turnDoneAt = logs.findIndex((l) => l.includes("lead turn 2"))
    expect(landedAt).toBeGreaterThanOrEqual(0)
    expect(turnDoneAt).toBeGreaterThan(landedAt)
  })

  it("narrates the lead's buying: spawn and refusal counts ride every turn line, and a landing frees its lane on screen", async () => {
    // Live run 1 spawned nothing for 16 turns and the console never said so —
    // the only way to learn it was to diff the run JSON. The counts are now on
    // every turn line, zeros included, because the zero IS the finding.
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            call("1", "spawn", {
              missions: [mission("m1", 90, "read"), mission("m-untiered", 85, "mega")],
              why: "one fundable, one wearing a tier money does not know",
            }),
            false,
          )
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, logs }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(logs.some((l) => / — spawned 1, refused 1$/.test(l) && l.includes("lead turn 1"))).toBe(true)
    // Turns 2 and 3 met a refusal each (no "finish called"), and turn 4's
    // finish stands — the whole exchange is visible on screen. Two, not one:
    // the seed's landing arrives between turns 2 and 3 and buys nothing, being
    // the HARNESS's mission. What pays is m1, the one the lead spawned itself,
    // landing between turns 3 and 4 — and the record names it.
    expect(logs.some((l) => l.includes("lead turn 2") && / — spawned 0, refused 0$/.test(l))).toBe(true)
    expect(logs.some((l) => l.includes("lead turn 3") && / — spawned 0, refused 0$/.test(l))).toBe(true)
    expect(logs.some((l) => l.includes("lead turn 4") && / — spawned 0, refused 0 — finish called$/.test(l))).toBe(true)
    expect(run.control.gate).toMatchObject({
      refusals: 2,
      workAnswered: 1,
      stood: "work",
      answeredBy: ["mission:m1(done,+0)"],
    })
    // Every landing narrates the lane freeing: lens, key, status, the
    // mission's OWN node count, dollars. No edge count — edges carry no writer
    // stamp, so no honest per-mission edge number exists (InvestigatorDigest).
    expect(logs.some((l) => /lane frees: rivals \(m1\) — done, \+\d+ nodes, \$[\d.]+/.test(l))).toBe(true)
  })

  it("degrades rather than snapping: an unaffordable dig is skipped with narration and a cheaper peek runs", async () => {
    const logs: string[] = []
    // Ceiling $0.40: reserve $0.12, pool $0.28. The seed dig holds $0.25, so
    // while it flies the pool funds exactly one peek and no dig.
    const peekModel = new MockLanguageModelV4({
      doGenerate: async () => reply(text("peeked."), true),
    })
    const seedModel = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        if (turn === 1)
          return reply(
            call("p1", "propose", {
              missions: [mission("dig-deep", 55, "dig"), mission("peek-cheap", 40, "peek")],
              why: "two finds I cannot chase",
            }),
            false,
          )
        await sleep(100) // stay in flight so the $0.25 reservation pins the pool
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) {
          await sleep(50) // resolve after the proposals are queued
          return reply(call("n1", "next", { after: { landings: 2 }, why: "let the seed work" }), false)
        }
        return reply(
          call("f1", "finish", { reason: "enough", summary: "s", unresolved: [], why: "done" }),
          false,
        )
      },
    })

    const run = await runSwarm(
      mkOpts({ lead, inv: seedModel, tiers: { peek: peekModel }, logs, over: { ceilingUsd: 0.4 } }),
    )

    // The one honest departure, narrated per skip event.
    expect(logs.some((l) => /the pool no longer funds a dig; your p55 dig-deep has been skipped \d+ time/.test(l))).toBe(
      true,
    )
    // The peek really ran while the dig waited.
    expect(peekModel.doGenerateCalls.length).toBeGreaterThan(0)
    // And the lead was told in-band on its next turn.
    const turn2 = JSON.stringify(lead.doGenerateCalls[1]?.prompt ?? "")
    expect(turn2).toContain("dig-deep")
    expect(turn2).toContain("skipped")
    // The dig never ran; it ships as residue with its author's own priority.
    expect(run.ending.residue.map((r) => r.dedupeKey)).toContain("dig-deep")
    expectEndingShape(run.ending, run.ledger)
  })
})

// ── endings ─────────────────────────────────────────────────────────────────

describe("runSwarm: endings", () => {
  it("budget-floor: the pool refuses a metered turn, the lead gets ONE free closing turn, the ending says so", async () => {
    const logs: string[] = []
    // Ceiling $0.30: reserve $0.12, pool $0.18. The seed cannot be a dig
    // ($0.25) and opens as a read; its one search costs $0.16, leaving
    // $0.019 — below a peek, and below the lead's $0.04 turn estimate.
    const seedModel = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const closing = JSON.stringify(prompt).includes("free closing turn")
        if (closing)
          return reply(
            call("f1", "finish", {
              reason: "out of money",
              summary: "the map holds what the pool bought",
              unresolved: ["the registry sweep"],
              why: "closing",
            }),
            false,
          )
        return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({
        lead,
        inv: seedModel,
        logs,
        over: {
          ceilingUsd: 0.3,
          search: fakeSearch({ usd: 0.16 }),
          pricing: { lead: { inUsdPerM: 0, outUsdPerM: 50 }, peek: zero, read: zero, dig: zero },
        },
      }),
    )

    expect(logs.some((l) => l.includes("the seed opens as a read"))).toBe(true)
    expect(logs.some((l) => l.includes("budget floor"))).toBe(true)
    expect(run.ending.reason).toBe("budget-floor")
    expect(run.ending.humanReason).toMatch(/Out of budget/)
    // The closing turn was real: free tools only, said in-band, finish landed.
    const closingCall = lead.doGenerateCalls.find((c) => JSON.stringify(c.prompt).includes("free closing turn"))
    expect(closingCall).toBeDefined()
    const toolNames = ((closingCall as unknown as { tools?: Array<{ name: string }> })?.tools ?? [])
      .map((t) => t.name)
      .sort()
    expect(toolNames).toEqual(["finish", "read", "recall", "remember"].sort())
    expect(run.finish?.reason).toBe("out of money")
    expectEndingShape(run.ending, run.ledger)
  })

  it("wall-clock: popping halts at the wall, in-flight drains with grace, then hard-cancel — partial writes stand", async () => {
    const logs: string[] = []
    const inv = new MockLanguageModelV4({
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
              why: "record before the clock",
            }),
            false,
          )
        return new Promise(() => {}) // hangs; the hard cancel must win
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", { missions: [mission("m1", 90, "read"), mission("m2", 80, "read")], why: "fill" }),
              ...call("2", "next", { after: { seconds: 600 }, why: "the wall will end this first" }),
            ],
            false,
          )
        return reply(text("waiting."), true)
      },
    })

    const run = await runSwarm(
      mkOpts({ lead, inv, logs, over: { wallClockMs: 150, graceMs: 120, lanes: 2 } }),
    )

    expect(run.ending.reason).toBe("wall-clock")
    expect(run.ending.humanReason).toMatch(/cut off/)
    // The writes that landed before the cancel stand on the map.
    expect(run.map.nodes.get("rival.com")).toBeDefined()
    // The cut-off missions report themselves as timeouts, with their writes counted.
    expect(run.landings.some((l) => l.digest.status === "timeout")).toBe(true)
    // m2 never ran: it is residue, and its spawn-time claim settled at $0 —
    // the ledger balances exactly, per the shape helper.
    expect(run.ending.residue.map((r) => r.dedupeKey)).toContain("m2")
    expectEndingShape(run.ending, run.ledger)
  })

  it("stillborn: no readable seed-host page and an empty identification SERP end the run inside the window", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async () => reply(call("n1", "next", { after: { seconds: 600 }, why: "quiet" }), false),
    })
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0)
          return reply(call("f1", "fetch", { urls: ["https://anchor.com"], mode: "direct", why: "read the seed" }), false)
        if (turn === 1) return reply(call("s1", "search", { queries: ["anchor identification"], why: "who is this" }), false)
        return reply(text("nothing to read."), true)
      },
    })

    const run = await runSwarm(
      mkOpts({
        lead,
        inv,
        over: {
          stillbornWindowMs: 80,
          search: fakeSearch({ hits: [] }),
          fetch: fakeFetch({ "https://anchor.com": { httpStatus: 200, body: "" } }),
        },
      }),
    )

    expect(run.ending.reason).toBe("stillborn")
    expect(run.ending.humanReason).toBe("Nothing at this domain could be read; there is no map to build from here.")
    expect(run.ending.nodes).toBe(0)
    expect(run.ending.spentUsd).toBeLessThan(0.03)
    expectEndingShape(run.ending, run.ledger)
  })

  it("lead-fault: two consecutive model failures end the run; the landed mission's writes stand", async () => {
    const inv = new MockLanguageModelV4({
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
                  why: "same capability, same buyer, per the engine's own snippet",
                  evidence: [{ url: "https://rival.com", quote: "Rival sells fraud scoring" }],
                },
              ],
              why: "the snippet proves it",
            }),
            false,
          )
        return reply(text("done."), true)
      },
    })
    let leadCalls = 0
    const lead = new MockLanguageModelV4({
      doGenerate: async () => {
        leadCalls += 1
        if (leadCalls === 1) return reply(call("1", "spawn", { missions: [mission("m1", 90, "read")], why: "one lane" }), false)
        throw new Error("the model API failed")
      },
    })

    const run = await runSwarm(mkOpts({ lead, inv }))

    expect(run.ending.reason).toBe("lead-fault")
    expect(run.ending.humanReason).toMatch(/twice in a row/)
    // Blast radius one turn: everything that landed stands.
    expect(run.map.nodes.get("rival.com")).toBeDefined()
    expect(run.ending.nodes).toBeGreaterThan(0)
    expect(leadCalls).toBe(3) // one good turn, two faults, no third retry
    expectEndingShape(run.ending, run.ledger)
  })

  it("turn-cap: a lead that never finishes trips the loop detector, loudly", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async () => reply(call("1", "recall", { op: "stats", why: "looping" }), false),
    })

    const run = await runSwarm(mkOpts({ lead, over: { ceilingUsd: 5 } }))

    expect(run.ending.reason).toBe("turn-cap")
    expect(run.ending.humanReason).toMatch(/loop detector/)
    expect(run.tally.leadTurns).toBe(24)
    expectEndingShape(run.ending, run.ledger)
  })

  it("aborted: the caller's signal rejects the run like the sweep does, terminal frame attached", async () => {
    const controller = new AbortController()
    const lead = new MockLanguageModelV4({
      doGenerate: async () => reply(call("n1", "next", { after: { seconds: 600 }, why: "quiet" }), false),
    })
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        await sleep(300)
        return reply(text("done."), true)
      },
    })
    setTimeout(() => controller.abort(), 30)

    let thrown: unknown
    try {
      await runSwarm(mkOpts({ lead, inv, over: { signal: controller.signal } }))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("aborted")
    const ending = (thrown as { ending?: SwarmEnding }).ending
    expect(ending?.reason).toBe("aborted")
    if (ending) expectEndingShape(ending)
  })
})

// ── the family ledger ───────────────────────────────────────────────────────

describe("runSwarm: the family ledger", () => {
  it("a seed-only run holds exactly one family row — the run-1 shape", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.families).toEqual([
      {
        lens: "orientation",
        dedupeKey: "orient:anchor.com",
        priority: 100,
        status: "landed",
        nodesAdded: 0,
        pageTierNodes: 0,
      },
    ])
  })

  it("spawning three missions opens three families beside the seed — four rows", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", {
                missions: [mission("m1", 90, "read"), mission("m2", 85, "read"), mission("m3", 80, "read")],
                why: "three angles",
              }),
              ...call("2", "next", { after: { landings: 4 }, why: "let everything land" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead }))

    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com", "m1", "m2", "m3"])
    expect(run.families.every((f) => f.status === "landed")).toBe(true)
  })

  it("a killed family survives in the rows with the lead's because", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", { missions: [mission("m1", 90, "read"), mission("m2", 80, "read")], why: "two angles" }),
              ...call("2", "next", { after: { landings: 1 }, why: "come back on the first landing" }),
            ],
            false,
          )
        return reply(
          [
            ...call("k1", "review", {
              kill: [{ dedupeKey: "m2", because: "the rivals lens already asks this" }],
              why: "duplicate angle",
            }),
            ...call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }),
          ],
          false,
        )
      },
    })

    const run = await runSwarm(mkOpts({ lead, over: { lanes: 1 } }))

    const m2 = run.families.find((f) => f.dedupeKey === "m2")
    expect(m2).toMatchObject({ status: "killed", because: "the rivals lens already asks this" })
    expect(run.families).toHaveLength(3) // the killed row stays in the denominator
  })

  it("promotion creates the family; an unpromoted proposal never opens one", async () => {
    const seedModel = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        if (turn === 1)
          return reply(
            call("p1", "propose", {
              missions: [
                { ...mission("p-promoted", 50, "peek"), lens: "vendors" },
                mission("p-ignored", 40, "peek"),
              ],
              why: "two finds I cannot chase",
            }),
            false,
          )
        await sleep(400) // stay in flight: the single lane is busy, so fill cannot pop the proposals before the review
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { seconds: 0.05 }, why: "review the board soon" }), false)
        if (turn === 2)
          return reply(
            [
              ...call("r1", "review", { promote: [{ dedupeKey: "p-promoted", priority: 70 }], why: "the map says so" }),
              ...call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }),
            ],
            false,
          )
        // The gate refused turn 2's finish (fat pool, empty families); restate.
        return reply(call("f2", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, inv: seedModel, over: { lanes: 1 } }))

    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com", "p-promoted"])
    expect(run.families[1]).toMatchObject({ lens: "vendors", priority: 70, status: "queued" })
  })

  it("pageTierNodes flows from the writer stamps: the family that read a page carries the count", async () => {
    const pageWriter = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0)
          return reply(call("f1", "fetch", { urls: ["https://rival.com"], mode: "direct", why: "the rival's own words" }), false)
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
                  why: "same capability sold to the same buyer, per its own page",
                  evidence: [{ url: "https://rival.com", quote: "flags stolen cards before authorization" }],
                },
              ],
              why: "record as I go",
            }),
            false,
          )
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", { missions: [mission("m1", 90, "read")], why: "one page mission" }),
              ...call("2", "next", { after: { landings: 2 }, why: "let both land" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, tiers: { read: pageWriter } }))

    const m1 = run.families.find((f) => f.dedupeKey === "m1")
    expect(m1).toMatchObject({ status: "landed", nodesAdded: 1, pageTierNodes: 1 })
    // The seed only searched: zero page-tier answers, and the row says so.
    expect(run.families.find((f) => f.dedupeKey === "orient:anchor.com")!.pageTierNodes).toBe(0)
  })
})

// ── the in-band scorecard ───────────────────────────────────────────────────

describe("runSwarm: the scorecard rides every think turn", () => {
  /** One page-tier mission beside the searching seed, every lead prompt
   *  captured — the deterministic fixture the three scorecard tests share. */
  async function scorecardScenario(over: Partial<SwarmOptions> = {}): Promise<{ run: SwarmRun; turns: string[] }> {
    const turns: string[] = []
    const pageWriter = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0)
          return reply(
            call("f1", "fetch", {
              urls: ["https://rival.com", "https://roundup.com/best-fraud-tools"],
              mode: "direct",
              why: "the rival's own words, and the roundup that may grade the map",
            }),
            false,
          )
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
                  why: "same capability sold to the same buyer, per its own page",
                  evidence: [{ url: "https://rival.com", quote: "flags stolen cards before authorization" }],
                },
              ],
              why: "record as I go",
            }),
            false,
          )
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        turns[turn] = JSON.stringify(prompt.filter((m) => m.role === "user").at(-1)?.content ?? "")
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", { missions: [mission("m1", 90, "read")], why: "one page mission" }),
              ...call("2", "next", { after: { landings: 2 }, why: "let both land" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })
    const run = await runSwarm(mkOpts({ lead, tiers: { read: pageWriter }, over }))
    expect(run.ending.reason).toBe("lead-finished")
    return { run, turns }
  }

  it("a think turn's notes carry the block, numbers matching an independently computed scorecard", async () => {
    const { run, turns } = await scorecardScenario()
    const notes = turns[2]!

    // The same input the orchestrator folds, rebuilt from the run's own record
    // — nothing changed between the captured turn and the ending, so the end
    // state IS the compose-time state (zero model pricing, no later spends).
    const live = [...run.map.nodes.values()].filter((n) => !n.retracted)
    const expected = scorecardSentences(
      computeScorecard({
        families: run.families,
        entities: live.map((n) => ({ tier: n.tier, sources: new Set(n.evidence.map((e) => e.url)).size })),
        spendableUsd: run.ledger.spendable(),
        ceilingUsd: 1.5,
        spentUsd: run.ledger.spentUsd(),
        elapsedMs: 0, // time moves between compose and ending; asserted by shape below
        wallMs: 300_000,
        yieldHistory: run.landings.map((l) => l.digest.added.nodes),
        recall: { pooled: null, probes: [] }, // rivalHtml never names the anchor: no probe qualifies
      }),
    )
    expect(expected.length).toBeGreaterThanOrEqual(6)
    for (const line of expected) {
      if (/wall elapsed$/.test(line)) continue
      expect(notes).toContain(line)
    }
    expect(notes).toMatch(/\ds of the 300s wall elapsed/)
    // And EVERY think turn carries it, the first included.
    expect(turns[1]!).toMatch(/the pool holds \$\d+\.\d{2} of \$\d+\.\d{2}/)
  })

  it("the old inline yield narration is gone — exactly one yield sentence, the scorecard's", async () => {
    const { turns } = await scorecardScenario()
    const notes = turns[2]!
    expect(notes).not.toMatch(/produced \d+ new compan/)
    const yieldLines = notes.match(/the last (\d+ landings?|landing) added|no missions have landed/g) ?? []
    expect(yieldLines).toHaveLength(1)
  })

  it("recall in the notes matches serialize-time recall on the same fixture", async () => {
    // The roundup page names the anchor as a word of its own and links five
    // vendors — an answer key. The map holds one of the five.
    const probeHtml =
      `<html><body><h1>Five fraud scoring vendors compared</h1>` +
      `<p>Shortlisting alternatives to anchor.com for merchants: we scored each vendor on latency, ` +
      `pricing and review tooling, then ran the same hundred stolen-card checkouts through every ` +
      `platform to see what got flagged before authorization and what sailed straight through.</p>` +
      `<a href="https://rival.com">Rival</a> <a href="https://second.com">Second</a> ` +
      `<a href="https://third.com">Third</a> <a href="https://fourth.com">Fourth</a> ` +
      `<a href="https://fifth.com">Fifth</a></body></html>`
    const { run, turns } = await scorecardScenario({
      fetch: fakeFetch({ "https://roundup.com/best-fraud-tools": { httpStatus: 200, body: probeHtml } }),
    })

    const out = serializeSwarmRun(run)
    const recall = (out.report as { recall: RecallReport }).recall
    expect(recall.pooled).toBeCloseTo(1 / 5, 6)
    expect(recall.probes).toHaveLength(1)
    expect(turns[2]!).toContain(`recall across 1 answer-key probe: ${recall.pooled!.toFixed(2)}`)
  })
})

// ── the finish gate ─────────────────────────────────────────────────────────

describe("runSwarm: the finish gate", () => {
  /** A lead that finishes early over a fat pool with the seed's family at zero
   *  page-tier nodes (the searching seed never fetches a page) — run 2's exact
   *  shape — then answers the refusal by restating finish in its own words. */
  const earlyFinisher = (unresolved: string[]) =>
    new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(
          call("f1", "finish", { reason: "mapped", summary: "the map holds it", unresolved, why: "done" }),
          false,
        )
      },
    })

  it("a restated finish does not clear the gate: refused twice, then the run ends anyway", async () => {
    // Run 2's shape end to end. The lead restates instead of working, exactly
    // as runs/swarm-brightdata-com-202608060833 did at seq 371→374, and the
    // loop now charges it a second refusal — and then ends the run, because a
    // gate that cannot be satisfied is worse than the bug it was written for.
    const lead = earlyFinisher(["what the seed never opened"])
    const run = await runSwarm(mkOpts({ lead }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.tally.leadTurns).toBe(4) // next, refused, refused again, accepted
    const gate = run.control.gate!
    expect(gate.refusals).toBe(2)
    expect(gate.workAnswered).toBe(0) // asked twice for a page or a landing, paid neither
    expect(gate.objections.length).toBeGreaterThan(0)
    expect(gate.objections.some((o) => /planned famil/.test(o))).toBe(true)
    expect(gate.objections.some((o) => /^the pool holds \$/.test(o))).toBe(true)
    // Both refusals reached the model in the SAME conversation, and the second
    // carried the one new fact — the turn the first bought produced nothing.
    const turn3 = JSON.stringify(lead.doGenerateCalls[2]?.prompt ?? "")
    expect(turn3).toContain("words do not clear these — fetch a page")
    const turn4 = JSON.stringify(lead.doGenerateCalls[3]?.prompt ?? "")
    expect(turn4).toContain("no page was fetched and no mission landed in the turn the last refusal bought")
    // The latest refused conclusion is stashed whole; the accepted one is the run's.
    expect(gate.refusedFinish).toMatchObject({ reason: "mapped", summary: "the map holds it" })
    expect(run.finish!.unresolved).toEqual(["what the seed never opened"]) // byte-identical, no merge
    // Every still-standing objection the lead omitted is carried separately.
    expect(gate.carried).toEqual(gate.objections)
    expectEndingShape(run.ending, run.ledger)
  })

  it("one page bought clears it: the finish after real work stands, objections and all", async () => {
    // The exchange the gate is for. The lead answers the refusal with a fetch —
    // counted by the loop's own fetch port, not claimed by the lead — and the
    // next finish stands even though both readings still object.
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 3)
          return reply(
            call("g1", "fetch", { urls: ["https://rival.com"], mode: "direct", why: "open the host the seed only saw" }),
            false,
          )
        return reply(
          call("f1", "finish", { reason: "mapped", summary: "the map holds it", unresolved: [], why: "d" }),
          false,
        )
      },
    })
    const run = await runSwarm(mkOpts({ lead }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.tally.leadTurns).toBe(4) // next, refused, the page, accepted
    expect(run.tally.fetchCalls).toBe(1)
    const gate = run.control.gate!
    expect(gate.refusals).toBe(1) // one refusal, answered
    expect(gate.workAnswered).toBe(1) // and this is the fact that answered it
    expect(gate.stood).toBe("work") // and the record names the rule that let it through
    expect(gate.carried.length).toBeGreaterThan(0) // the readings still object; the finish stands anyway
    expectEndingShape(run.ending, run.ledger)
  })

  it("a fetch of a host that never answers buys nothing: the port resolved, the run gained no page", async () => {
    // The cheapest way to clear a per-CALL price. providers/src/brightdata.ts
    // catches a direct-mode network failure and resolves `{httpStatus: 0,
    // body: "", usd: 0}`, so this loop completes a fetch call for $0.00 —
    // and, because settle() answers before the breaker's STRIKES check, it can
    // do it with the same dead url every turn, forever.
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 3 || turn === 5)
          return reply(
            call("g1", "fetch", { urls: ["https://nowhere.invalid/x"], mode: "direct", why: "pay the gate" }),
            false,
          )
        return reply(
          call("f1", "finish", { reason: "mapped", summary: "the map holds it", unresolved: [], why: "d" }),
          false,
        )
      },
    })
    const run = await runSwarm(
      mkOpts({ lead, over: { fetch: fakeFetch({ "https://nowhere.invalid/x": { httpStatus: 0, body: "" } }) } }),
    )

    // next, refused, dead fetch, refused again, dead fetch, accepted.
    expect(run.ending.reason).toBe("lead-finished")
    expect(run.tally.leadTurns).toBe(6)
    expect(run.tally.fetchCalls).toBe(2) // two completed calls...
    const gate = run.control.gate!
    expect(gate.workAnswered).toBe(0) // ...and nothing gained by either
    expect(gate.refusals).toBe(2)
    expect(gate.stood).toBe("refusals-spent") // the ceiling ended it, not the work
    expect(run.ending.spentUsd).toBeLessThan(0.01)
    expectEndingShape(run.ending, run.ledger)
  })

  it("an investigator's page does not pay the lead's debt: the fetch tally moves and the gate does not", async () => {
    // `tally.fetchCalls` is the SHARED port counter — every lane moves it. The
    // gate charges the LEAD, so the lead's own paid toolset carries the
    // counter and a lane's page rides in on its mission's LANDING instead.
    // Here the landing never arrives inside the exchange, so nothing pays.
    let refusedOnce = false
    const heldPage = new Promise<void>((resolve) => {
      const tick = () => (refusedOnce ? resolve() : setTimeout(tick, 2))
      tick()
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("s1", "spawn", { missions: [mission("m1", 90, "read")], why: "one lane of real work" }),
              ...call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }),
            ],
            false,
          )
        // The turn the first refusal bought, spent waiting — long enough for
        // the lane's page to land, which under the old counter was the lead's.
        if (turn === 3) {
          refusedOnce = true
          return reply(call("n2", "next", { after: { seconds: 0.05 }, why: "let the lane read" }), false)
        }
        return reply(call("f1", "finish", { reason: "mapped", summary: "the map holds it", unresolved: [], why: "d" }), false)
      },
    })
    const laneInv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0)
          return reply(call("g1", "fetch", { urls: ["https://rival.com"], mode: "direct", why: "read the rival" }), false)
        await sleep(400) // the mission stays in flight past the whole exchange
        return reply(text("done."), true)
      },
    })
    const run = await runSwarm(
      mkOpts({
        lead,
        tiers: { read: laneInv },
        over: { fetch: fakeFetch({ "https://rival.com": { httpStatus: 200, body: rivalHtml, delayMs: 0 } }) },
      }),
    )
    await heldPage

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.tally.fetchCalls).toBeGreaterThanOrEqual(1) // the lane bought a page
    const gate = run.control.gate!
    expect(gate.refusals).toBe(2) // and the lead was refused twice anyway
    expect(gate.workAnswered).toBe(0) // it did nothing itself
    expect(gate.stood).toBe("refusals-spent")
    expectEndingShape(run.ending, run.ledger)
  })

  it("a wall too short for its own warning still ends on the lead's finish, not on the clock", async () => {
    // The regression a wait-for-the-landing refusal created. Below
    // WALL_WARN_BEFORE_MS there is no warning band to disarm the gate, and a
    // `{landings: 1}` condition arms no timer — so a parked lead never came
    // back and the run ended `wall-clock` with `report.finish: null`, the
    // harness writing the ending. Every refusal grants its answering turn
    // immediately, so the exchange fits inside any wall the lead can think in.
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("s1", "spawn", { missions: [mission("m1", 90, "read")], why: "a lane is live" }),
              ...call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "the map holds it", unresolved: [], why: "d" }), false)
      },
    })
    const slowLane = new MockLanguageModelV4({
      doGenerate: async () => {
        await sleep(30_000) // never lands inside the wall
        return reply(text("done."), true)
      },
    })
    // 800ms is far under WALL_WARN_BEFORE_MS (45s), so no warning ever fires.
    const run = await runSwarm(mkOpts({ lead, tiers: { read: slowLane }, over: { wallClockMs: 800, graceMs: 100 } }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.finish).not.toBeNull()
    expect(run.finish!.summary).toBe("the map holds it")
    expect(run.control.gate!.refusals).toBe(2)
    expectEndingShape(run.ending, run.ledger)
  })

  it("an all-null config never refuses: the same early finish stands first time", async () => {
    const run = await runSwarm(
      mkOpts({
        lead: earlyFinisher([]),
        over: {
          scorecardConfig: {
            maxPoolUnspentFraction: null,
            maxSingleSourcedFraction: null,
            requirePageTierPerFamily: null,
          },
        },
      }),
    )

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.tally.leadTurns).toBe(2)
    expect(run.control.gate).toEqual({
      refusals: 0,
      objections: [],
      carried: [],
      refusedFinish: null,
      workAtRefusal: null,
      workAnswered: 0,
      answeredBy: [],
      refusedAtTurn: null,
      stood: "clean",
    })
  })

  it("the free closing turn is never refused; objections still land on the record at acceptance", async () => {
    // The budget-floor fixture: the seed's $0.16 search empties a $0.30 pool,
    // so the lead's one closing turn carries a finish the gate must not touch.
    const seedModel = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const closing = JSON.stringify(prompt).includes("free closing turn")
        if (closing)
          return reply(
            call("f1", "finish", { reason: "out of money", summary: "what the pool bought", unresolved: [], why: "c" }),
            false,
          )
        return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({
        lead,
        inv: seedModel,
        over: {
          ceilingUsd: 0.3,
          search: fakeSearch({ usd: 0.16 }),
          pricing: { lead: { inUsdPerM: 0, outUsdPerM: 50 }, peek: zero, read: zero, dig: zero },
        },
      }),
    )

    expect(run.ending.reason).toBe("budget-floor")
    expect(run.finish?.reason).toBe("out of money") // the closing finish stood first time
    const gate = run.control.gate!
    expect(gate.refusals).toBe(0)
    expect(gate.objections.some((o) => /planned famil/.test(o))).toBe(true) // the record kept them anyway
    expect(gate.carried).toEqual(gate.objections)
    expectEndingShape(run.ending, run.ledger)
  })

  // ── whose landing is it ────────────────────────────────────────────────
  //
  // The landing half of the price used to be run-wide, on a premise
  // tools-control.ts stated as fact: "there is no second commissioner". There
  // are four, and the loudest of them is ON BY DEFAULT — `familyFloor`
  // unset and no `fromSweep` means `DEFAULT_FAMILY_FLOOR = 4` templated read
  // missions the moment the seed lands. So these run at the DEFAULT, because
  // the default is the broken path: every other gate test in this file happens
  // to escape it only because its seed investigator never remembers anything,
  // which leaves the floor with no category to template from.

  /** A seed dig that ORIENTS: opens the anchor and records the de-branded
   *  capability. That one node is what `familyProfileFrom` reads, and without
   *  it the floor narrates an empty profile and opens nothing. */
  const orientingSeed = () =>
    new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0)
          return reply(call("f1", "fetch", { urls: ["https://anchor.com"], mode: "direct", why: "the anchor's own words" }), false)
        if (turn === 1)
          return reply(
            call("r1", "remember", {
              nodes: [
                {
                  name: "Fraud scoring",
                  domain: "",
                  kind: "capability",
                  what: "scoring checkout fraud before authorization",
                  relation: "covers",
                  why: "the job this market is organised around, in brand-free words",
                  evidence: [{ url: "https://anchor.com", quote: "fraud scoring API to online merchants" }],
                },
              ],
              why: "orientation, recorded as it is read",
            }),
            false,
          )
        return reply(text("oriented."), true)
      },
    })

  /** The lead that does nothing at all: wake on the seed, finish, sleep
   *  through the turn the refusal buys, finish again. It never spawns, never
   *  fetches, never searches — every landing in the run belongs to the
   *  harness. */
  const sleepingLead = () =>
    new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        // The turn the first refusal bought, spent asleep — waiting on work
        // the harness commissioned, which is the whole bypass.
        if (turn === 3) return reply(call("n2", "next", { after: { landings: 3 }, why: "let the floor come home" }), false)
        return reply(call("f1", "finish", { reason: "mapped", summary: "the floor did it", unresolved: [], why: "d" }), false)
      },
    })

  it("the family floor's landings are not the lead's: a lead that only sleeps pays nothing, at the DEFAULT floor", async () => {
    const logs: string[] = []
    const run = await runSwarm(mkOpts({ lead: sleepingLead(), tiers: { dig: orientingSeed() }, logs }))

    // The premise, asserted rather than hoped for: the floor is on, it is the
    // code default, and its missions really did come home. Without this the
    // gate assertions below could pass because nothing landed at all.
    expect(DEFAULT_FAMILY_FLOOR).toBe(4)
    expect(logs.some((l) => /family floor: p\d+ family:market funded/.test(l))).toBe(true)
    const landed = run.landings.map((l) => l.mission.dedupeKey)
    expect(landed).toContain("orient:anchor.com")
    expect(landed.filter((k) => k.startsWith("family:")).length).toBeGreaterThanOrEqual(3)
    // And the lead itself bought nothing: no fetch of its own, no spawn.
    expect(run.control.commissionedBy.get("orient:anchor.com")).toBe("seed")
    expect(run.control.commissionedBy.get("family:market")).toBe("family-floor")
    expect([...run.control.commissionedBy.values()]).not.toContain("lead")

    // So the debt is unpaid, whatever the harness's own lanes were doing.
    const gate = run.control.gate!
    expect(gate.workAnswered).toBe(0)
    expect(gate.answeredBy).toEqual([])
    expect(gate.refusals).toBe(2)
    expect(gate.stood).toBe("refusals-spent")
    expectEndingShape(run.ending, run.ledger)
  }, 20_000)

  it("the SAME sleeping lead reads the same with the floor off — the floor was never the difference", async () => {
    // The control. Before the fix these two runs disagreed
    // (`workAnswered: 4, stood: "work"` against `0, "refusals-spent"`) and the
    // whole difference was missions the harness wrote. They agree now.
    const run = await runSwarm(
      mkOpts({ lead: sleepingLead(), tiers: { dig: orientingSeed() }, over: { familyFloor: false } }),
    )
    const gate = run.control.gate!
    expect(gate.workAnswered).toBe(0)
    expect(gate.stood).toBe("refusals-spent")
    expect(run.landings.length).toBeGreaterThan(0)
    expect(run.landings.every((l) => !l.mission.dedupeKey.startsWith("family:"))).toBe(true)
    expectEndingShape(run.ending, run.ledger)
  }, 20_000)

  it("a mission the LEAD spawned still pays, and the record names it", async () => {
    // The other half: the fix must narrow the price, not delete it. Same
    // default floor, same orienting seed — the only change is that the lead
    // commissions one lane of its own and waits for THAT.
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 3)
          return reply(
            [
              ...call("s1", "spawn", { missions: [mission("mine", 95, "read")], why: "my own question" }),
              ...call("n2", "next", { after: { landings: 8 }, why: "wait for it" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "I asked one", unresolved: [], why: "d" }), false)
      },
    })
    const run = await runSwarm(mkOpts({ lead, tiers: { dig: orientingSeed() } }))

    expect(run.control.commissionedBy.get("mine")).toBe("lead")
    const gate = run.control.gate!
    expect(gate.refusals).toBe(1)
    expect(gate.stood).toBe("work")
    expect(gate.workAnswered).toBe(1) // exactly one: the floor's landings are not counted beside it
    expect(gate.answeredBy).toEqual(["mission:mine(done,+0)"]) // and the record says which, and how it went
    expectEndingShape(run.ending, run.ledger)
  }, 20_000)

  // ── whose PAGE is it ───────────────────────────────────────────────────
  //
  // The other half of the same family: the run's own store was closed off as
  // a source of the lead's payment (an alias and a redirect fold), but the
  // HOST was not. A soft 404, a site-search page or any error template that
  // prints the address it was handed turns `https://anchor.com/<anything>`
  // into a fresh reading, `sniff` calls it `found` at page tier because it is
  // over 200 extracted characters, and a direct fetch costs $0.00.

  /** A host that answers EVERY path 200 with one template, printing the path
   *  it was handed — the default behaviour of most 404 pages, no hostility
   *  required. */
  const echoingHost = (): FetchPort => ({
    async get(url) {
      const u = new URL(url)
      return {
        url,
        httpStatus: 200,
        contentType: "text/html",
        body:
          `<html><body><h1>Page not found</h1><p>We could not find <code>${u.pathname}${u.search}</code> ` +
          `on this server. Check the spelling, or start again from the home page. Our documentation, ` +
          `pricing and contact pages are all reachable from the navigation above, and the search box ` +
          `will find most things faster than guessing at a url.</p></body></html>`,
        ms: 1,
        usd: 0,
      }
    },
  })

  /** A seed that reads one page of the echoing host, so the run holds the
   *  template before the lead ever calls finish. */
  const seedReadingTheTemplate = () =>
    new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0)
          return reply(call("f1", "fetch", { urls: ["https://anchor.com/about"], mode: "direct", why: "the anchor's own words" }), false)
        if (turn === 1)
          return reply(
            call("r1", "remember", {
              nodes: [
                {
                  name: "Anchor",
                  domain: "anchor.com",
                  kind: "company",
                  what: "whatever this host actually sells",
                  relation: "covers",
                  why: "the only page the run could open",
                  evidence: [{ url: "https://anchor.com/about", quote: "Check the spelling" }],
                },
              ],
              why: "recorded as it is read",
            }),
            false,
          )
        return reply(text("read."), true)
      },
    })

  it("the host cannot supply the bytes: two guesses at an echoing 404 buy nothing, at $0.0000", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 3)
          return reply(
            call("g1", "fetch", { urls: ["https://anchor.com/this-page-does-not-exist-7f3a"], mode: "direct", why: "pay the gate" }),
            false,
          )
        if (turn === 5)
          return reply(
            call("g2", "fetch", { urls: ["https://anchor.com/nor-does-this-one"], mode: "direct", why: "pay it again" }),
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "the map holds it", unresolved: [], why: "d" }), false)
      },
    })
    const run = await runSwarm(
      mkOpts({ lead, tiers: { dig: seedReadingTheTemplate() }, over: { fetch: echoingHost(), familyFloor: false } }),
    )

    // The premise: both guesses really were readable page-tier answers — the
    // probe pool holds every page the run bought, and both are in it.
    const bought = run.evidence.pages().map((p) => p.url)
    expect(bought).toContain("https://anchor.com/this-page-does-not-exist-7f3a")
    expect(bought).toContain("https://anchor.com/nor-does-this-one")
    // next, refused, guess, refused again, guess again, accepted.
    expect(run.ending.reason).toBe("lead-finished")
    expect(run.tally.leadTurns).toBe(6)
    const gate = run.control.gate!
    expect(gate.refusals).toBe(2)
    expect(gate.workAnswered).toBe(0) // the host wrote both pages; the run gained neither
    expect(gate.answeredBy).toEqual([])
    expect(gate.stood).toBe("refusals-spent")
    expect(run.ending.spentUsd).toBeLessThan(0.01)
    expectEndingShape(run.ending, run.ledger)
  }, 20_000)

  // ── whose COMMISSION is it ─────────────────────────────────────────────
  //
  // `commissionedBy` kept the harness's landings off the lead's tab. The free
  // re-rank put them back: reviewTool re-stamped on `out.ok`, and every
  // harness row is pushed `board.push(m, "lead")` — already funded, already in
  // the 61-100 band, and certain to be popped whatever the lead does. So a
  // promote changed nothing about whether the work happened, only whose name
  // was on it, and `stood: "work"` then named the harness's own mission.

  /** A handoff of exactly ten missions: eight verify peeks off the head, two
   *  unknown-cluster reads. No recall gap — `report` is omitted, so the
   *  eleventh mission is never minted and the count is exactly ten. */
  const tenMissionSweep = (): SweepRunLike => ({
    anchor: "anchor.com",
    entities: [
      ...Array.from({ length: 8 }, (_, i) => ({
        name: `Rival ${i}`,
        domain: `rival${i}.com`,
        kind: "company",
        relation: "competitor",
        why: "same fraud scoring sold to the same merchants",
        foundBy: ["Scoring", "Checkout", "Risk"].slice(0, 3 - (i % 2)),
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `maybe${i}.com`,
        domain: `maybe${i}.com`,
        kind: "unknown",
        relation: "unknown",
        why: "",
        foundBy: ["Scoring", "Checkout"],
      })),
    ],
    searched: [{ hits: [{ url: "https://rival0.com/pricing" }] }],
  })

  /** A handoff lane slow enough that the lead's turns land while the board
   *  still holds unclaimed rows — otherwise there is nothing to promote. */
  const slowLane = () =>
    new MockLanguageModelV4({
      doGenerate: async () => {
        await sleep(400)
        return reply(text("the handoff's question noted."), true)
      },
    })

  it("a free re-rank of a harness row is not a commission: the promote laundry, at DEFAULT lanes", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        // The turn the first refusal bought, spent re-ranking a question the
        // HARNESS wrote and the pool had already committed to. No fetch, no
        // search, no spawn — the whole bypass is this one free tool call.
        if (turn === 3)
          return reply(
            [
              ...call("r1", "review", { promote: [{ dedupeKey: "gap:unknowns-2", priority: 95 }], why: "mine now" }),
              ...call("n2", "next", { after: { landings: 20 }, why: "let my question come home" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "the handoff did it", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({ lead, tiers: { peek: slowLane(), read: slowLane() }, logs, over: { fromSweep: tenMissionSweep() } }),
    )

    // The premises, asserted rather than hoped for. DEFAULT lanes, a handoff
    // of ten, and the promote really did take: the row was popped wearing p95.
    expect(DEFAULT_LANES).toBe(6)
    const handoff = logs
      .map((l) => /sweep handoff: p\d+ ((?:verify|gap):\S+) funded/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined)
    expect(handoff).toHaveLength(10)
    expect(handoff).toContain("gap:unknowns-2")
    expect(logs.some((l) => /lane takes p95 gap:unknowns-2 \(read\)$/.test(l))).toBe(true)
    expect(run.landings.map((l) => l.mission.dedupeKey)).toContain("gap:unknowns-2")
    // And the lead itself bought nothing at all.
    expect(run.tally.fetchCalls).toBe(0)
    expect([...run.control.commissionedBy.values()]).not.toContain("lead")

    // So the re-rank moved a number and nothing else: the name stayed the
    // handoff's, and the debt is unpaid.
    expect(run.control.commissionedBy.get("gap:unknowns-2")).toBe("sweep")
    const gate = run.control.gate!
    expect(gate.refusals).toBe(2)
    expect(gate.workAnswered).toBe(0)
    expect(gate.answeredBy).toEqual([])
    expect(gate.stood).toBe("refusals-spent")
    expectEndingShape(run.ending, run.ledger)
  }, 30_000)

  // ── and the same laundry through the other free verb ───────────────────
  //
  // A kill releases the harness's reservation, drops the row's commissioner
  // and returns the key to the dedupe universe; a spawn of the SAME key then
  // re-reserves the same allowance for the same question and used to stamp it
  // `lead`. Nothing about the run changed but the name on the landing — same
  // money to four decimals, same landings, same map — and the gate read
  // `stood: "work"`. The exact-key case is the one that is closed; the memory
  // that closes it is `RunControl.commissionerBeforeKill`.

  /** The handoff's own `gap:unknowns-2`, minted from the same fixture by the
   *  same function the orchestrator calls, with the coinages the orchestrator
   *  derives for `anchor.com`. This IS the harness's mission, not a copy of
   *  it — so a lead that spawns this object is re-asking, byte for byte, a
   *  question the pool had already committed to. */
  const handoffMission = (dedupeKey: string) => {
    const minted = sweepSeedMissions(tenMissionSweep(), { anchor: "anchor.com", coinages: ["anchor.com", "anchor"] })
    const m = minted.find((x) => x.dedupeKey === dedupeKey)
    if (!m) throw new Error(`the fixture no longer mints ${dedupeKey}: ${minted.map((x) => x.dedupeKey).join(", ")}`)
    return m
  }

  it("a kill and a byte-identical re-spawn is not a commission either: the kill laundry, at DEFAULT lanes", async () => {
    const logs: string[] = []
    const respawn = handoffMission("gap:unknowns-2")
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        // The turn the first refusal bought, spent taking the harness's own
        // question off the board and putting it straight back under the lead's
        // name. Two free tool calls, one reservation released and one taken,
        // and the same mission runs either way.
        if (turn === 3)
          return reply(
            [
              ...call("k1", "review", {
                kill: [{ dedupeKey: "gap:unknowns-2", because: "I want this one myself" }],
                why: "clearing the board",
              }),
              ...call("s1", "spawn", { missions: [respawn], why: "asking it again, in my own name" }),
              ...call("n2", "next", { after: { landings: 20 }, why: "let my question come home" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "the handoff did it", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({ lead, tiers: { peek: slowLane(), read: slowLane() }, logs, over: { fromSweep: tenMissionSweep() } }),
    )

    // The premises. DEFAULT lanes, a handoff of ten, the kill took, the
    // re-spawn was funded, and what came home is the handoff's mission field
    // for field — not a near-copy that could be argued to be a new question.
    expect(DEFAULT_LANES).toBe(6)
    expect(logs.filter((l) => /sweep handoff: p\d+ (?:verify|gap):\S+ funded/.test(l))).toHaveLength(10)
    expect(logs.some((l) => /lane takes p62 gap:unknowns-2 \(read\)$/.test(l))).toBe(true)
    const landed = run.landings.find((l) => l.mission.dedupeKey === "gap:unknowns-2")
    expect(landed?.mission).toMatchObject(respawn)
    // And the lead bought nothing else at all: no page of its own, and no
    // second question under a name of its own.
    expect(run.tally.fetchCalls).toBe(0)
    expect([...run.control.commissionedBy.values()]).not.toContain("lead")

    // So the kill moved a reservation and nothing else: the name survived it,
    // and the debt is unpaid.
    expect(run.control.commissionerBeforeKill.get("gap:unknowns-2")).toBe("sweep")
    expect(run.control.commissionedBy.get("gap:unknowns-2")).toBe("sweep")
    const gate = run.control.gate!
    expect(gate.refusals).toBe(2)
    expect(gate.workAnswered).toBe(0)
    expect(gate.answeredBy).toEqual([])
    expect(gate.stood).toBe("refusals-spent")
    expectEndingShape(run.ending, run.ledger)
  }, 30_000)

  it("a kill and a DIFFERENT question still pays — the pin is on the key, not on the kill", async () => {
    // The honest case, and the one the fix must not punish: a lead that reads
    // the board, decides a handoff row is dead, kills it with a reason and
    // asks something else instead has genuinely re-aimed the pool. The new
    // question carries a key nothing was ever commissioned under, so nothing
    // is pinned and its landing is the lead's.
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 3)
          return reply(
            [
              ...call("k1", "review", {
                kill: [{ dedupeKey: "gap:unknowns-2", because: "five hosts nobody could place is not a question" }],
                why: "clearing the board",
              }),
              ...call("s1", "spawn", {
                missions: [mission("who-sells-the-scoring-step", 95, "read")],
                why: "the gap the scorecard actually names",
              }),
              ...call("n2", "next", { after: { landings: 20 }, why: "let my question come home" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "I re-aimed it", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({ lead, tiers: { peek: slowLane(), read: slowLane() }, logs, over: { fromSweep: tenMissionSweep() } }),
    )

    // The premise: the kill really took the handoff row off the board — it
    // never ran — and the lead's own question did.
    expect(run.landings.map((l) => l.mission.dedupeKey)).not.toContain("gap:unknowns-2")
    expect(run.control.commissionerBeforeKill.get("gap:unknowns-2")).toBe("sweep")
    expect(run.control.commissionedBy.get("who-sells-the-scoring-step")).toBe("lead")
    const gate = run.control.gate!
    expect(gate.refusals).toBe(1)
    expect(gate.stood).toBe("work")
    expect(gate.workAnswered).toBe(1) // exactly one: the handoff's nine other landings are not the lead's
    expect(gate.answeredBy).toEqual(["mission:who-sells-the-scoring-step(done,+0)"])
    expectEndingShape(run.ending, run.ledger)
  }, 30_000)

  it("a promote of an UNREVIEWED proposal still pays — the fix narrows the price, it does not delete it", async () => {
    // The other direction, on the real loop. An investigator's proposal holds
    // no reservation and sits in the 1-60 band under every funded row, so
    // ranking it into 61-100 genuinely commits money nothing else would have
    // spent. That is a commission, and its landing answers the refusal.
    // ONE lane, and a seed that holds it: with a lane free the harness pops
    // the proposal before the lead can look at it, and there is nothing left
    // to promote. That is the honest shape anyway — the proposal band is only
    // reached once the funded band is empty.
    const proposer = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        if (turn === 1)
          return reply(
            call("p1", "propose", {
              missions: [mission("theirs", 30, "read")],
              why: "a find I cannot chase inside this allowance",
            }),
            false,
          )
        await sleep(600) // the lane stays busy while the lead reviews the board
        return reply(text("proposed."), true)
      },
    })
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { seconds: 0.12 }, why: "let the seed think" }), false)
        if (turn === 3)
          return reply(
            [
              ...call("r1", "review", { promote: [{ dedupeKey: "theirs", priority: 95 }], why: "the whole map says so" }),
              ...call("n2", "next", { after: { landings: 20 }, why: "let it come home" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "I funded their find", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, tiers: { dig: proposer }, logs, over: { lanes: 1 } }))

    // The premise: it really was an unreviewed proposal, and the promote took.
    expect(logs.some((l) => /lane takes p95 theirs \(read\)$/.test(l))).toBe(true)
    expect(run.control.commissionedBy.get("theirs")).toBe("lead")
    const gate = run.control.gate!
    expect(gate.refusals).toBe(1)
    expect(gate.stood).toBe("work")
    expect(gate.workAnswered).toBe(1)
    expect(gate.answeredBy).toEqual(["mission:theirs(done,+0)"])
    expectEndingShape(run.ending, run.ledger)
  }, 20_000)

  // ── what the receipt says ──────────────────────────────────────────────

  it("a lead-commissioned lane that CRASHES still pays, and the receipt says so", async () => {
    // "A landing counts whatever its status" is the right rule — a market that
    // will not answer must not trap a lead, and status-gating the charge hands
    // the outcome to a race. But under a bare `mission:<key>` receipt a lane
    // that died on its first model call read exactly like one that came home
    // with forty nodes. The charge is unchanged; the RECEIPT carries the
    // digest's own facts, so a reader can tell them apart.
    const crashing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("the lane's model API failed")
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 3)
          return reply(
            [
              ...call("s1", "spawn", { missions: [mission("doomed", 95, "read")], why: "my own question" }),
              ...call("n2", "next", { after: { landings: 20 }, why: "wait for it" }),
            ],
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "I asked one", unresolved: [], why: "d" }), false)
      },
    })
    const run = await runSwarm(mkOpts({ lead, tiers: { dig: orientingSeed(), read: crashing } }))

    const doomed = run.landings.find((l) => l.mission.dedupeKey === "doomed")!
    expect(doomed.digest.status).toBe("crashed")
    expect(doomed.digest.added.nodes).toBe(0)
    expect(doomed.actualUsd).toBeLessThan(0.001) // it paid in full for about nothing
    const gate = run.control.gate!
    expect(gate.stood).toBe("work") // the rule is unchanged: the landing counts
    expect(gate.workAnswered).toBe(1)
    expect(gate.answeredBy).toEqual(["mission:doomed(crashed,+0)"]) // and the receipt is honest
    // The family floor's four lanes crashed beside it and paid nothing at all.
    expect(run.landings.filter((l) => l.mission.dedupeKey.startsWith("family:")).length).toBeGreaterThanOrEqual(3)
    expectEndingShape(run.ending, run.ledger)
  }, 20_000)

  it("after the wall warning the finish stands first time — the harness already said close", async () => {
    // wallMs just past the 45s warn margin: the warning fires ~100ms in, the
    // lead finishes on the woken turn, and the gate must not fight the wall.
    // The seed stays in flight past the warning so no dry-board wake can hand
    // the lead an earlier (still-armed) turn.
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { seconds: 600 }, why: "quiet" }), false)
        return reply(call("f1", "finish", { reason: "the wall says close", summary: "s", unresolved: [], why: "w" }), false)
      },
    })
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        await sleep(200)
        return reply(text("done."), true)
      },
    })

    const run = await runSwarm(mkOpts({ lead, inv, over: { wallClockMs: 45_100 } }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.seconds).toBeLessThan(40) // ended at the warning, not the wall
    expect(run.tally.leadTurns).toBe(2) // no refusal turn
    expect(run.control.gate!.refusals).toBe(0)
    expect(run.control.gate!.objections.length).toBeGreaterThan(0)
    expectEndingShape(run.ending, run.ledger)
  })
})

// ── tier deadlines and the wall ─────────────────────────────────────────────

describe("runSwarm: tier deadlines and the wall", () => {
  it("opts.deadlines reaches each lane by tier — a dig and a read both die at their configured wall, not the defaults", async () => {
    // Both investigators prove the run alive (one search), then hang forever.
    // With deadlines {dig: 200, read: 150} the seed dig and the spawned read
    // must both land as timeouts within a couple of seconds — if either lane
    // ran on TIER_DEADLINE_MS's measured defaults (300s / 180s) this test
    // would sit at its own 15s timeout instead.
    const hangAfterSearch = () =>
      new MockLanguageModelV4({
        doGenerate: async ({ prompt }) => {
          const turn = invTurnOf(prompt)
          if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
          return new Promise(() => {})
        },
      })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", { missions: [mission("m1", 90, "read")], why: "one read lane" }),
              ...call("2", "next", { after: { landings: 2 }, why: "wait out both walls" }),
            ],
            false,
          )
        // Restated on the turn after the gate's one refusal, same words.
        return reply(call("f1", "finish", { reason: "walls held", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({
        lead,
        tiers: { dig: hangAfterSearch(), read: hangAfterSearch() },
        over: { deadlines: { dig: 200, read: 150 } },
      }),
    )

    expect(run.ending.reason).toBe("lead-finished")
    const byKey = new Map(run.landings.map((l) => [l.mission.dedupeKey, l]))
    expect(byKey.get("orient:anchor.com")!.digest.status).toBe("timeout")
    expect(byKey.get("m1")!.digest.status).toBe("timeout")
    for (const l of run.landings) expect(l.atSec).toBeLessThan(10)
    expect(run.seconds).toBeLessThan(10)
    expectEndingShape(run.ending, run.ledger)
  }, 15_000)

  it("a 600s wall stays relative: no T-45s warning fires in a fast run, and the configured wall reaches the scorecard", async () => {
    const logs: string[] = []
    const turns: Record<number, string> = {}
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        turns[turn] = JSON.stringify(prompt.filter((m) => m.role === "user").at(-1)?.content ?? "")
        return reply(call("f1", "finish", { reason: "quick", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, logs, over: { wallClockMs: 600_000 } }))

    expect(run.ending.reason).toBe("lead-finished")
    // The warning deadline is t0 + wallMs - 45s: at 600s nothing fires in a
    // sub-second run. (The 45.1s-wall gate test pins the firing side.)
    expect(logs.some((l) => l.includes("45 seconds left"))).toBe(false)
    expect(turns[1]!).not.toContain("call finish")
    // The scorecard's wall sentence carries the configured figure, not a default.
    expect(turns[1]!).toMatch(/\ds of the 600s wall elapsed/)
  })
})

// ── money ───────────────────────────────────────────────────────────────────

describe("runSwarm: the ledger stays honest", () => {
  it("a mission's claim settles at actuals only after its pending fetch landings drain — the late draw lands", async () => {
    const spans = new SpanStream()
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        if (turn === 1)
          return reply(call("f1", "fetch", { urls: ["https://slow.com"], mode: "direct", why: "a slow page" }), false)
        return reply(text("done."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(call("fin", "finish", { reason: "done", summary: "s", unresolved: [], why: "done" }), false)
      },
    })

    const run = await runSwarm(
      mkOpts({
        lead,
        inv,
        over: {
          pendingAfterMs: 10,
          spans,
          fetch: fakeFetch({ "https://slow.com": { httpStatus: 200, body: rivalHtml, delayMs: 80, usd: 0.02 } }),
        },
      }),
    )
    spans.close()

    expect(run.ending.reason).toBe("lead-finished")
    // $0.001 search + $0.02 late fetch: the claim settled AFTER the landing,
    // so the late dollars are in every number.
    expect(run.landings[0]?.actualUsd).toBeCloseTo(0.021, 4)
    expect(run.ending.spentUsd).toBeCloseTo(0.021, 3)
    expect(run.seconds).toBeGreaterThanOrEqual(0.075)
    // Nothing invisible: the port spans carry the same dollars.
    expect(spans.totalUsd()).toBeCloseTo(0.021, 4)
    expectEndingShape(run.ending, run.ledger)
  })

  it("a mission killed while QUEUED settles its claim at $0 and ships as residue", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            [
              ...call("1", "spawn", { missions: [mission("m1", 90, "read"), mission("m2", 80, "read")], why: "fill" }),
              ...call("2", "next", { after: { landings: 1 }, why: "come back on the first landing" }),
            ],
            false,
          )
        return reply(call("fin", "finish", { reason: "enough", summary: "one lane was enough", unresolved: [], why: "d" }), false)
      },
    })
    // A deliberately slow investigator: the gate's refuse-refuse-restate
    // exchange (three instant lead turns — every refusal grants the answering
    // turn immediately, never a wait) must complete before m1 can land and
    // free the single lane, so m2 deterministically stays queued residue.
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        await sleep(80)
        return reply(text("done."), true)
      },
    })

    const run = await runSwarm(mkOpts({ lead, inv, over: { lanes: 1 } }))

    expect(run.ending.reason).toBe("lead-finished")
    // m2 was claimed at spawn but never run: its reservation came back whole;
    // the balance itself is the shape helper's line.
    expect(run.ending.residue.map((r) => r.dedupeKey)).toContain("m2")
    expect(run.finish?.summary).toBe("one lane was enough")
    expectEndingShape(run.ending, run.ledger)
  })
})

// ── the ports' own failure narration ────────────────────────────────────────

describe("runSwarm: the instrumented search and fetch ports narrate their own failure", () => {
  // orchestrator.ts wraps `opts.search`/`opts.fetch` so a rejection still lands
  // one span — kind, ok:false, the error message — before it rethrows for the
  // tool boundary to turn into a graceful refusal. Every fake port in this file
  // always resolves, so neither `catch` block had ever run.

  it("a search engine that throws is narrated as a $0 failed span, and the seed mission reads it as an empty SERP", async () => {
    const spans = new SpanStream()
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })
    const throwingSearch: SearchPort = {
      async search() {
        throw new Error("SERP zone unreachable")
      },
    }

    const run = await runSwarm(mkOpts({ lead, over: { search: throwingSearch, spans } }))
    spans.close()
    const seen: Array<{ kind: string; ok: boolean; usd: number; error?: string }> = []
    for await (const s of spans.stream()) seen.push(s)

    // The run is not derailed by the throw itself: tools-paid.ts's own
    // try/catch around `ctx.search.search` turns the rethrow into a refusal
    // the seed investigator reads, same as a live SERP answering nothing. The
    // seed then correctly reads that as stillborn — a thrown search engine and
    // an empty one are indistinguishable from here, and lying that the run
    // "finished" with a map would be worse than saying so.
    expect(run.ending.reason).toBe("stillborn")
    const failed = seen.find((s) => s.kind === "search" && !s.ok)
    expect(failed).toBeDefined()
    expect(failed?.usd).toBe(0)
    expect(failed?.error).toContain("SERP zone unreachable")
  })

  it("a fetch that throws is narrated as a $0 failed span, and the run finishes anyway", async () => {
    const spans = new SpanStream()
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        if (turn === 1)
          return reply(call("f1", "fetch", { urls: ["https://dead.example"], mode: "direct", why: "read it" }), false)
        return reply(text("done."), true)
      },
    })
    const throwingFetch: FetchPort = {
      async get() {
        throw new Error("socket reset")
      },
    }

    const run = await runSwarm(mkOpts({ lead, inv, over: { fetch: throwingFetch, spans } }))
    spans.close()
    const seen: Array<{ kind: string; ok: boolean; usd: number; error?: string }> = []
    for await (const s of spans.stream()) seen.push(s)

    expect(run.ending.reason).toBe("lead-finished")
    const failed = seen.find((s) => s.kind === "fetch" && !s.ok)
    expect(failed).toBeDefined()
    expect(failed?.usd).toBe(0)
    expect(failed?.error).toContain("socket reset")
  })
})

// ── the harvest tier through the whole loop ─────────────────────────────────

describe("runSwarm: a harvest mission over fake ports", () => {
  const fakeHarvestClassify = async () => ({
    out: {
      name: "Rival",
      kind: "company",
      what: "fraud scoring api for merchants",
      relation: "competitor",
      why: "sells the same step to the same buyer",
      spans: ["Rival sells a fraud scoring API"],
    },
    usd: 0.001,
  })

  it("a scripted investigator harvests a wave: judged hosts land as its writes, the tally reaches the report", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1)
          return reply(
            call("1", "spawn", { missions: [mission("harvest-wave", 90, "harvest")], why: "judge the wave whole" }),
            false,
          )
        return reply(call("f1", "finish", { reason: "mapped", summary: "s", unresolved: [], why: "done" }), false)
      },
    })
    // One inv model serves every tier: the seed (orientation) searches once;
    // the harvest mission calls harvest with a readable and a dead host.
    const inv = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const sys = prompt.find((m) => m.role === "system")
        const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "")
        const turn = invTurnOf(prompt)
        if (sysText.includes("harvest-wave")) {
          if (turn === 0)
            return reply(call("h1", "harvest", { hosts: ["rival.com", "dead.com"], why: "judge the wave" }), false)
          return reply(text("harvested."), true)
        }
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        return reply(text("done."), true)
      },
    })

    const run = await runSwarm(
      mkOpts({
        lead,
        inv,
        over: {
          harvestClassify: fakeHarvestClassify,
          // Explicit rows: rival.com's apex is readable, dead.com's 404s —
          // this file's fakeFetch DEFAULTS to a readable page, so the dead
          // host must be spelled out.
          fetch: fakeFetch({
            "https://rival.com/": { httpStatus: 200, body: rivalHtml },
            "https://dead.com/": { httpStatus: 404, body: "" },
          }),
        },
      }),
    )

    expect(run.ending.reason).toBe("lead-finished")
    expectEndingShape(run.ending, run.ledger)

    // The judged host is on the map as the MISSION's write — attribution free.
    const node = run.map.nodes.get("rival.com")!
    expect(node).toBeDefined()
    expect(node.relation).toBe("competitor")
    expect(node.settledBy).toBe("model")
    expect(node.tier).toBe("own-page")
    expect(node.contributions).toEqual([{ writer: "harvest-wave", tier: "own-page" }])

    // The kernel's accounting reached the run and the report, kernel-style.
    expect(run.harvest).toEqual({
      calls: 1,
      hosts: 2,
      fetched: 2,
      settledFree: 1,
      modelJudged: 1,
      unreadable: 1,
      unreadableByReason: { "http-404": 1 },
    })
    const out = serializeSwarmRun(run)
    expect((out.report as { harvest?: unknown }).harvest).toEqual(run.harvest)
    // The stamps survive serialization into the entity rows.
    const rival = out.entities.find((e) => e.domain === "rival.com")!
    expect(rival.settledBy).toBe("model")

    // The mission settled at actuals: the classify call's dollars drew on its
    // claim as the host landed, and the landing's number carries them.
    const landing = run.landings.find((l) => l.mission.dedupeKey === "harvest-wave")!
    expect(landing).toBeDefined()
    expect(landing.actualUsd).toBeCloseTo(0.001, 6)
  })

  it("a run that never harvested reports the zero tally — absent and clean must not look alike", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async () =>
        reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false),
    })
    const run = await runSwarm(mkOpts({ lead }))
    expect(run.harvest).toEqual({
      calls: 0,
      hosts: 0,
      fetched: 0,
      settledFree: 0,
      modelJudged: 0,
      unreadable: 0,
      unreadableByReason: {},
    })
    const out = serializeSwarmRun(run)
    expect((out.report as { harvest?: unknown }).harvest).toEqual(run.harvest)
  })
})
