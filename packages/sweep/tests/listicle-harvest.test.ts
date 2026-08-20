import { describe, it, expect } from "vitest"
import { runFixture, SERP } from "./fixture.js"
import type { SearchHit } from "@open-kb/core"

/**
 * Listicle harvest: a roundup-shaped row's own title/description can name a
 * vendor this run never fired a query for. Its whole contract is the same
 * shape as triage/second-look/drop-confirm — off unless asked for, additive
 * only, and every failure fails open — and each sentence gets its suite
 * below.
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
  it("does not exist unless asked for", async () => {
    const h = await runFixture({ serp: serpWithRoundup() })
    expect(h.calls.filter((c) => c.phase === "listicle")).toEqual([])
    expect((h.result.report as { listicleHarvest?: unknown }).listicleHarvest).toBeNull()
    expect(h.result.entities.some((e) => e.domain === "runlog.example")).toBe(false)
  })

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
      h.result.report as { listicleHarvest: { rowsScanned: number; vendorsFound: number; queriesFired: number } }
    ).listicleHarvest
    expect(stats).toEqual({ rowsScanned: 0, vendorsFound: 0, queriesFired: 0 })
  })
})
