import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { FetchPort, SearchPort } from "@open-kb/core"
import { runSwarm, serializeSwarmRun } from "../src/index.js"

/**
 * The whole pipe, offline: runSwarm end to end on scripted models and fake
 * ports — three missions, one kernel downgrade, one retraction — then the
 * serialized run JSON through the REAL web reader (packages/web/lib/
 * kb-from-run.ts, imported the way its own tests use it), asserting counts
 * and that no entity falls out of the render with an unknown KIND_GROUP.
 *
 * The web module is loaded dynamically by URL: the swarm's NodeNext tsconfig
 * cannot type-check the web app's bundler-resolved imports, but vitest runs
 * them fine — the render check is a runtime check on purpose.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Padded past core's THIN_TEXT floor so sniff() says found.
const rivalHtml =
  `<html><body><h1>Rival</h1><p>Rival sells a fraud scoring API to online merchants. ` +
  `The platform scores every checkout in real time, flags stolen cards before authorization, ` +
  `and hands risk teams a review queue so a small fraud team can cover a large storefront ` +
  `without writing rules by hand.</p></body></html>`

// A probe page: names the anchor as a word of its own and enumerates five
// vendors — exactly what answerKeyRecall grades the map against.
const probeHtml =
  `<html><body><h1>Five fraud scoring vendors compared</h1>` +
  `<p>Shortlisting alternatives to anchor.com for merchants: we scored each vendor on latency, ` +
  `pricing and review tooling, then ran the same hundred stolen-card checkouts through every ` +
  `platform to see what got flagged before authorization and what sailed straight through.</p>` +
  `<a href="https://rival.com">Rival</a> <a href="https://second.com">Second</a> ` +
  `<a href="https://third.com">Third</a> <a href="https://fourth.com">Fourth</a> ` +
  `<a href="https://fifth.com">Fifth</a></body></html>`

const HITS = [
  { url: "https://rival.com", title: "Rival", description: "Rival sells fraud scoring to online merchants" },
  { url: "https://second.com", title: "Second", description: "Second scores checkout fraud for merchants" },
  { url: "https://third.com", title: "Third", description: "Third reviews fraud vendors for buyers" },
]

const search: SearchPort = {
  async search(queries) {
    return queries.map((query) => ({ query, hits: HITS, ok: true, usd: 0.001, ms: 1 }))
  },
}

const fetchPort: FetchPort = {
  async get(url) {
    const body = url.includes("roundup.com") ? probeHtml : rivalHtml
    return { url, httpStatus: 200, body, ms: 1, usd: 0.002 }
  },
}

const SKILL = "# Doctrine\nProve what you claim with a quote from bytes this run fetched.\nRecord as you go."

const call = (id: string, toolName: string, input: unknown) => [
  { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
]
const text = (s: string) => [{ type: "text" as const, text: s }]
const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
}
const reply = <C,>(content: C, done: boolean) => ({
  content,
  finishReason: { unified: done ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
  usage,
  warnings: [],
})
const invTurnOf = (prompt: ReadonlyArray<{ role: string }>) => prompt.filter((m) => m.role === "tool").length
const systemOf = (prompt: ReadonlyArray<{ role: string; content?: unknown }>) =>
  String(prompt.find((m) => m.role === "system")?.content ?? "")

/** The seed: orient — read the anchor's market, record company + capability + buyer. */
const digModel = new MockLanguageModelV4({
  doGenerate: async ({ prompt }) => {
    const turn = invTurnOf(prompt)
    if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring for merchants"], why: "orient" }), false)
    if (turn === 1)
      return reply(
        call("f1", "fetch", {
          urls: ["https://rival.com", "https://roundup.com/best-fraud-tools"],
          mode: "direct",
          why: "the vendor's own words and the market's answer key",
        }),
        false,
      )
    if (turn === 2)
      return reply(
        call("r1", "remember", {
          nodes: [
            {
              name: "Rival",
              domain: "rival.com",
              kind: "company",
              what: "fraud scoring API for online merchants",
              relation: "competitor",
              why: "sells the anchor's own capability standalone, per its own page",
              evidence: [{ url: "https://rival.com", quote: "Rival sells a fraud scoring API" }],
            },
            {
              name: "Fraud scoring",
              domain: "",
              kind: "capability",
              what: "scoring checkout fraud before authorization",
              relation: "covers",
              why: "the capability this market is organised around",
              evidence: [{ url: "https://rival.com", quote: "sells fraud scoring to online merchants" }],
            },
            {
              name: "Risk teams",
              domain: "",
              kind: "buyer",
              relation: "buyer",
              what: "merchant risk teams reviewing flagged checkouts",
              why: "the buyer both vendors name",
              evidence: [{ url: "https://rival.com", quote: "risk teams a review queue" }],
            },
          ],
          why: "orientation, recorded as it is read",
        }),
        false,
      )
    return reply(text("oriented."), true)
  },
})

/** m1 downgrades; m2 retracts. One read-tier model, branching on the mission line. */
const readModel = new MockLanguageModelV4({
  doGenerate: async ({ prompt }) => {
    const turn = invTurnOf(prompt)
    const m2 = systemOf(prompt).includes("(m2)")
    if (turn === 0) {
      // Let the seed's writes land first so this mission's edge has both ends.
      await sleep(100)
      return reply(call("s1", "search", { queries: ["checkout fraud scoring"], why: "the shortlist" }), false)
    }
    if (!m2) {
      if (turn === 1)
        return reply(
          call("r1", "remember", {
            nodes: [
              {
                name: "Second",
                domain: "second.com",
                kind: "company",
                what: "checkout fraud scoring",
                relation: "competitor",
                why: "the snippet names the same capability and buyer",
                evidence: [{ url: "https://second.com", quote: "Second scores checkout fraud" }],
              },
            ],
            edges: [
              {
                from: "rival.com",
                to: "second.com",
                relation: "competitor",
                why: "both sell fraud scoring to merchants",
                confidence: "inferred",
              },
            ],
            why: "a rival's rival, from the engine's own words",
          }),
          false,
        )
      return reply(text("done."), true)
    }
    if (turn === 1)
      return reply(
        call("r1", "remember", {
          nodes: [
            {
              name: "Third",
              domain: "third.com",
              kind: "company",
              what: "fraud vendor reviews",
              relation: "covers",
              why: "reviews the market rather than selling into it",
              evidence: [{ url: "https://third.com", quote: "Third reviews fraud vendors" }],
            },
          ],
          why: "provisionally a player",
        }),
        false,
      )
    if (turn === 2)
      return reply(
        call("r2", "remember", {
          retract: [{ node: "third.com", why: "a listicle, not a vendor — it enumerates the others" }],
          why: "second look: it is a document about the market",
        }),
        false,
      )
    return reply(text("done."), true)
  },
})

const leadModel = new MockLanguageModelV4({
  doGenerate: async ({ prompt }) => {
    const turn = prompt.filter((m) => m.role === "user").length
    if (turn === 1)
      return reply(
        [
          ...call("sp", "spawn", {
            missions: [
              { lens: "rivals", brief: "who else sells this (m1)", why: "shortlist", priority: 90, tier: "read", dedupeKey: "m1" },
              { lens: "venues", brief: "who writes about this (m2)", why: "the venues", priority: 80, tier: "read", dedupeKey: "m2" },
            ],
            why: "the two halves of the picture",
          }),
          ...call("nx", "next", { after: { landings: 3 }, why: "come back when all three land" }),
        ],
        false,
      )
    return reply(
      call("fin", "finish", {
        reason: "the market is small and mapped",
        summary: "one rival proven from its own page, one unverified, the capability and buyer named",
        unresolved: ["second.com's own page was never read"],
        why: "done",
      }),
      false,
    )
  },
})

describe("serializeSwarmRun renders through the web reader", () => {
  it("3 missions, one downgrade, one retraction — sweep-shaped JSON, no unknown KIND_GROUP", async () => {
    const run = await runSwarm({
      domain: "anchor.com",
      skill: SKILL,
      search,
      fetch: fetchPort,
      models: { lead: leadModel, peek: digModel, read: readModel, dig: digModel },
      pricing: {
        lead: { inUsdPerM: 0, outUsdPerM: 0 },
        peek: { inUsdPerM: 0, outUsdPerM: 0 },
        read: { inUsdPerM: 0, outUsdPerM: 0 },
        dig: { inUsdPerM: 0, outUsdPerM: 0 },
      },
    })

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.landings).toHaveLength(3)

    const out = serializeSwarmRun(run)

    // The counts the shape promises: third.com retracted off the map, the
    // downgrade kept ON it wearing its refusal.
    expect(out.anchor).toBe("anchor.com")
    expect(out.entities).toHaveLength(4)
    const byName = new Map(out.entities.map((e) => [e.name, e]))
    expect(byName.get("Rival")?.kind).toBe("company")
    expect(byName.get("Rival")?.relation).toBe("competitor")
    expect(byName.get("Second")?.relation).toBe("unknown")
    expect(byName.get("Second")?.because).toMatch(/could not be read|nothing on its own site/i)
    expect(byName.has("Third")).toBe(false)
    // The recorded seam: capability and buyer fold to kinds the reader knows.
    expect(byName.get("Fraud scoring")?.kind).toBe("product")
    expect(byName.get("Risk teams")?.kind).toBe("community")
    expect(out.edges).toEqual([
      {
        from: "rival.com",
        to: "second.com",
        relation: "competitor",
        why: "both sell fraud scoring to merchants",
        confidence: "inferred",
      },
    ])

    // The kernel block reports what the write gate did.
    const report = out.report as {
      kernel: { downgraded: number; retractions: number; aggregatorThreshold: number | null }
      recall: { pooled: number | null; probes: Array<{ vendors: string[]; found: string[] }> }
      ending: { reason: string; residue: unknown[] }
    }
    expect(report.kernel.downgraded).toBe(1)
    expect(report.kernel.retractions).toBe(1)
    expect(report.kernel.aggregatorThreshold).toBeNull()
    // Recall against the probe page the run itself bought: five vendors
    // enumerated, two of them on the map.
    expect(report.recall.pooled).toBeCloseTo(2 / 5, 6)
    expect(report.recall.probes).toHaveLength(1)
    expect(report.ending.reason).toBe("lead-finished")

    // The JSON survives the disk round trip whole.
    const parsed = JSON.parse(JSON.stringify(out)) as typeof out
    expect(parsed.entities).toHaveLength(4)

    // ── through the real reader ──────────────────────────────────────────
    const webLib = new URL("../../web/lib/kb-from-run.ts", import.meta.url).href
    const kb = (await import(webLib)) as {
      graphOf: (r: unknown) => { nodes: Array<{ id: string }>; edges: Array<{ label: string }>; dangling: unknown[] }
      viewOf: (r: unknown) => { counts: Record<string, number> }
    }
    const stored = {
      id: "11111111-1111-4111-8111-111111111111",
      domain: "anchor.com",
      queries: out.stats.queries,
      startedAt: 0,
      endedAt: 1,
      status: "complete",
      result: parsed,
    }

    const g = kb.graphOf(stored)
    // No entity fell out of the render: an unknown KIND_GROUP becomes a
    // dangling link, and there are none.
    expect(g.dangling).toEqual([])
    expect(g.nodes).toHaveLength(5) // the anchor + all four entities
    expect(g.edges.some((e) => e.label === "competitor")).toBe(true)

    const v = kb.viewOf(stored)
    expect(v.counts).toEqual({ core: 1, player: 2, product: 1, community: 1 })
  }, 15_000)
})
