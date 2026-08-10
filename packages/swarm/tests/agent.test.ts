import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { LanguageModel } from "ai"
import {
  ALLOWANCES,
  Board,
  BreakerTable,
  Ledger,
  type FetchPort,
  type Mission,
  type SearchPort,
} from "@open-kb/core"
import {
  MapState,
  RunEvidence,
  newRunControl,
  runLead,
  runInvestigator,
  rememberOutcome,
  spawnTool,
  estimateTokens,
  LEAD_TURN_CAP,
  TIER_DEADLINE_MS,
  DIGEST_TOKEN_CAP,
  type LeadDeps,
  type InvestigatorDeps,
  type HarvestClassify,
  type SearchTrace,
} from "../src/index.js"

// ── fakes, in this package's test idiom ─────────────────────────────────────

// Padded past core's THIN_TEXT floor (200 extracted chars) so sniff() says found.
const rivalHtml =
  `<html><body><h1>Rival</h1><p>Rival sells a fraud scoring API to online merchants. ` +
  `The platform scores every checkout in real time, flags stolen cards before authorization, ` +
  `and hands risk teams a review queue so a small fraud team can cover a large storefront ` +
  `without writing rules by hand.</p></body></html>`

function fakeSearch(rows: Record<string, Array<{ url: string; title: string; description: string }>>): SearchPort {
  return {
    async search(queries) {
      return [...new Set(queries)].map((query) => ({ query, hits: rows[query] ?? [], ok: true, usd: 0.001, ms: 2 }))
    },
  }
}

function fakeFetch(rows: Record<string, { httpStatus: number; body: string; contentType?: string }>): FetchPort {
  return {
    async get(url) {
      const row = rows[url] ?? { httpStatus: 404, body: "" }
      return { url, httpStatus: row.httpStatus, body: row.body, contentType: row.contentType, ms: 1, usd: 0 }
    },
  }
}

// A short stand-in for prompts/swarm/skill.md — the runner takes the text, not the path.
const SKILL = "# Doctrine\nProve what you claim with a quote from bytes this run fetched.\nRecord as you go."

/** One scripted tool call, in the V4 content shape ToolLoopAgent tests use. */
const call = (id: string, toolName: string, input: unknown) => [
  { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
]

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
}

// Generic so the scripted content keeps its literal type — the V4 result type
// refuses a widened unknown[].
const reply = <C,>(content: C, done: boolean) => ({
  content,
  finishReason: { unified: done ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
  usage,
  warnings: [],
})

/** Everything both runners share, built fresh per test. */
function harness(ceilingUsd: number) {
  const ledger = new Ledger(ceilingUsd)
  return {
    ledger,
    evidence: new RunEvidence(),
    map: new MapState("anchor.com"),
    board: new Board(),
    control: newRunControl(),
    breaker: new BreakerTable(),
    search: fakeSearch({
      "fraud scoring for merchants": [
        { url: "https://rival.com", title: "Rival", description: "Rival sells fraud scoring to online merchants" },
        { url: "https://second.com", title: "Second", description: "Second scores checkout fraud for merchants" },
        { url: "https://third.com", title: "Third", description: "Third scores checkout fraud for merchants" },
      ],
    }),
    fetch: fakeFetch({ "https://rival.com": { httpStatus: 200, body: rivalHtml } }),
    seen: new Set<string>(),
    searches: [] as SearchTrace[],
    skill: SKILL,
  }
}

const mission: Mission = {
  lens: "rivals",
  brief: "who else sells fraud scoring to online merchants",
  why: "the shortlist is the half of the map a reader checks first",
  priority: 80,
  tier: "read",
  dedupeKey: "rivals-fraud-scoring",
}

function investigatorDeps(
  h: ReturnType<typeof harness>,
  model: LanguageModel,
  claimId: string,
  extra: Partial<InvestigatorDeps> = {},
): InvestigatorDeps {
  return {
    ...h,
    claimId,
    coinages: ["AnchorPay", "anchorpay"],
    models: { peek: model, read: model, dig: model },
    pricing: {
      peek: { inUsdPerM: 10, outUsdPerM: 10 },
      read: { inUsdPerM: 10, outUsdPerM: 10 },
      dig: { inUsdPerM: 10, outUsdPerM: 10 },
    },
    ...extra,
  }
}

const toolNames = (options: unknown): string[] =>
  (((options as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name) as string[]).sort()

// ── the lead ────────────────────────────────────────────────────────────────

describe("runLead", () => {
  it("prefixes the one role line, exposes all nine tools, and settles the turn's real cost on the ledger", async () => {
    const h = harness(5)
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        return turn === 0
          ? reply(call("1", "recall", { op: "stats", why: "see the board before spending" }), false)
          : reply([{ type: "text" as const, text: "oriented." }], true)
      },
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 10, outUsdPerM: 10 } })

    const first = await lead.leadTurn()
    expect(first.kind).toBe("turn")
    if (first.kind === "turn") expect(first.finished).toBe(false)

    const options = model.doGenerateCalls[0]!
    const system = String(options.prompt.find((m) => m.role === "system")?.content ?? "")
    expect(system.startsWith("You are the LEAD. Target: anchor.com. Ceiling $5.00. GO.")).toBe(true)
    expect(system).toContain("Prove what you claim")
    expect(toolNames(options)).toEqual(
      ["search", "fetch", "read", "recall", "remember", "spawn", "review", "next", "finish"].sort(),
    )

    // The turn's model cost landed on the ledger as spend, not as a dangling claim.
    expect(h.ledger.spentUsd()).toBeCloseTo((1000 * 10 + 50 * 10) / 1e6, 6)

    const second = await lead.leadTurn()
    expect(second.kind).toBe("turn")
  })

  it("injects S7's notes as the next turn's user message", async () => {
    const h = harness(5)
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply([{ type: "text" as const, text: "noted." }], true),
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 0, outUsdPerM: 0 } })

    await lead.leadTurn(["mission rivals-fraud-scoring landed: done, +3 nodes"])
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(prompt).toContain("mission rivals-fraud-scoring landed: done, +3 nodes")
  })

  it("an unaffordable turn becomes ONE free closing turn with only free tools, then the run is done", async () => {
    // Ceiling $0.13: finish reserve $0.12, spendable $0.01. At $1000/M with the
    // 800-token output headroom no metered turn fits.
    const h = harness(0.13)
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        reply(
          call("1", "finish", {
            reason: "out of money",
            summary: "the map holds what the pool bought",
            unresolved: ["registry sweep"],
            why: "the pool no longer affords a metered turn",
          }),
          false,
        ),
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 1000, outUsdPerM: 1000 } })

    const closing = await lead.leadTurn()
    expect(closing.kind).toBe("closing")
    if (closing.kind === "closing") expect(closing.finished).toBe(true)

    const options = model.doGenerateCalls[0]!
    // The toolset was swapped: free tools plus finish, nothing that spends.
    expect(toolNames(options)).toEqual(["read", "recall", "remember", "finish"].sort())
    // The lead is told in-band why this turn is different.
    expect(JSON.stringify(options.prompt)).toContain("free closing turn")
    expect(h.control.finished?.reason).toBe("out of money")

    const after = await lead.leadTurn()
    expect(after.kind).toBe("done")
  })

  it("the tight-reserve fallback settles at actuals, not actuals plus the peek headroom", async () => {
    // Ceiling $0.20: finish reserve $0.12, spendable $0.08. Input is free and
    // the 800-token output headroom at $75/M prices the turn estimate at
    // exactly $0.06 whatever the transcript length — so the wide reserve
    // ($0.09) fails and the tight one ($0.06) is granted. This is the last
    // affordable metered turn of a budget-bound run.
    const h = harness(0.2)
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply([{ type: "text" as const, text: "done." }], true),
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 0, outUsdPerM: 75 } })

    const out = await lead.leadTurn()
    expect(out.kind).toBe("turn")
    // The turn's real cost is 50 output tokens at $75/M. Pricing the drawn
    // total against the WIDE figure here settled at actuals + a phantom $0.03.
    expect(h.ledger.spentUsd()).toBeCloseTo((50 * 75) / 1e6, 6)
  })

  it("a paid draw inside a lead turn lands in that turn's settle", async () => {
    const h = harness(5)
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        return turn === 0
          ? reply(call("1", "search", { queries: ["fraud scoring for merchants"], why: "buy one wave" }), false)
          : reply([{ type: "text" as const, text: "done." }], true)
      },
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 0, outUsdPerM: 0 } })

    await lead.leadTurn()
    // One $0.001 SERP row drawn on the turn's claim; model tokens are free
    // here, so the settle is exactly the tool's spend — no phantom headroom.
    expect(h.ledger.spentUsd()).toBeCloseTo(0.001, 6)

    const second = await lead.leadTurn()
    expect(second.kind).toBe("turn")
  })

  it("a review turn through the SDK path promotes a proposal and kills a funded angle, money back the same call", async () => {
    const h = harness(5)
    // A worker proposal sits unreviewed in the 1-60 band…
    h.board.push({ ...mission, priority: 40, dedupeKey: "worker-idea" }, "investigator")
    // …and a funded lead mission is queued, its read allowance held on the pool.
    const ctl = { board: h.board, ledger: h.ledger, control: h.control, commissioner: "lead" as const }
    spawnTool(ctl, { missions: [{ ...mission, priority: 70, dedupeKey: "dead-angle" }], why: "fund the angle" })
    expect(h.ledger.spendable()).toBeCloseTo(4.5 - ALLOWANCES.read)

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        return turn === 0
          ? reply(
              call("1", "review", {
                promote: [{ dedupeKey: "worker-idea", priority: 86 }],
                kill: [{ dedupeKey: "dead-angle", because: "the rivals lens already asks this" }],
                why: "rank the board with the whole map in view",
              }),
              false,
            )
          : reply([{ type: "text" as const, text: "board reviewed." }], true)
      },
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 0, outUsdPerM: 0 } })
    const out = await lead.leadTurn()
    expect(out.kind).toBe("turn")

    // The proposal now sits in the lead's band, reviewed; the killed angle is gone.
    const rows = h.board.residue()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ dedupeKey: "worker-idea", priority: 86, unreviewed: false })
    // The dead angle's reservation returned to the pool in the same call, not at run end.
    expect(h.control.claims.has("dead-angle")).toBe(false)
    expect(h.ledger.spendable()).toBeCloseTo(4.5, 6)
    // The tool's outcome rows reach the model on its next turn.
    await lead.leadTurn()
    const second = JSON.stringify(model.doGenerateCalls[1]!.prompt)
    expect(second).toContain("worker-idea")
    expect(second).toContain("poolLeftUsd")
  })

  it("the 24-turn cap is a loop detector: turn 25 refuses loudly", async () => {
    const h = harness(50)
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply(call("1", "recall", { op: "stats", why: "looping" }), false),
    })
    const lead = runLead({ ...h, domain: "anchor.com", model, pricing: { inUsdPerM: 0, outUsdPerM: 0 } })

    for (let i = 0; i < LEAD_TURN_CAP; i++) {
      const out = await lead.leadTurn()
      expect(out.kind).toBe("turn")
    }
    const out = await lead.leadTurn()
    expect(out.kind).toBe("done")
    if (out.kind === "done") {
      expect(out.loopDetected).toBe(true)
      expect(out.because).toContain(`${LEAD_TURN_CAP} turns`)
    }
    expect(model.doGenerateCalls.length).toBe(LEAD_TURN_CAP)
  })
})

// ── the investigator ────────────────────────────────────────────────────────

describe("runInvestigator", () => {
  it("runs a scripted mission end to end: search, fetch, remember, digest — real MapState rows, real ledger draws", async () => {
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.read)
    if (!held.ok) throw new Error("reserve failed")

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0)
          return reply(call("1", "search", { queries: ["fraud scoring for merchants"], why: "find the shortlist" }), false)
        if (turn === 1)
          return reply(call("2", "fetch", { urls: ["https://rival.com"], mode: "direct", why: "confirm the host" }), false)
        if (turn === 2)
          return reply(
            call("3", "remember", {
              nodes: [
                {
                  name: "Rival",
                  domain: "rival.com",
                  kind: "company",
                  what: "fraud scoring API for online merchants",
                  relation: "competitor",
                  why: "sells the fraud-scoring step the anchor bundles into checkout, standalone",
                  evidence: [{ url: "https://rival.com", quote: "Rival sells a fraud scoring API" }],
                },
              ],
              why: "the page proves it",
            }),
            false,
          )
        return reply([{ type: "text" as const, text: "mission worked." }], true)
      },
    })

    const digest = await runInvestigator(mission, investigatorDeps(h, model, held.claimId))

    expect(digest.status).toBe("done")
    expect(digest.added).toEqual({ nodes: 1 })
    expect(digest.merged).toEqual({ nodes: 0 })
    expect(digest.findings.length).toBeGreaterThan(0)
    expect(digest.findings[0]).toContain("Rival")
    // Runner-computed spend: one $0.001 search plus four model turns at $0.0105.
    expect(digest.spentUsd).toBeCloseTo(0.001 + 4 * 0.0105, 4)

    // The map row is real and carries the proven citation.
    const node = h.map.nodes.get("rival.com")!
    expect(node.relation).toBe("competitor")
    expect(node.evidence[0]!.url).toBe("https://rival.com")

    // The system line names the mission and the bans; the lead's control seat is not offered.
    const options = model.doGenerateCalls[0]!
    const system = String(options.prompt.find((m) => m.role === "system")?.content ?? "")
    expect(system).toContain("INVESTIGATOR")
    expect(system).toContain(mission.lens)
    expect(system).toContain(mission.brief)
    expect(system).toContain(mission.why)
    expect(system).toContain("read")
    expect(system).toContain("AnchorPay")
    expect(system).toContain("The map so far")
    expect(toolNames(options)).toEqual(["search", "fetch", "read", "recall", "remember", "propose"].sort())
    for (const leadOnly of ["review", "spawn", "next", "finish"]) {
      expect(toolNames(options), `investigator must not hold ${leadOnly}`).not.toContain(leadOnly)
    }
  })

  it("a wall-deadline kill leaves every map write standing and the digest says timeout", async () => {
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.read)
    if (!held.ok) throw new Error("reserve failed")

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0)
          return reply(call("1", "search", { queries: ["fraud scoring for merchants"], why: "find the shortlist" }), false)
        if (turn === 1)
          return reply(
            call("2", "remember", {
              nodes: [
                {
                  name: "Rival",
                  domain: "rival.com",
                  kind: "company",
                  what: "fraud scoring",
                  relation: "competitor",
                  why: "same capability sold to the same buyer, per the engine's own snippet",
                  evidence: [{ url: "https://rival.com", quote: "Rival sells fraud scoring" }],
                },
              ],
              why: "record before the clock",
            }),
            false,
          )
        // Turn 2 hangs forever and ignores the abort signal — the wall must win anyway.
        return new Promise(() => {})
      },
    })

    const digest = await runInvestigator(mission, investigatorDeps(h, model, held.claimId, { deadlineMs: 250 }))

    expect(digest.status).toBe("timeout")
    expect(digest.added.nodes).toBe(1)
    expect(h.map.nodes.get("rival.com")).toBeDefined()
  })

  it("crossing 80% of the allowance injects the write-down line into the next model input, once", async () => {
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.peek)
    if (!held.ok) throw new Error("reserve failed")
    h.ledger.draw(held.claimId, 0.025) // 83% of the peek allowance already gone

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0) return reply(call("1", "recall", { op: "stats", why: "check the board" }), false)
        if (turn === 1) return reply(call("2", "recall", { op: "gaps", why: "what needs writing" }), false)
        return reply([{ type: "text" as const, text: "written down." }], true)
      },
    })

    const digest = await runInvestigator({ ...mission, tier: "peek" }, {
      ...investigatorDeps(h, model, held.claimId),
      pricing: {
        peek: { inUsdPerM: 0, outUsdPerM: 0 },
        read: { inUsdPerM: 0, outUsdPerM: 0 },
        dig: { inUsdPerM: 0, outUsdPerM: 0 },
      },
    })

    const line = /\$\d+\.\d+ left — write down what you have/
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toMatch(line)
    // Injected once, not repeated on the following turn.
    const third = JSON.stringify(model.doGenerateCalls[2]!.prompt)
    expect(third.match(new RegExp(line, "g"))?.length ?? 0).toBe(1)
    expect(digest.status).toBe("done")
  })

  it("two consecutive paid refusals inject the spent line and the digest says spent", async () => {
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.peek)
    if (!held.ok) throw new Error("reserve failed")
    h.ledger.draw(held.claimId, ALLOWANCES.peek) // fully spent — paid tools refuse from here

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0) return reply(call("1", "search", { queries: ["one more idea"], why: "one more" }), false)
        if (turn === 1) return reply(call("2", "search", { queries: ["another idea"], why: "again" }), false)
        return reply([{ type: "text" as const, text: "finishing with what I hold." }], true)
      },
    })

    const digest = await runInvestigator({ ...mission, tier: "peek" }, {
      ...investigatorDeps(h, model, held.claimId),
      pricing: {
        peek: { inUsdPerM: 0, outUsdPerM: 0 },
        read: { inUsdPerM: 0, outUsdPerM: 0 },
        dig: { inUsdPerM: 0, outUsdPerM: 0 },
      },
    })

    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain(
      "your allowance is spent; finish with what you hold",
    )
    expect(digest.status).toBe("spent")
  })

  it("the digest stays under 120 tokens by truncating findings, and its counts come from the map, not the model", async () => {
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.read)
    if (!held.ok) throw new Error("reserve failed")

    const longWhat = "scores checkout fraud for merchants " + "with a very long pitch ".repeat(30)
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0)
          return reply(call("1", "search", { queries: ["fraud scoring for merchants"], why: "find them" }), false)
        if (turn === 1)
          return reply(
            call("2", "remember", {
              nodes: ["second.com", "third.com"].map((domain) => ({
                name: domain,
                domain,
                kind: "company",
                what: longWhat,
                relation: "competitor",
                why: "the engine's snippet names the capability and the buyer in one line",
                evidence: [{ url: `https://${domain}`, quote: "scores checkout fraud for merchants" }],
              })),
              why: "snippets are real evidence",
            }),
            false,
          )
        return reply([{ type: "text" as const, text: "I personally added nine hundred nodes." }], true)
      },
    })

    const digest = await runInvestigator(mission, investigatorDeps(h, model, held.claimId))

    expect(digest.added).toEqual({ nodes: 2 }) // the map's count, not the model's story
    expect(digest.findings.length).toBeLessThanOrEqual(3)
    expect(estimateTokens(JSON.stringify(digest))).toBeLessThanOrEqual(DIGEST_TOKEN_CAP)
    // Truncation really happened: the raw what alone is far past the whole budget.
    expect(longWhat.length).toBeGreaterThan(DIGEST_TOKEN_CAP * 4)
  })

  it("ships tier deadlines measured on the 2026-08-05 live runs, not the design's 45/90/150s", () => {
    // harvest borrows dig's wall: 40 front pages plus per-residue model calls
    // are the run's longest single tool call, and the tool settles per host.
    expect(TIER_DEADLINE_MS).toEqual({ peek: 60_000, read: 180_000, dig: 300_000, harvest: 300_000 })
  })

  it("the 1.5x overrun bound is advisory at the boundary: the crossing turn's cost stands, only the NEXT turn is stopped", async () => {
    // The measured shape from runs/swarm-brightdata-com-202608052348.json:
    // the enterprise_competitors read stood at $0.145 of its $0.10 allowance
    // after turn 8 (under the $0.15 bound, so the check passed) and turn 9
    // alone cost $0.045, landing the mission at $0.189 — 1.9x — before any
    // boundary could see it. Here each turn costs $0.04 (1000 in at $38/M +
    // 50 out at $40/M), so the read allowance's bound at $0.15 passes turn 3
    // ($0.12 — already past the allowance itself, and the loop honestly
    // continues: model turns have no pre-call gate) and turn 4 crosses to
    // $0.16, 1.6x, where the mission stops as "spent".
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.read)
    if (!held.ok) throw new Error("reserve failed")

    const model = new MockLanguageModelV4({
      doGenerate: async () => reply(call("1", "recall", { op: "stats", why: "one more look" }), false),
    })

    const digest = await runInvestigator(mission, {
      ...investigatorDeps(h, model, held.claimId),
      pricing: {
        peek: { inUsdPerM: 38, outUsdPerM: 40 },
        read: { inUsdPerM: 38, outUsdPerM: 40 },
        dig: { inUsdPerM: 38, outUsdPerM: 40 },
      },
    })

    expect(digest.status).toBe("spent")
    // The overshoot stands: the bound never caps the total, it stops the next turn.
    expect(digest.spentUsd).toBeCloseTo(0.16, 6)
    expect(digest.spentUsd).toBeGreaterThan(1.5 * ALLOWANCES.read)
    expect(model.doGenerateCalls.length).toBe(4)
    // The claim's sub-ledger carries the honest negative.
    const room = h.ledger.draw(held.claimId, 0)
    if (!room.ok) throw new Error("claim gone")
    expect(room.remainingUsd).toBeCloseTo(ALLOWANCES.read - 0.16, 6)
  })
})

// ── the landing digest under concurrency ────────────────────────────────────

/**
 * The bug these cover, in one sentence: the digest used to be a GLOBAL map-size
 * delta over the mission's lifetime, so with six lanes on one map a mission's
 * reported yield was its neighbours' work, and it decayed as the lanes drained
 * rather than as the market emptied — which is what the lead read to decide the
 * market was exhausted (docs/swarm-yield-diagnosis.md; five of eight runs ended
 * `lead-finished` with 25-81% of the ceiling unspent).
 *
 * So every test here runs TWO LANES AGAINST ONE MAP — interleaved where the
 * point is concurrency, staggered where the point is what a second writer on
 * one node means — and pins each digest to its own writes. A single-lane
 * arithmetic check passes under the old code too and would have caught none of
 * this: three of these four fail against it, and the fourth pins a semantic
 * choice the old code never had to make.
 */

/** A one-shot rendezvous: `passed` resolves when someone calls `open`. Two
 *  scripted models hold each other's turn order with these, so the interleaving
 *  is exact instead of timing-dependent. */
function gate(): { open: () => void; passed: Promise<void> } {
  let open!: () => void
  const passed = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, passed }
}

/** The three-turn lane every test below scripts: buy one wave, write one node,
 *  say done — with a hold before the write (`before`) and another before the
 *  closing turn (`until`), so the caller can order two lanes against each
 *  other. `held` fires once this lane's write HAS landed: turn 2 exists only
 *  because turn 1's tool already ran, which is the only reliable "it landed"
 *  signal a scripted model has. */
function writingLane(o: {
  domain: string
  name: string
  before?: Promise<void>
  until?: Promise<void>
  held?: () => void
}): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const turn = prompt.filter((m) => m.role === "tool").length
      if (turn === 0)
        return reply(call("1", "search", { queries: ["fraud scoring for merchants"], why: "find the shortlist" }), false)
      if (turn === 1) {
        await o.before
        return reply(
          call("2", "remember", {
            nodes: [
              {
                name: o.name,
                domain: o.domain,
                kind: "company",
                what: "scores checkout fraud for merchants",
                relation: "competitor",
                why: "the engine's own snippet names the capability and the buyer in one line",
                evidence: [{ url: `https://${o.domain}`, quote: "scores checkout fraud for merchants" }],
              },
            ],
            why: "record what the wave named",
          }),
          false,
        )
      }
      o.held?.()
      await o.until
      return reply([{ type: "text" as const, text: "mission worked." }], true)
    },
  })
}

describe("the landing digest reports THIS mission's writes", () => {
  it("two lanes on one map: each digest carries its own node, never its neighbour's", async () => {
    const h = harness(5)
    const a = h.ledger.reserve(ALLOWANCES.read)
    const b = h.ledger.reserve(ALLOWANCES.read)
    if (!a.ok || !b.ok) throw new Error("reserve failed")

    // A writes first, B second, and NEITHER closes until both writes have
    // landed — so at the moment each digest is computed the map holds two
    // nodes and the old size delta reported 2 for both lanes.
    const aWrote = gate()
    const bWrote = gate()
    const modelA = writingLane({ domain: "second.com", name: "Second", held: aWrote.open, until: bWrote.passed })
    const modelB = writingLane({ domain: "third.com", name: "Third", before: aWrote.passed, held: bWrote.open })

    const [digestA, digestB] = await Promise.all([
      runInvestigator({ ...mission, dedupeKey: "lane-a" }, investigatorDeps(h, modelA, a.claimId)),
      runInvestigator({ ...mission, dedupeKey: "lane-b" }, investigatorDeps(h, modelB, b.claimId)),
    ])

    // The map really did hold both nodes while both digests were computed.
    expect(h.map.nodes.size).toBe(2)
    expect(digestA.added).toEqual({ nodes: 1 })
    expect(digestB.added).toEqual({ nodes: 1 })
    expect(digestA.merged).toEqual({ nodes: 0 })
    expect(digestB.merged).toEqual({ nodes: 0 })

    // Findings were contaminated the same way and are fixed by the same
    // predicate: a lane names what IT proved, so the lead cannot quote a
    // neighbour's company back into this lane's next brief.
    expect(digestA.findings).toHaveLength(1)
    expect(digestA.findings[0]).toContain("Second")
    expect(digestB.findings).toHaveLength(1)
    expect(digestB.findings[0]).toContain("Third")

    // And the attribution came from the stamps the map already kept — no
    // second mechanism counts anything here.
    expect(h.map.nodes.get("second.com")!.contributions).toEqual([{ writer: "lane-a", tier: "snippet" }])
    expect(h.map.nodes.get("third.com")!.contributions).toEqual([{ writer: "lane-b", tier: "snippet" }])
  })

  it("a mission that writes nothing reports nothing, however much its neighbour lands", async () => {
    // The `lead-finished` mechanism in miniature: under the old delta this
    // lane reported +1 node and narrated its neighbour's company to the lead
    // as its own finding, having bought nothing but two free recalls. A board
    // of lanes like this is how a run reports yield it did not produce — and
    // how the same lanes report zero once the neighbours drain.
    const h = harness(5)
    const a = h.ledger.reserve(ALLOWANCES.read)
    const idle = h.ledger.reserve(ALLOWANCES.peek)
    if (!a.ok || !idle.ok) throw new Error("reserve failed")

    const aWrote = gate()
    const idleDone = gate()
    const modelA = writingLane({ domain: "second.com", name: "Second", held: aWrote.open, until: idleDone.passed })
    const modelIdle = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0) return reply(call("1", "recall", { op: "stats", why: "see the map first" }), false)
        if (turn === 1) {
          await aWrote.passed // read the map only after the neighbour has landed
          return reply(call("2", "recall", { op: "gaps", why: "look for something to prove" }), false)
        }
        idleDone.open()
        return reply([{ type: "text" as const, text: "nothing here I could prove." }], true)
      },
    })

    const [digestA, digestIdle] = await Promise.all([
      runInvestigator({ ...mission, dedupeKey: "lane-a" }, investigatorDeps(h, modelA, a.claimId)),
      runInvestigator({ ...mission, tier: "peek", dedupeKey: "lane-idle" }, investigatorDeps(h, modelIdle, idle.claimId)),
    ])

    expect(digestA.added).toEqual({ nodes: 1 })
    expect(digestIdle.added).toEqual({ nodes: 0 })
    expect(digestIdle.merged).toEqual({ nodes: 0 })
    expect(digestIdle.findings).toEqual([])
  })

  it("a mission that merges into a standing node reports it as confirmed, not as nothing and not as new", async () => {
    const h = harness(5)
    const a = h.ledger.reserve(ALLOWANCES.read)
    const b = h.ledger.reserve(ALLOWANCES.read)
    if (!a.ok || !b.ok) throw new Error("reserve failed")

    // Staggered, the way a board fills lanes: A lands second.com and finishes,
    // and only then does B start — so second.com is in B's before-snapshot,
    // which is what makes B's write a confirmation rather than a find.
    const digestA = await runInvestigator(
      { ...mission, dedupeKey: "lane-a" },
      investigatorDeps(h, writingLane({ domain: "second.com", name: "Second" }), a.claimId),
    )
    const digestB = await runInvestigator(
      { ...mission, dedupeKey: "lane-b" },
      investigatorDeps(h, writingLane({ domain: "second.com", name: "Second Inc" }), b.claimId),
    )

    expect(digestA.added).toEqual({ nodes: 1 })
    // B found no new host — but it proved a standing one a second time, and
    // the lead must be able to tell that from an empty mission: the count says
    // confirmed, and the finding names what was confirmed.
    expect(digestB.added).toEqual({ nodes: 0 })
    expect(digestB.merged).toEqual({ nodes: 1 })
    expect(digestB.findings).toHaveLength(1)
    expect(digestB.findings[0]).toContain("Second")
    // One node, both writers on it — the merge is why `merged` exists.
    expect(h.map.nodes.size).toBe(1)
    expect(new Set(h.map.nodes.get("second.com")!.contributions.map((c) => c.writer))).toEqual(
      new Set(["lane-a", "lane-b"]),
    )
  })

  it("a neighbour merging into my node does not demote my find — the count is invariant to what other lanes do", async () => {
    // The alternative semantics — "credit only the sole writer of a node" —
    // would report 0 for lane A here, which is the original disease in the
    // other direction: A's number moving because B did something.
    const h = harness(5)
    const a = h.ledger.reserve(ALLOWANCES.read)
    const b = h.ledger.reserve(ALLOWANCES.read)
    if (!a.ok || !b.ok) throw new Error("reserve failed")

    const aWrote = gate()
    const bWrote = gate()
    const modelA = writingLane({ domain: "second.com", name: "Second", held: aWrote.open, until: bWrote.passed })
    const modelB = writingLane({
      domain: "second.com",
      name: "Second Inc",
      before: aWrote.passed,
      held: bWrote.open,
    })

    const [digestA, digestB] = await Promise.all([
      runInvestigator({ ...mission, dedupeKey: "lane-a" }, investigatorDeps(h, modelA, a.claimId)),
      runInvestigator({ ...mission, dedupeKey: "lane-b" }, investigatorDeps(h, modelB, b.claimId)),
    ])

    expect(digestA.added).toEqual({ nodes: 1 })
    expect(digestA.merged).toEqual({ nodes: 0 })
    // And the documented limit, pinned so nobody "fixes" it in silence: both
    // lanes started with an empty map, so neither one's before-snapshot holds
    // second.com and B counts its co-discovery as a find too. contributions is
    // a SET — the map cannot say who arrived first — so one host is counted
    // twice here. Bounded by co-discovery of the SAME host inside one
    // lifetime, against a delta that counted every neighbour's every write.
    expect(digestB.added).toEqual({ nodes: 1 })
    expect(h.map.nodes.size).toBe(1)
  })
})

// ── the harvest seat ────────────────────────────────────────────────────────

describe("the harvest tool's seat", () => {
  const fakeHarvestClassify: HarvestClassify = async () => ({
    out: {
      name: "Rival",
      kind: "company",
      what: "fraud scoring api for merchants",
      relation: "competitor",
      why: "sells the same step to the same buyer",
      spans: ["Rival sells a fraud scoring API"],
    },
    usd: 0.002,
  })

  it("investigators hold harvest exactly when the classify closure is wired; the lead NEVER holds it", async () => {
    const h = harness(5)
    // The lead, closure wired and all: still the same nine tools, no harvest —
    // the lead delegates, and bulk judging from its chair is the
    // one-context-buys-everything failure the skill forbids.
    const leadModel = new MockLanguageModelV4({
      doGenerate: async () => reply([{ type: "text" as const, text: "done." }], true),
    })
    const lead = runLead({
      ...h,
      harvestClassify: fakeHarvestClassify,
      domain: "anchor.com",
      model: leadModel,
      pricing: { inUsdPerM: 0, outUsdPerM: 0 },
    })
    await lead.leadTurn()
    expect(toolNames(leadModel.doGenerateCalls[0]!)).toEqual(
      ["search", "fetch", "read", "recall", "remember", "spawn", "review", "next", "finish"].sort(),
    )
    expect(toolNames(leadModel.doGenerateCalls[0]!)).not.toContain("harvest")

    // An investigator with the closure: harvest joins its seat.
    const invModel = new MockLanguageModelV4({
      doGenerate: async () => reply([{ type: "text" as const, text: "done." }], true),
    })
    const held = h.ledger.reserve(ALLOWANCES.read)
    if (!held.ok) throw new Error("reserve failed")
    await runInvestigator(mission, {
      ...investigatorDeps(h, invModel, held.claimId),
      harvestClassify: fakeHarvestClassify,
    })
    expect(toolNames(invModel.doGenerateCalls[0]!)).toEqual(
      ["search", "fetch", "read", "recall", "remember", "propose", "harvest"].sort(),
    )
  })

  it("a harvest mission runs end to end through the SDK path: judged hosts land as the mission's own writes", async () => {
    const h = harness(5)
    const held = h.ledger.reserve(ALLOWANCES.harvest)
    if (!held.ok) throw new Error("reserve failed")

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        if (turn === 0)
          return reply(
            call("1", "harvest", { hosts: ["rival.com", "dead.com"], why: "judge the whole wave at once" }),
            false,
          )
        return reply([{ type: "text" as const, text: "harvested." }], true)
      },
    })

    const digest = await runInvestigator(
      { ...mission, tier: "harvest", dedupeKey: "harvest-rivals" },
      {
        ...investigatorDeps(h, model, held.claimId),
        harvestClassify: fakeHarvestClassify,
        // The kernel fetches each host's apex with the trailing slash; the
        // harness fixture's key has none, and dead.com must stay unreadable.
        fetch: fakeFetch({ "https://rival.com/": { httpStatus: 200, body: rivalHtml } }),
      },
    )

    // rival.com had a readable page and landed; dead.com was unreadable with
    // no citable bytes anywhere in the run, so the mint refused it.
    expect(digest.status).toBe("done")
    expect(digest.added.nodes).toBe(1)
    const node = h.map.nodes.get("rival.com")!
    expect(node).toBeDefined()
    expect(node.relation).toBe("competitor")
    expect(node.settledBy).toBe("model")
    expect(node.tier).toBe("own-page")
    // The writer stamp is the mission's dedupeKey — attribution came free.
    expect(node.contributions).toEqual([{ writer: "harvest-rivals", tier: "own-page" }])
    // The books: two model turns at the harness's prices plus the classify
    // call's dollars, all drawn on the mission's claim as they landed.
    expect(digest.spentUsd).toBeCloseTo(2 * 0.0105 + 0.002, 4)
  })
})

// ── shared guarantees ───────────────────────────────────────────────────────

describe("prompts never name a model", () => {
  it("everything either runner sends carries tier words only, even when the model ids say gemini-flash", async () => {
    const h = harness(5)
    const leadModel = new MockLanguageModelV4({
      provider: "gemini",
      modelId: "gemini-3-flash-preview",
      doGenerate: async () => reply([{ type: "text" as const, text: "done." }], true),
    })
    const lead = runLead({ ...h, domain: "anchor.com", model: leadModel, pricing: { inUsdPerM: 0, outUsdPerM: 0 } })
    await lead.leadTurn()

    const invModel = new MockLanguageModelV4({
      provider: "gemini",
      modelId: "gemini-3.5-flash",
      doGenerate: async () => reply([{ type: "text" as const, text: "done." }], true),
    })
    const held = h.ledger.reserve(ALLOWANCES.read)
    if (!held.ok) throw new Error("reserve failed")
    await runInvestigator(mission, investigatorDeps(h, invModel, held.claimId))

    for (const options of [...leadModel.doGenerateCalls, ...invModel.doGenerateCalls]) {
      expect(JSON.stringify(options)).not.toMatch(/gemini|flash/i)
    }
  })
})

describe("rememberOutcome — what the span log learns from a remember call", () => {
  const base = {
    added: { nodes: 0, edges: 0, retractions: 0 },
    merged: { nodes: 0, edges: 0 },
    rejected: [] as Array<{ item: string; reason: string }>,
    downgraded: [] as Array<{ key: string; relation: string; because: string; hint: string }>,
    poolLeftUsd: 1,
  }

  it("a call that landed nine and refused one is NOT a failure, and says what it refused", () => {
    // The bug this pins. `ok` used to be `rejected.length === 0`, which marked
    // 69 of 93 stored remembers as failed — most of which had written to the map.
    const { ok, error } = rememberOutcome({
      ...base,
      added: { nodes: 9, edges: 0, retractions: 0 },
      rejected: [{ item: "acme.com", reason: "that quote is not on the page" }],
    })
    expect(ok).toBe(true)
    expect(error).toContain("rejected 1/10")
    expect(error).toContain("that quote is not on the page")
  })

  it("a call where everything was refused IS a failure", () => {
    const { ok, error } = rememberOutcome({
      ...base,
      rejected: [
        { item: "a.com", reason: "that quote is not on the page" },
        { item: "b.com", reason: "\"vendor\" is not a kind this map holds" },
      ],
    })
    expect(ok).toBe(false)
    expect(error).toContain("rejected 2/2")
  })

  it("names the reasons rather than counting them, and caps the list", () => {
    // "3 rejected" sends the next reader to the code, and the code cannot tell
    // them which three.
    const { error } = rememberOutcome({
      ...base,
      added: { nodes: 1, edges: 0, retractions: 0 },
      rejected: Array.from({ length: 5 }, (_, i) => ({ item: `h${i}.com`, reason: "no quote" })),
    })
    expect(error).toContain("h0.com: no quote")
    expect(error).toContain("+2 more")
    expect(error!.length).toBeLessThanOrEqual(600)
  })

  it("reports a downgrade even though the claim landed", () => {
    const { ok, error } = rememberOutcome({
      ...base,
      added: { nodes: 1, edges: 0, retractions: 0 },
      downgraded: [{ key: "rival.com", relation: "competitor", because: "no own page was read", hint: "fetch it" }],
    })
    expect(ok).toBe(true)
    expect(error).toContain("downgraded 1")
    expect(error).toContain("rival.com (competitor)")
  })

  it("a clean call carries no error at all", () => {
    const { ok, error } = rememberOutcome({ ...base, added: { nodes: 3, edges: 1, retractions: 0 } })
    expect(ok).toBe(true)
    expect(error).toBeUndefined()
  })
})
