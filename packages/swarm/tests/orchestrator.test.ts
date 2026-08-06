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
import { runSwarm, seedMission, serializeSwarmRun, type SwarmEnding, type SwarmOptions, type SwarmRun } from "../src/index.js"

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
      return queries.map((query) => ({ query, hits: o.hits ?? [HIT], ok: true, usd: o.usd ?? 0.001, ms: 1 }))
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
        if (turn === 2) {
          // The lead THINKS: this turn refuses to end until m2's landing has
          // been narrated. If landings needed the lead to be idle, this would
          // deadlock — the timeout below is the barrier detector.
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
    expect(logs.some((l) => l.includes("lead turn 2") && / — spawned 0, refused 0 — finish called$/.test(l))).toBe(true)
    // Every landing narrates the lane freeing: lens, key, status, delta, dollars.
    expect(logs.some((l) => /lane frees: rivals \(m1\) — done, \+\d+ nodes \+\d+ edges, \$[\d.]+/.test(l))).toBe(true)
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
        return reply(text("idle."), true)
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

    const run = await runSwarm(mkOpts({ lead, over: { lanes: 1 } }))

    expect(run.ending.reason).toBe("lead-finished")
    // m2 was claimed at spawn but never run: its reservation came back whole;
    // the balance itself is the shape helper's line.
    expect(run.ending.residue.map((r) => r.dedupeKey)).toContain("m2")
    expect(run.finish?.summary).toBe("one lane was enough")
    expectEndingShape(run.ending, run.ledger)
  })
})
