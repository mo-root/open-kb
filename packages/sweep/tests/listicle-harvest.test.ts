import { describe, it, expect } from "vitest"
import { runFixture, SERP } from "./fixture.js"
import { ROUNDUP_SHAPE } from "../src/sweep.js"
import type { SearchHit } from "@open-kb/core"

/**
 * Listicle harvest: a roundup-shaped row's own title/description can name a
 * vendor this run never fired a query for. Its whole contract is the same
 * shape as triage/second-look — defaults ON (its A/B survived, see
 * `SweepOptions.listicleHarvest`), additive only, and every failure fails
 * open — and each sentence gets its suite below.
 */

const ROUNDUP: SearchHit = {
  url: "https://roundup.example/",
  title: "Best log search alternatives",
  description: "Grepstack, Tailwatch and Runlog all made this best-of list.",
}

/** The default SERP, with one extra roundup-shaped row folded onto a query
 *  the default catalog already fires — so the harvest has something to read
 *  without inventing a query nothing else asks. */
const serpWithRoundup = (): Record<string, SearchHit[]> => ({
  ...SERP,
  "log search alternatives": [...SERP["log search alternatives"]!, ROUNDUP],
  "Runlog alternatives": [
    { url: `https://runlog.example/`, title: "Runlog", description: "A log search vendor this run never asked about." },
  ],
})

describe("listicle harvest", () => {
  it("does not exist when explicitly disabled", async () => {
    const h = await runFixture({ serp: serpWithRoundup(), sweepOptions: { listicleHarvest: false } })
    expect(h.calls.filter((c) => c.phase === "listicle")).toEqual([])
    expect((h.result.report as { listicleHarvest?: unknown }).listicleHarvest).toBeNull()
    expect(h.result.entities.some((e) => e.domain === "runlog.example")).toBe(false)
  })

  it("runs by default, with no flag needed", async () => {
    const h = await runFixture({
      serp: serpWithRoundup(),
      script: {
        listicle: () => ({ vendors: ["Grepstack", "Tailwatch", "Runlog"] }),
      },
    })
    expect(h.calls.filter((c) => c.phase === "listicle").length).toBe(1)
    expect(h.asked).toContain("Runlog alternatives")
    expect(h.result.entities.some((e) => e.domain === "runlog.example")).toBe(true)
  })

  /**
   * THE STAGE'S ONLY OUTPUT IS QUERIES, so with the ceiling spent it reads
   * roundup rows to produce names it must immediately discard — and it is a
   * clock-bound run, the one that can least afford a model call, that pays.
   *
   * MEASURED on the only deadline-bound run on disk: 60 rows scanned, 16
   * unsurfaced vendors named, 0 queries fired, all 16 thrown away, at 114
   * seconds of a 270-second clock. Of the 27 runs that harvested vendors it
   * is the one that fired nothing, and the one with a ceiling.
   */
  it("declines to read roundup rows when the query ceiling is already spent", async () => {
    const h = await runFixture({
      // Small enough that the opening hand spends it before the harvest.
      sweepOptions: { maxQueries: 3 },
      serp: serpWithRoundup(),
      script: { listicle: () => ({ vendors: ["Grepstack", "Tailwatch", "Runlog"] }) },
    })

    // THE CALL IS NOT MADE. This is the whole saving — a flag that said
    // "starved" while still paying for the answer would be worth nothing.
    expect(h.calls.filter((c) => c.phase === "listicle")).toEqual([])

    // And the report says WHY it read nothing, so `rowsScanned: 0` cannot be
    // read as "this run's hits held no roundup rows" — they did.
    const stats = (h.result.report as {
      listicleHarvest: { starved: boolean; rowsScanned: number; queriesFired: number }
    }).listicleHarvest
    expect(stats.starved).toBe(true)
    expect(stats.queriesFired).toBe(0)

    // The run really was at its ceiling, so this is the case it claims to be.
    expect(h.asked.length).toBe(3)
    expect(h.asked).not.toContain("Runlog alternatives")
  }, 30_000)

  it("still harvests when the run has room, which is every uncapped run", async () => {
    // The guard above must not be reachable on the CLI's shape. 26 of the 27
    // runs on disk that harvested vendors had no ceiling and fired queries.
    const h = await runFixture({
      serp: serpWithRoundup(),
      script: { listicle: () => ({ vendors: ["Grepstack", "Tailwatch", "Runlog"] }) },
    })
    const stats = (h.result.report as { listicleHarvest: { starved: boolean } }).listicleHarvest
    expect(stats.starved).toBe(false)
    expect(h.calls.filter((c) => c.phase === "listicle").length).toBe(1)
    expect(h.asked).toContain("Runlog alternatives")
  }, 30_000)

  it("a roundup row naming an unsurfaced vendor fires a fresh query for it", async () => {
    const h = await runFixture({
      sweepOptions: { listicleHarvest: true },
      serp: serpWithRoundup(),
      script: {
        // The model is handed all three names the row mentions; the two
        // already on the map are code's job to drop, not the prompt's.
        listicle: () => ({ vendors: ["Grepstack", "Tailwatch", "Runlog"] }),
      },
    })

    expect(h.calls.filter((c) => c.phase === "listicle").length).toBe(1)
    expect(h.asked).toContain("Runlog alternatives")

    const runlog = h.result.entities.find((e) => e.domain === "runlog.example")
    expect(runlog).toBeDefined()

    const stats = (
      h.result.report as {
        listicleHarvest: { rowsScanned: number; vendorsFound: number; queriesFired: number }
      }
    ).listicleHarvest
    expect(stats.rowsScanned).toBe(1)
    // Grepstack and Tailwatch are already-known hosts — the code-side filter
    // drops them even though the script named all three.
    expect(stats.vendorsFound).toBe(1)
    expect(stats.queriesFired).toBe(1)
  })

  it("puts the vendor several roundups agree on ahead of the one mentioned once", async () => {
    /**
     * `rivalHand` spends two thirds of its budget on the FIRST names it is
     * handed, so on a real harvest the order decides who gets asked about at
     * all: one shopify run named 54 vendors, 14 got a query, and the model's
     * category-grouped order spent the whole prefix on point-of-sale — cutting
     * Adobe Commerce and Magento, the second and third most corroborated names
     * in its own list.
     */
    const twoRoundups = (): Record<string, SearchHit[]> => ({
      ...SERP,
      "log search alternatives": [
        ...SERP["log search alternatives"]!,
        { url: "https://r1.example/", title: "Best log search alternatives", description: "Zetalog and Quarrylog both made this best-of list." },
        { url: "https://r2.example/", title: "Top 5 log search alternatives", description: "Quarrylog leads this comparison." },
      ],
    })
    const h = await runFixture({
      sweepOptions: { listicleHarvest: true },
      serp: twoRoundups(),
      // Alpha-order puts Quarrylog second; two roundups name it and one names
      // Zetalog, so corroboration must overturn the order it was written in.
      script: { listicle: () => ({ vendors: ["Zetalog", "Quarrylog"] }) },
    })
    const q = h.asked.indexOf("Quarrylog alternatives")
    const z = h.asked.indexOf("Zetalog alternatives")
    expect(q).toBeGreaterThanOrEqual(0)
    expect(z).toBeGreaterThanOrEqual(0)
    expect(q).toBeLessThan(z)
  })

  it("a vendor already on the map buys no query at all", async () => {
    const h = await runFixture({
      sweepOptions: { listicleHarvest: true },
      serp: serpWithRoundup(),
      script: {
        listicle: () => ({ vendors: ["Grepstack", "Tailwatch"] }),
      },
    })
    expect(h.asked).not.toContain("Grepstack alternatives")
    expect(h.asked).not.toContain("Tailwatch alternatives")
    const stats = (
      h.result.report as { listicleHarvest: { vendorsFound: number; queriesFired: number } }
    ).listicleHarvest
    expect(stats.vendorsFound).toBe(0)
    expect(stats.queriesFired).toBe(0)
  })

  it("fails open: a listicle call that throws adds nothing and changes no other host", async () => {
    const h = await runFixture({
      sweepOptions: { listicleHarvest: true },
      serp: serpWithRoundup(),
      script: {
        listicle: () => {
          throw new Error("the model is down")
        },
      },
    })
    expect(h.asked).not.toContain("Runlog alternatives")
    expect(h.says.some((s) => s.includes("listicle harvest call failed"))).toBe(true)
    const plain = await runFixture({ serp: serpWithRoundup() })
    expect(h.result.entities.map((e) => e.domain).sort()).toEqual(
      plain.result.entities.map((e) => e.domain).sort(),
    )
  })

  it("the flag alone, with no roundup-shaped row in the results, calls no model and fires nothing", async () => {
    const h = await runFixture({ sweepOptions: { listicleHarvest: true } })
    expect(h.calls.filter((c) => c.phase === "listicle")).toEqual([])
    const stats = (
      h.result.report as {
        listicleHarvest: { starved: boolean; rowsScanned: number; vendorsFound: number; queriesFired: number }
      }
    ).listicleHarvest
    // `starved: false` is the load-bearing half of these zeros. The stage ran,
    // looked, and found no roundup-shaped row — a fact about what this run's
    // hits contained. The identical zeros with `starved: true` mean it never
    // looked, which is a fact about the budget.
    expect(stats).toEqual({ starved: false, rowsScanned: 0, vendorsFound: 0, queriesFired: 0 })
  })

  it("ROUNDUP_SHAPE's four other alternatives fire on their own, not only alongside 'alternatives'", () => {
    // ROUNDUP_SHAPE (sweep.ts) is `/alternatives|top \d+|best|vs\.?|comparison/i` — five
    // alternatives. Every roundup-shaped row fed through the fixture above (ROUNDUP, the two
    // rows in "puts the vendor several roundups agree on ahead...") reads "...alternatives" in
    // its title, so `top \d+`, `best`, `vs\.?` and `comparison` have never been the thing that
    // made the regex match; a title matching only via one of those four would still be classed
    // roundup-shaped, but nothing here proved it. Driven directly against the exported regex,
    // the same level `runFixture`'s filter (`.filter((h) => ROUNDUP_SHAPE.test(h.title) ||
    // ROUNDUP_SHAPE.test(h.description ?? ""))`) calls it at.
    for (const title of ["Top 5 log search tools", "Grepstack vs Tailwatch", "Grepstack vs. Tailwatch", "A deep comparison of log tools", "The best log search tool for teams"]) {
      expect(ROUNDUP_SHAPE.test(title), title).toBe(true)
    }
    expect(ROUNDUP_SHAPE.test("Grepstack pricing and docs")).toBe(false)
  })
})
