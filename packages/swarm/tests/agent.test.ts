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
  spawnTool,
  estimateTokens,
  LEAD_TURN_CAP,
  TIER_DEADLINE_MS,
  DIGEST_TOKEN_CAP,
  type LeadDeps,
  type InvestigatorDeps,
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
      return queries.map((query) => ({ query, hits: rows[query] ?? [], ok: true, usd: 0.001, ms: 2 }))
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
    const ctl = { board: h.board, ledger: h.ledger, control: h.control }
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
    expect(digest.added).toEqual({ nodes: 1, edges: 0 })
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

    expect(digest.added).toEqual({ nodes: 2, edges: 0 }) // the map's count, not the model's story
    expect(digest.findings.length).toBeLessThanOrEqual(3)
    expect(estimateTokens(JSON.stringify(digest))).toBeLessThanOrEqual(DIGEST_TOKEN_CAP)
    // Truncation really happened: the raw what alone is far past the whole budget.
    expect(longWhat.length).toBeGreaterThan(DIGEST_TOKEN_CAP * 4)
  })

  it("ships tier deadlines measured on the 2026-08-05 live runs, not the design's 45/90/150s", () => {
    expect(TIER_DEADLINE_MS).toEqual({ peek: 60_000, read: 180_000, dig: 300_000 })
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
