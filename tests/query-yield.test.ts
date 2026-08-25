import { describe, expect, it } from "vitest"
import { band, cell, hostOf, tallyQueryYield } from "../scripts/query-yield.js"

/**
 * `tallyQueryYield` (the join behind `scripts/query-yield.ts`) had no test
 * anywhere — the whole file ran at import time (`readdirSync`, `console.log`
 * inside the same loop that did the tallying), so nothing could import it at
 * all. Coverage gap found sweeping `scripts/*.ts beyond sweep.ts` (D-scope:
 * "areas nobody has swept"). Fixed the same way `promptStats` was pulled out
 * of `show-prompt.ts`: extract the arithmetic, gate the CLI body behind the
 * same `invokedDirectly` guard `scripts/run-doctor.ts` already uses.
 */
describe("hostOf", () => {
  it("lowercases and strips a leading www", () => {
    expect(hostOf("https://WWW.Example.com/path")).toBe("example.com")
  })

  it("returns an empty string for an unparseable url instead of throwing", () => {
    expect(hostOf("not a url")).toBe("")
  })
})

describe("band", () => {
  it("buckets a query's position into the saturation control's five bands", () => {
    expect(band(0)).toBe("  0-24")
    expect(band(24)).toBe("  0-24")
    expect(band(25)).toBe(" 25-49")
    expect(band(99)).toBe(" 50-99")
    expect(band(100)).toBe("100-199")
    expect(band(200)).toBe("   200+")
  })
})

describe("tallyQueryYield", () => {
  const run = (overrides: Partial<Parameters<typeof tallyQueryYield>[0][number]> = {}) => ({
    searched: [
      { family: "plain", platform: "web", intent: "evaluation", usd: 0.01, hits: [{ url: "https://rival.com/a" }, { url: "https://forum.com/b" }] },
      { family: "plain", platform: "web", intent: "evaluation", usd: 0.01, hits: [{ url: "https://rival.com/c" }] },
      { family: "debranded", platform: "reddit", intent: "pain", usd: 0.02, hits: [] },
    ],
    entities: [
      { domain: "rival.com", kind: "market", relation: "competitor" },
      { domain: "forum.com", kind: "market", relation: "discusses" },
    ],
    ...overrides,
  })

  it("counts a fresh host once, on the query that first surfaced it, and market/channel by its verdict", () => {
    const tally = tallyQueryYield([run()], "family")
    // rival.com is fresh on query 0, repeated (not fresh) on query 1 — the
    // second `hits` entry does not add a second market count.
    expect(tally.plain).toMatchObject({ q: 2, fresh: 2, market: 1, channel: 1 })
    expect(tally.plain?.usd).toBeCloseTo(0.02)
    // debranded's one query returned no hits at all — barren, not fresh.
    expect(tally.debranded).toMatchObject({ q: 1, fresh: 0, barren: 1 })
  })

  it("keys by platform or intent instead of family when asked", () => {
    const byPlatform = tallyQueryYield([run()], "platform")
    expect(Object.keys(byPlatform).sort()).toEqual(["reddit", "web"])
    const byIntent = tallyQueryYield([run()], "intent")
    expect(Object.keys(byIntent).sort()).toEqual(["evaluation", "pain"])
  })

  it("keys by position band and family together when `by` is position", () => {
    const tally = tallyQueryYield([run()], "position")
    expect(Object.keys(tally)).toEqual(["  0-24 · plain", "  0-24 · debranded"])
  })

  it("a host with no matching entity (neither market nor channel) counts as other, not a crash", () => {
    const tally = tallyQueryYield(
      [run({ searched: [{ family: "plain", usd: 0, hits: [{ url: "https://untracked.com/a" }] }], entities: [] })],
      "family",
    )
    expect(tally.plain).toMatchObject({ market: 0, channel: 0, other: 1 })
  })

  it("a host classified as noise counts as other, not market or channel", () => {
    const tally = tallyQueryYield(
      [run({
        searched: [{ family: "plain", usd: 0, hits: [{ url: "https://rival.com/a" }] }],
        entities: [{ domain: "rival.com", kind: "noise", relation: "competitor" }],
      })],
      "family",
    )
    expect(tally.plain).toMatchObject({ other: 1, market: 0 })
  })

  it("skips a run whose shape does not carry both searched and entities arrays, rather than throwing", () => {
    const tally = tallyQueryYield([{} as any, run()], "family")
    expect(tally.plain?.q).toBe(2)
  })

  it("pools multiple runs into the same key, tracking freshness per run", () => {
    const tally = tallyQueryYield([run(), run()], "family")
    // Each run has its own `seen` set, so rival.com is fresh again in the
    // second run's first query — freshness does not leak across runs.
    expect(tally.plain).toMatchObject({ fresh: 4, market: 2 })
  })
})

describe("cell", () => {
  it("starts every counter at zero", () => {
    expect(cell()).toEqual({ q: 0, usd: 0, fresh: 0, market: 0, channel: 0, other: 0, barren: 0 })
  })
})
