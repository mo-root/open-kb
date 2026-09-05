import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import type { LanguageModel } from "ai"
import type { FetchPort, Ledger, SearchPort } from "@open-kb/core"
import {
  DEFAULT_FAMILY_FLOOR,
  FAMILY_FLOOR_MAX,
  familyProfileFrom,
  MapState,
  runSwarm,
  seedFamilyMissions,
  type MapNode,
  type SwarmOptions,
} from "../src/index.js"

/**
 * The family floor: "families survive as a code floor". The profile is read
 * mechanically off what the orient landing left, the missions are templates
 * over it, and the orchestrator funds them through the normal spawn economics
 * the moment the seed lands — so a lead that never spawns (run 3's measured
 * failure: board dry, 12 nodes, 3 of 6 lanes ever used) still gets the
 * market's boring questions asked.
 */

// ── unit fixtures ────────────────────────────────────────────────────────────

const node = (
  key: string,
  kind: string,
  over: Partial<MapNode> & { writer?: string } = {},
): MapNode => {
  const { writer, ...rest } = over
  return {
    key,
    name: key,
    domain: kind === "company" || kind === "product" ? key : "",
    kind,
    what: "fraud scoring",
    relation: "competitor",
    why: "same job, same buyer",
    tier: "snippet",
    evidence: [],
    also: [],
    contributions: [{ writer: writer ?? "orient:anchor.com", tier: "snippet" }],
    ...rest,
  }
}

const SEED = "orient:anchor.com"
const OPTS = { writers: [SEED, "lead"], coinages: ["anchor.com", "anchor"] }

/** The brightdata-shaped fixture: what a good orient landing leaves. The
 *  anchor company itself is refused by the mint, so orientation's reliable
 *  residue is a capability in the market's own words plus a rival or two —
 *  runs/swarm-brightdata-com-202608060151.json's orient landed exactly the
 *  rival-company shape; the capability here is the fuller variant. */
const brightdataMap = (): MapState => {
  const map = new MapState("brightdata.com")
  map.nodes.set("capability:web-data-collection-infrastructure", {
    ...node("capability:web-data-collection-infrastructure", "capability", { writer: "orient:brightdata.com" }),
    name: "web data collection infrastructure",
    what: "proxies, unlockers and scraper APIs for collecting public web data at scale",
  })
  map.nodes.set("oxylabs.io", {
    ...node("oxylabs.io", "company", { writer: "orient:brightdata.com" }),
    name: "Oxylabs",
    // The live run's verbatim `what` — long, and it NAMES the anchor.
    what:
      "Major enterprise web scraping and proxy provider competing directly with Bright Data across " +
      "residential/ISP proxies, Web Unblockers, and Headless Browser APIs.",
  })
  return map
}

const BD_OPTS = { writers: ["orient:brightdata.com", "lead"], coinages: ["brightdata.com", "brightdata"] }

// ── the profile ladder ───────────────────────────────────────────────────────

describe("familyProfileFrom: the mechanical profile", () => {
  it("a capability node wins the ladder — the de-branded job in the market's own words", () => {
    const map = brightdataMap()
    expect(familyProfileFrom(map, BD_OPTS)).toEqual({
      category: "web data collection infrastructure",
      source: "capability",
    })
  })

  it("without a capability, a company's what serves — cut at a word boundary, coarse by design", () => {
    const map = brightdataMap()
    map.nodes.delete("capability:web-data-collection-infrastructure")
    const p = familyProfileFrom(map, BD_OPTS)
    // The 60-char cut lands mid-description; blunt, lowercased, searchable —
    // and the truncation itself is what drops the clause naming the anchor.
    expect(p).toEqual({
      category: "major enterprise web scraping and proxy provider competing",
      source: "company",
    })
    expect(p!.category.length).toBeLessThanOrEqual(60)
  })

  it("a candidate with no space in its first 60 chars cuts hard, not at a word boundary that isn't there", () => {
    // lastIndexOf(" ", 60) returns -1 here (no space that early), so the
    // `cut > 20` branch never fires — cleanCategory falls to the hard
    // CATEGORY_MAX slice, unlike the word-boundary cut the case above covers.
    const map = new MapState("anchor.com")
    map.nodes.set(
      "rival.com",
      node("rival.com", "company", {
        what: "supercalifragilisticexpialidociousenterpriseinfrastructureautomation for regulated industries",
      }),
    )
    const p = familyProfileFrom(map, OPTS)
    expect(p).toEqual({
      category: "supercalifragilisticexpialidociousenterpriseinfrastructureau",
      source: "company",
    })
    expect(p!.category.length).toBe(60)
  })

  it("a product's what outranks a company's what", () => {
    const map = new MapState("anchor.com")
    map.nodes.set("tool.anchor-adjacent.com", {
      ...node("tool.anchor-adjacent.com", "product"),
      what: "checkout fraud scoring API",
    })
    map.nodes.set("rival.com", node("rival.com", "company", { what: "fraud tooling" }))
    expect(familyProfileFrom(map, OPTS)).toEqual({
      category: "checkout fraud scoring api",
      source: "product",
    })
  })

  it("a candidate naming the anchor is dropped, and the ladder falls through", () => {
    const map = new MapState("anchor.com")
    map.nodes.set("rival.com", node("rival.com", "company", { what: "the anchor alternative for merchants" }))
    map.nodes.set("other.com", node("other.com", "company", { what: "fraud scoring" }))
    expect(familyProfileFrom(map, OPTS)).toEqual({ category: "fraud scoring", source: "company" })
  })

  it("nodes written by other lanes do not count — the floor reads the orient answer, not a race", () => {
    const map = new MapState("anchor.com")
    map.nodes.set("rival.com", node("rival.com", "company", { writer: "m-someone-else" }))
    expect(familyProfileFrom(map, OPTS)).toBeNull()
  })

  it("a retracted node does not count, and an empty map yields null", () => {
    const map = new MapState("anchor.com")
    expect(familyProfileFrom(map, OPTS)).toBeNull()
    map.nodes.set("rival.com", node("rival.com", "company", { retracted: { why: "a template rebrand" } }))
    expect(familyProfileFrom(map, OPTS)).toBeNull()
  })

  it("a buyer node rides along when orientation recorded one", () => {
    const map = new MapState("anchor.com")
    map.nodes.set("rival.com", node("rival.com", "company"))
    map.nodes.set("buyer:fraud-and-risk-teams", {
      ...node("buyer:fraud-and-risk-teams", "buyer"),
      name: "fraud and risk teams",
    })
    expect(familyProfileFrom(map, OPTS)).toEqual({
      category: "fraud scoring",
      source: "company",
      buyer: "fraud and risk teams",
    })
  })
})

// ── the templates ────────────────────────────────────────────────────────────

describe("seedFamilyMissions: the template deck", () => {
  const profile = { category: "web data collection infrastructure", source: "capability" as const }

  it("deals four read-tier missions in the 61-70 band by default, priorities descending", () => {
    const ms = seedFamilyMissions(profile)
    expect(ms).toHaveLength(DEFAULT_FAMILY_FLOOR)
    expect(ms.map((m) => m.dedupeKey)).toEqual([
      "family:market",
      "family:competitors",
      "family:substitutes",
      "family:buyers",
    ])
    expect(ms.every((m) => m.tier === "read")).toBe(true)
    expect(ms.every((m) => m.priority >= 61 && m.priority <= 70)).toBe(true)
    for (let i = 1; i < ms.length; i++) expect(ms[i]!.priority).toBeLessThan(ms[i - 1]!.priority)
  })

  it("briefs carry core families.ts's own query shapes over the category", () => {
    const [market, competitors, substitutes] = seedFamilyMissions(profile)
    expect(market!.brief).toContain('"web data collection infrastructure"')
    expect(market!.brief).toContain('"best web data collection infrastructure"')
    expect(market!.brief).toContain('"top web data collection infrastructure companies"')
    expect(competitors!.brief).toContain('"web data collection infrastructure alternatives"')
    expect(competitors!.brief).toContain('"web data collection infrastructure vs"')
    expect(substitutes!.brief).toContain('"open source web data collection infrastructure"')
  })

  it("dedupe keys are stable across categories — the slug names the question, not the text", () => {
    const other = seedFamilyMissions({ category: "checkout fraud scoring", source: "company" })
    expect(other.map((m) => m.dedupeKey)).toEqual(seedFamilyMissions(profile).map((m) => m.dedupeKey))
  })

  it("count clamps to the deck: 0 deals nothing, 9 deals all five", () => {
    expect(seedFamilyMissions(profile, { count: 0 })).toHaveLength(0)
    const five = seedFamilyMissions(profile, { count: 9 })
    expect(five).toHaveLength(FAMILY_FLOOR_MAX)
    expect(five[4]!.dedupeKey).toBe("family:stack")
  })

  it("the buyer's name reaches the demand-side brief when the profile carries one", () => {
    const ms = seedFamilyMissions({ ...profile, buyer: "fraud and risk teams" })
    expect(ms[3]!.brief).toContain('orientation named "fraud and risk teams"')
  })

  // `bare`'s lookup (seed-families.ts:141) is `x.q === c` — the ONLY one of the
  // six q() calls that tests strict equality against the raw profile.category
  // rather than a shape (endsWith/startsWith) core's templates always satisfy.
  // familyProfileFrom's cleanCategory always trims before a profile is built,
  // so bare's fallback (`?? fallback`, fallback === c) never fires through that
  // path — but seedFamilyMissions is exported and takes the interface as-is,
  // with no re-trim of its own, so a category carrying its own whitespace (any
  // direct caller that skips familyProfileFrom) exercises the fallback the
  // production path never reaches: openingHand trims internally to build t0,
  // so x.q ("widgets") no longer equals the untrimmed c (" widgets "), and only
  // the bare template — the other five match by shape, not equality — falls
  // back to c verbatim, whitespace and all.
  it("bare's equality check misses on an untrimmed category; its fallback alone carries the whitespace through", () => {
    const [market, competitors] = seedFamilyMissions({ category: " widgets ", source: "product" })
    expect(market!.brief).toContain('" widgets "')
    expect(market!.brief).toContain('"best widgets"')
    expect(market!.brief).toContain('"top widgets companies"')
    expect(competitors!.brief).toContain('"widgets alternatives"')
    expect(competitors!.brief).toContain('"widgets vs"')
  })
})

// ── the orchestrator wiring, offline ─────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rivalHtml =
  `<html><body><h1>Rival</h1><p>Rival sells a fraud scoring API to online merchants. ` +
  `The platform scores every checkout in real time, flags stolen cards before authorization, ` +
  `and hands risk teams a review queue so a small fraud team can cover a large storefront ` +
  `without writing rules by hand.</p></body></html>`

const HIT = { url: "https://rival.com", title: "Rival", description: "Rival sells fraud scoring to online merchants" }

function fakeSearch(): SearchPort {
  return {
    async search(queries) {
      return [...new Set(queries)].map((query) => ({ query, hits: [HIT], ok: true, usd: 0.001, ms: 1 }))
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

/** The orient seed the floor reads: one search, one company recorded off the
 *  snippet (the de-branded `what` the templates hang on), then done. The
 *  final sleep keeps the seed in flight past the lead's first turn so the
 *  floor's funding never races the turn's own peek-sized hold. */
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

/** A family-mission investigator: one turn, no tools — lands with zero nodes. */
const quietFamilyModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => reply(text("the floor's question noted."), true),
  })

const zero = { inUsdPerM: 0, outUsdPerM: 0 }

function mkOpts(o: {
  lead: LanguageModel
  seed: LanguageModel
  read?: LanguageModel
  logs?: string[]
  over?: Partial<SwarmOptions>
}): SwarmOptions {
  const read = o.read ?? quietFamilyModel()
  return {
    domain: "anchor.com",
    skill: SKILL,
    search: fakeSearch(),
    fetch: fakeFetch(),
    models: { lead: o.lead, peek: read, read, dig: o.seed },
    pricing: { lead: zero, peek: zero, read: zero, dig: zero },
    ...(o.logs ? { onLog: (l: string) => o.logs!.push(l) } : {}),
    ...(o.over ?? {}),
  }
}

const balanced = (ledger: Ledger) =>
  Math.abs(ledger.spendable() + ledger.spentUsd() + ledger.finishReserveUsd - ledger.ceilingUsd) < 1e-9

const FLOOR_KEYS = ["family:market", "family:competitors", "family:substitutes", "family:buyers"]

describe("runSwarm: the family floor", () => {
  it("run-1 shape: the lead never spawns, yet the floor fills lanes beyond the seed — funded in order, ledger rows opened", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 5 }, why: "wait for the floor" }), false)
        // Turn 2's finish meets the gate's one refusal; turn 3 restates.
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), logs }))

    expect(run.ending.reason).toBe("lead-finished")
    // Lanes filled beyond the seed with zero lead spawns: the floor's four ran.
    const landedKeys = run.landings.map((l) => l.mission.dedupeKey)
    expect(landedKeys).toContain("orient:anchor.com")
    for (const k of FLOOR_KEYS) expect(landedKeys).toContain(k)
    expect(run.landings).toHaveLength(5)
    // Funded in priority order, each narrated with its template source.
    const funded = logs
      .map((l) => /family floor: p\d+ (family:\S+) funded/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined)
    expect(funded).toEqual(FLOOR_KEYS)
    expect(logs.some((l) => l.includes('templated from "fraud scoring" (company)'))).toBe(true)
    // The ledger's literal meaning arrives: one family row per floor mission.
    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com", ...FLOOR_KEYS])
    expect(run.families.every((f) => f.status === "landed")).toBe(true)
    // The scorecard's denominator is real: seed + code families.
    expect(run.scorecard.familiesWithPageTier.den).toBe(5)
    expect(balanced(run.ledger)).toBe(true)
  })

  it("a pool too small funds the floor partially, in priority order, wearing spawn's refusal sentence", async () => {
    const logs: string[] = []
    const turns: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        turns[turn] = JSON.stringify(prompt.filter((m) => m.role === "user").at(-1)?.content ?? "")
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 4 }, why: "seed plus three" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    // Ceiling $0.45: reserve $0.12, pool $0.33. The seed dig holds $0.25 and
    // settles at ~$0.001, leaving ~$0.329 — three reads fund, the fourth is
    // refused with the same sentence spawn gives the lead.
    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), logs, over: { ceilingUsd: 0.45 } }))

    expect(run.ending.reason).toBe("lead-finished")
    const funded = logs
      .map((l) => /family floor: p\d+ (family:\S+) funded/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined)
    expect(funded).toEqual(["family:market", "family:competitors", "family:substitutes"])
    expect(
      logs.some((l) => l.includes("family floor: family:buyers not funded — the pool no longer funds a read; re-tier it or drop it")),
    ).toBe(true)
    // A refused floor mission opens no ledger row and ships no residue: it was never a board item.
    expect(run.families.map((f) => f.dedupeKey)).toEqual([
      "orient:anchor.com",
      "family:market",
      "family:competitors",
      "family:substitutes",
    ])
    expect(run.ending.residue.map((r) => r.dedupeKey)).not.toContain("family:buyers")
    // The lead heard the narration in-band on its next turn.
    expect(turns[2]).toContain("the family floor opened 3 code-seeded questions")
    expect(turns[2]).toContain("the family floor could not fund family:buyers")
    expect(balanced(run.ledger)).toBe(true)
  })

  it("the lead can kill a floor row through review — the family survives wearing the because, money refunded", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        if (turn === 2)
          return reply(
            [
              ...call("k1", "review", {
                kill: [{ dedupeKey: "family:buyers", because: "the community lens I plan asks this better" }],
                why: "the floor is coarse; I refine",
              }),
              ...call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }),
            ],
            false,
          )
        return reply(call("f2", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    // One lane: the floor's rows sit queued while the seed's lane frees, so
    // the kill deterministically meets a queued (not claimed) board item.
    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), over: { lanes: 1 } }))

    expect(run.ending.reason).toBe("lead-finished")
    const buyers = run.families.find((f) => f.dedupeKey === "family:buyers")
    expect(buyers).toMatchObject({ status: "killed", because: "the community lens I plan asks this better" })
    // The killed row stays in the denominator; the board forgot the item.
    expect(run.families).toHaveLength(5)
    expect(run.ending.residue.map((r) => r.dedupeKey)).not.toContain("family:buyers")
    expect(balanced(run.ledger)).toBe(true)
  })

  it("familyFloor: false keeps the old shape — one family row, no floor narration", async () => {
    const logs: string[] = []
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), logs, over: { familyFloor: false } }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com"])
    expect(logs.some((l) => l.includes("family floor"))).toBe(false)
  })

  it("familyFloor: 2 sizes the floor — exactly the top two questions", async () => {
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 3 }, why: "seed plus two" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, seed: orientingSeed(), over: { familyFloor: 2 } }))

    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com", "family:market", "family:competitors"])
    expect(run.scorecard.familiesWithPageTier.den).toBe(3)
  })

  it("an orient landing that left no text is narrated, not templated — the floor refuses to ask garbage", async () => {
    const logs: string[] = []
    // A seed that only searches: nothing on the map, so no profile.
    const searchOnlySeed = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = invTurnOf(prompt)
        if (turn === 0) return reply(call("s1", "search", { queries: ["fraud scoring"], why: "orient" }), false)
        return reply(text("nothing recorded."), true)
      },
    })
    const lead = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = leadTurnOf(prompt)
        if (turn === 1) return reply(call("n1", "next", { after: { landings: 1 }, why: "wait for the seed" }), false)
        return reply(call("f1", "finish", { reason: "done", summary: "s", unresolved: [], why: "d" }), false)
      },
    })

    const run = await runSwarm(mkOpts({ lead, seed: searchOnlySeed, logs }))

    expect(run.ending.reason).toBe("lead-finished")
    expect(run.families.map((f) => f.dedupeKey)).toEqual(["orient:anchor.com"])
    expect(
      logs.some((l) =>
        l.includes("family floor: the orient landing left no de-branded text on the map; there is nothing to template from"),
      ),
    ).toBe(true)
  })
})
