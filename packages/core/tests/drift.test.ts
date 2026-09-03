import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { diffMaps, driftSentences, entityKey, type DriftEntityRow, type DriftMap } from "../src/drift.js"

const company = (domain: string, over: Record<string, string> = {}): DriftEntityRow => ({
  name: domain,
  domain,
  kind: "company",
  relation: "competitor",
  ...over,
})

const map = (entities: DriftMap["entities"], edges?: DriftMap["edges"]): DriftMap => ({ entities, edges })

describe("entityKey", () => {
  it("keys a company by its registrable host, never its display name", () => {
    expect(entityKey(company("oxylabs.io", { name: "Oxylabs" }))).toBe("oxylabs.io")
    expect(entityKey(company("docs.apify.com", { name: "Apify Docs" }))).toBe("apify.com")
    expect(entityKey(company("www.zyte.com"))).toBe("zyte.com")
  })

  it("keys a domainless row by kind:name, case-folded", () => {
    expect(entityKey({ name: "Web Scraping", domain: "", kind: "community" })).toBe("community:web scraping")
    expect(entityKey({ name: "Web Scraping", kind: "community" })).toBe("community:web scraping")
  })
})

describe("diffMaps", () => {
  it("splits two maps into entered, left and unchanged", () => {
    const d = diffMaps(map([company("gone.com"), company("stays.com")]), map([company("stays.com"), company("new.com")]))
    expect(d.left).toEqual(["gone.com"])
    expect(d.entered).toEqual(["new.com"])
    expect(d.changed).toEqual([])
    expect(d.unchangedCount).toBe(1)
  })

  it("records a relation change with both readings", () => {
    const d = diffMaps(
      map([company("a.com", { relation: "competitor" })]),
      map([company("a.com", { relation: "substitute" })]),
    )
    expect(d.changed).toEqual([{ key: "a.com", field: "relation", from: "competitor", to: "substitute" }])
    expect(d.unchangedCount).toBe(0)
  })

  it("records tier and kind changes the same way", () => {
    const d = diffMaps(
      map([company("a.com", { tier: "page" }), company("b.com", { kind: "company" })]),
      map([company("a.com", { tier: "own-page" }), company("b.com", { kind: "product" })]),
    )
    expect(d.changed).toEqual([
      { key: "a.com", field: "tier", from: "page", to: "own-page" },
      { key: "b.com", field: "kind", from: "company", to: "product" },
    ])
  })

  it("never counts an absent field as a change — a kernel row has no tier to move", () => {
    const withTier = company("a.com", { tier: "own-page" })
    const { tier: _dropped, ...kernelRow } = withTier
    expect(diffMaps(map([withTier]), map([kernelRow])).changed).toEqual([])
    expect(diffMaps(map([kernelRow]), map([withTier])).changed).toEqual([])
    expect(diffMaps(map([withTier]), map([kernelRow])).unchangedCount).toBe(1)
  })

  it("ignores fields it does not watch — a reworded why is not drift", () => {
    const d = diffMaps(
      map([{ ...company("a.com"), why: "one wording", because: "refused" } as never]),
      map([{ ...company("a.com"), why: "another wording" } as never]),
    )
    expect(d.changed).toEqual([])
    expect(d.unchangedCount).toBe(1)
  })

  it("folds subdomain spellings onto one key and lets the first row speak for it", () => {
    const d = diffMaps(
      map([company("apify.com", { relation: "competitor" }), company("docs.apify.com", { relation: "discusses" })]),
      map([company("apify.com", { relation: "substitute" })]),
    )
    expect(d.changed).toEqual([{ key: "apify.com", field: "relation", from: "competitor", to: "substitute" }])
    expect(d.left).toEqual([])
  })

  it("diffs edges by host and relation, tolerating a map that has none", () => {
    const a = map([company("a.com")], [{ from: "www.a.com", to: "b.com", relation: "competitor" }])
    const b = map(
      [company("a.com")],
      [
        { from: "a.com", to: "b.com", relation: "competitor" },
        { from: "a.com", to: "c.com", relation: "covers" },
      ],
    )
    const d = diffMaps(a, b)
    expect(d.edgesLeft).toEqual([])
    expect(d.edgesEntered).toEqual(["a.com -covers-> c.com"])
    expect(diffMaps(map([company("a.com")]), a).edgesEntered).toEqual(["a.com -competitor-> b.com"])
  })
})

describe("driftSentences", () => {
  it("counts the coming and going, plural and singular alike", () => {
    const lines = driftSentences(diffMaps(map([company("gone.com")]), map([company("new.com")])))
    expect(lines).toContain("1 entity left the map; 1 entered")
    const eight = Array.from({ length: 8 }, (_, i) => company(`gone${i}.com`))
    const eleven = Array.from({ length: 11 }, (_, i) => company(`new${i}.com`))
    expect(driftSentences(diffMaps(map(eight), map(eleven)))).toContain("8 entities left the map; 11 entered")
  })

  it("says when nothing moved", () => {
    const lines = driftSentences(diffMaps(map([company("a.com")]), map([company("a.com")])))
    expect(lines).toContain("no entities entered or left the map")
    expect(lines).toContain("1 entity stayed unchanged")
    expect(lines).toContain("no edges entered or left the map")
  })

  it("reads a relation move with the tier move riding it, direction stated from the ladder", () => {
    const d = diffMaps(
      map([company("oxylabs.io", { relation: "competitor", tier: "page" })]),
      map([company("oxylabs.io", { relation: "substitute", tier: "own-page" })]),
    )
    expect(driftSentences(d)).toContain(
      "oxylabs.io stayed; its relation moved competitor -> substitute at a stronger tier: page -> own-page",
    )
  })

  it("reads a relation-only move with no tier clause, when neither run carries a tier", () => {
    // changedSentence's `else if (relation)` branch (drift.ts) never ran: the only prior
    // relation-move test through driftSentences paired it with a tier move, which always
    // takes the `if (relation && tier)` branch above it instead.
    const d = diffMaps(
      map([company("a.com", { relation: "competitor" })]),
      map([company("a.com", { relation: "substitute" })]),
    )
    expect(driftSentences(d)).toContain("a.com stayed; its relation moved competitor -> substitute")
  })

  it("reads a tier-only move with its direction, and a weakening as weaker", () => {
    const stronger = diffMaps(map([company("a.com", { tier: "page" })]), map([company("a.com", { tier: "own-page" })]))
    expect(driftSentences(stronger)).toContain("a.com stayed; its tier moved to a stronger rung: page -> own-page")
    const weaker = diffMaps(map([company("a.com", { tier: "own-page" })]), map([company("a.com", { tier: "snippet" })]))
    expect(driftSentences(weaker)).toContain("a.com stayed; its tier moved to a weaker rung: own-page -> snippet")
  })

  it("reads a tier move with no direction word when the tier isn't on the ladder", () => {
    // tierDirection (drift.ts:141-146) returns null whenever either side is missing from
    // TIER_RANK, and its `else if (tier)` call site (drift.ts:165-171) branches on that null —
    // but every tier-only test above moves between "page", "own-page" and "snippet", all three
    // ranked, so the no-direction arm (drift.ts:169) had never run. DriftEntityRow#tier is an
    // unconstrained string, unlike ScorecardNode's three-value union (scorecard.ts:49), so a
    // run carrying a tier label this ladder doesn't know is a real shape, not a hypothetical one.
    const d = diffMaps(map([company("a.com", { tier: "page" })]), map([company("a.com", { tier: "unranked" })]))
    expect(driftSentences(d)).toContain("a.com stayed; its tier moved page -> unranked")
  })

  it("reads a relation move at 'a different' tier when the tier isn't on the ladder", () => {
    // Same gap as above, for the other tierDirection call site: `if (relation && tier)`
    // (drift.ts:159-162) also ternaries on direction === null, and every relation+tier test
    // above moved between ranked tiers, so the "a different" wearing (drift.ts:161) had never
    // run either.
    const d = diffMaps(
      map([company("a.com", { relation: "competitor", tier: "own-page" })]),
      map([company("a.com", { relation: "substitute", tier: "unranked" })]),
    )
    expect(driftSentences(d)).toContain(
      "a.com stayed; its relation moved competitor -> substitute at a different tier: own-page -> unranked",
    )
  })

  it("reads a kind move plainly", () => {
    const d = diffMaps(map([company("a.com", { kind: "company" })]), map([company("a.com", { kind: "product" })]))
    expect(driftSentences(d)).toContain("a.com stayed; its kind moved company -> product")
  })

  it("counts edge drift", () => {
    const d = diffMaps(
      map([company("a.com")], [{ from: "a.com", to: "b.com", relation: "competitor" }]),
      map([company("a.com")], [{ from: "a.com", to: "c.com", relation: "covers" }]),
    )
    expect(driftSentences(d)).toContain("1 edge left the map; 1 entered")
  })

  it("pluralizes edge counts past one", () => {
    // driftSentences' edge line (drift.ts:205) ternaries on edgesLeft.length === 1 for
    // "edge" vs "edges", the same way the entity line does — but the only prior edge test
    // moved exactly one edge each way, so the plural arm had never run.
    const d = diffMaps(
      map(
        [company("a.com")],
        [
          { from: "a.com", to: "b.com", relation: "competitor" },
          { from: "a.com", to: "c.com", relation: "covers" },
        ],
      ),
      map([company("a.com")], [{ from: "a.com", to: "d.com", relation: "substitute" }]),
    )
    expect(driftSentences(d)).toContain("2 edges left the map; 1 entered")
  })
})

/**
 * The demonstration corpus: two of the night's real swarm runs of the same
 * anchor, run 2 and run 3 an hour and a half apart. `runs/` is gitignored and
 * CI will not have them, so the suite skips honestly when they are absent
 * instead of green-lighting a diff it never computed.
 */
const runsDir = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "runs", "swarm-brightdata-com-202608052348.json"))) return join(dir, "runs")
    dir = dirname(dir)
  }
  return null
})()

describe.skipIf(runsDir === null)("two real swarm runs of one anchor", () => {
  it("accounts for every key once and speaks in full sentences", () => {
    const read = (f: string) => JSON.parse(readFileSync(join(runsDir!, f), "utf8")) as DriftMap
    const a = read("swarm-brightdata-com-202608052348.json")
    const b = read("swarm-brightdata-com-202608060151.json")
    const d = diffMaps(a, b)

    const keysA = new Set(a.entities.map(entityKey))
    const keysB = new Set(b.entities.map(entityKey))
    expect(d.left.length).toBeGreaterThan(0)
    expect(d.entered.length).toBeGreaterThan(0)
    expect(d.left.every((k) => keysA.has(k) && !keysB.has(k))).toBe(true)
    expect(d.entered.every((k) => keysB.has(k) && !keysA.has(k))).toBe(true)
    const changedKeys = new Set(d.changed.map((c) => c.key))
    const shared = [...keysA].filter((k) => keysB.has(k))
    expect(d.unchangedCount + changedKeys.size).toBe(shared.length)
    expect(d.left.length + shared.length).toBe(keysA.size)
    expect(d.entered.length + shared.length).toBe(keysB.size)

    const lines = driftSentences(d)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect(line).toMatch(/\S/)
    expect(lines.join("\n")).toMatch(/\d+ entit(y|ies) left the map; \d+ entered/)
  })
})
