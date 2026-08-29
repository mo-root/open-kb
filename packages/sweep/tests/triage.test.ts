import { describe, it, expect } from "vitest"
import { runFixture, HOSTS, SERP } from "./fixture.js"
import { TRIAGE_BATCH, TRIAGE_MAX_OUTPUT_TOKENS } from "../src/sweep.js"
import type { SearchHit } from "@open-kb/core"

/**
 * The triage stage: batched keep/skip verdicts from search metadata, before
 * any fetch. Its whole contract is three sentences — it defaults ON (its A/B
 * survived, see `SweepOptions.triage`), its only power is to skip, and every
 * failure fails open — and each sentence gets its suite below.
 */

describe("triage", () => {
  it("runs by default, with no flag needed", async () => {
    const h = await runFixture()
    expect(h.calls.filter((c) => c.phase === "triage").length).toBeGreaterThan(0)
    const triage = (h.result.report as { triage: { calls: number } }).triage
    expect(triage.calls).toBeGreaterThan(0)
  })

  it("does not exist when explicitly disabled", async () => {
    const h = await runFixture({ sweepOptions: { triage: false } })
    expect(h.calls.filter((c) => c.phase === "triage")).toEqual([])
    // And no entity claims the provenance of a stage that never ran.
    expect(h.result.entities.filter((e) => e.settledBy === "triage")).toEqual([])
    expect((h.result.report as { triage?: unknown }).triage).toBeNull()
  })

  it("a skipped host is never fetched, never judged, and keeps the reason", async () => {
    const h = await runFixture({
      sweepOptions: { triage: true },
      script: {
        triage: (hosts) => ({
          verdicts: hosts.map((host) => ({
            host,
            keep: host !== HOSTS.adtrash,
            why: host === HOSTS.adtrash ? "an ad-network page surfaced by an unlucky word" : "kept",
          })),
        }),
      },
    })

    // Never fetched: the judge's pool did not touch its front page.
    expect(h.fetch.calls.map((c) => c.url)).not.toContain(`https://${HOSTS.adtrash}/`)
    // Never judged: no classify call carries it as a subject.
    expect(h.calls.filter((c) => c.phase === "classify").map((c) => c.subject)).not.toContain(HOSTS.adtrash)

    // But recorded: off the map, wearing the triage provenance and the reason.
    const skipped = h.result.entities.find((e) => e.domain === HOSTS.adtrash)
    expect(skipped).toBeDefined()
    expect(skipped!.settledBy).toBe("triage")
    expect(skipped!.kind).toBe("noise")
    expect(skipped!.relation).toBe("none")
    expect(skipped!.because).toContain("triage:")
    expect(skipped!.because).toContain("unlucky word")

    const triage = (h.result.report as { triage: { hosts: number; kept: number; skipped: number; calls: number } }).triage
    expect(triage.skipped).toBe(1)
    expect(triage.kept).toBe(triage.hosts - 1)
    expect(triage.calls).toBeGreaterThan(0)
  })

  it("the default script keeps everything, so the flag alone changes nothing", async () => {
    const flagged = await runFixture({ sweepOptions: { triage: true } })
    const plain = await runFixture()
    // Same map: every kept entity of the plain run is judged in the flagged one.
    const domains = (h: typeof plain) => h.result.entities.map((e) => e.domain).sort()
    expect(domains(flagged)).toEqual(domains(plain))
    // And the stage itself ran.
    expect(flagged.calls.filter((c) => c.phase === "triage").length).toBeGreaterThan(0)
  })

  it("fails open: a triage call that throws sends every host to the judge", async () => {
    const h = await runFixture({
      sweepOptions: { triage: true },
      script: {
        triage: () => {
          throw new Error("the model is down")
        },
      },
    })
    // Nothing skipped, everything judged — identical census to a plain run.
    expect(h.result.entities.filter((e) => e.settledBy === "triage")).toEqual([])
    const plain = await runFixture()
    expect(h.result.entities.map((e) => e.domain).sort()).toEqual(
      plain.result.entities.map((e) => e.domain).sort(),
    )
    // The failure was said out loud, not swallowed.
    expect(h.says.some((s) => s.includes("triage call failed"))).toBe(true)
  })

  it("cannot skip a host the market kept returning — the seenIn exemption is code", async () => {
    // forum.example is returned by five fixture queries, exactly
    // TRIAGE_KEEP_SEENIN. A skip verdict against it must be ignored: that many
    // roads into one host is the search vouching for it, and a title does not
    // outrank the search.
    const h = await runFixture({
      sweepOptions: { triage: true },
      script: {
        triage: (hosts) => ({
          verdicts: hosts.map((host) => ({
            host,
            keep: host !== HOSTS.forum,
            why: host === HOSTS.forum ? "just a forum, skip it" : "kept",
          })),
        }),
      },
    })
    const forum = h.result.entities.find((e) => e.domain === HOSTS.forum)
    expect(forum).toBeDefined()
    // Judged from its page, not skipped from its snippet.
    expect(forum!.settledBy).not.toBe("triage")
    expect(forum!.kind).toBe("community")
    expect(h.calls.filter((c) => c.phase === "classify").map((c) => c.subject)).toContain(HOSTS.forum)
  })

  it("TRIAGE_BATCH caps how many hosts one triage call is handed", async () => {
    // TRIAGE_BATCH (sweep.ts) had zero grep hits in any test — the chunking
    // loop it drives, `for (let i = 0; i < hostList.length; i += TRIAGE_BATCH)
    // batches.push(hostList.slice(i, i + TRIAGE_BATCH))` (sweep.ts:5228-5229),
    // was never exercised past a single, undersized batch: the plain fixture's
    // hostList is 6 hosts (confirmed by reading `report.triage.hosts` off an
    // unmodified run), nowhere near the cap of 30.
    //
    // 40 fresh hosts, folded onto "log search alternatives" — the same query
    // listicle-harvest's tests fold extra rows onto, because it is one the
    // rival-family templates fire from Log Search Cloud's own terms without
    // any sweepOptions override — bring hostList to 46, sixteen past the cap,
    // so the loop has to split it into two batches.
    const extra: SearchHit[] = Array.from({ length: 40 }, (_, i) => ({
      url: `https://triage-batch-${i}.example/`,
      title: `Triage Batch Vendor ${i}`,
      description: "A fresh host that exists only to push hostList past TRIAGE_BATCH.",
    }))
    const batchSizes: number[] = []
    const h = await runFixture({
      serp: { ...SERP, "log search alternatives": [...SERP["log search alternatives"]!, ...extra] },
      script: {
        // Only the chunking is under test, so every host is skipped — nothing
        // downstream (fetch, classify) needs a contract for 40 fake hosts.
        triage: (hosts) => {
          batchSizes.push(hosts.length)
          return { verdicts: hosts.map((host) => ({ host, keep: false, why: "batch-cap test" })) }
        },
      },
    })
    const triage = (h.result.report as { triage: { hosts: number; calls: number } }).triage
    expect(triage.hosts).toBe(46)
    expect(triage.calls).toBe(2)
    // One full batch at the cap, the rest in the second.
    expect(batchSizes.sort((a, b) => b - a)).toEqual([TRIAGE_BATCH, 46 - TRIAGE_BATCH])
  }, 30_000)

  it("pins the triage answer's size — its own comment says call() floors it anyway", () => {
    // TRIAGE_MAX_OUTPUT_TOKENS had zero grep hits in any test, unlike its
    // sibling CLASSIFY_MAX_OUTPUT_TOKENS (pinned in prompts.test.ts). Read
    // sweep.ts:2192, `call()`'s wire ceiling is `Math.max(6_000, opts.
    // maxOutputTokens ?? 8_192)` — 2,000 never lowers it, so this constant
    // cannot be exercised through a fixture call's actual token ceiling; it
    // only documents the verdict rows' expected size, same standing as
    // CLASSIFY_MAX_OUTPUT_TOKENS's own comment says of that constant.
    expect(TRIAGE_MAX_OUTPUT_TOKENS).toBe(2_000)
  })

  it("fails open on a verdict for a host that was never asked about", async () => {
    const h = await runFixture({
      sweepOptions: { triage: true },
      script: {
        triage: (hosts) => ({
          verdicts: [
            // The model hallucinating a skip for someone else's host.
            { host: "unrelated.example", keep: false, why: "not asked" },
            ...hosts.map((host) => ({ host, keep: true, why: "kept" })),
          ],
        }),
      },
    })
    expect(h.result.entities.find((e) => e.domain === "unrelated.example")).toBeUndefined()
    expect(h.result.entities.filter((e) => e.settledBy === "triage")).toEqual([])
  })
})

/**
 * THE OVERRIDE THAT CANNOT BE UNDONE.
 *
 * A host `TRIAGE_KEEP_SEENIN` distinct queries returned survives a triage vote
 * to drop it — the search itself vouching for the host outranks a title and a
 * description. be4e081 cites this as the one cost of overlapping the judge
 * with the search tail that is irreversible: a host dropped here never reaches
 * the judge, the second look, or the map.
 *
 * It was invisible in `report.triage`, because a saved host is judged normally
 * and reads exactly like one triage never objected to. Measured from the other
 * side it holds — 1,247 triage-skipped entities across every run on disk have
 * a maximum `seenIn` of 4 against a bar of 5 — and `saved` now counts it.
 */
describe("triage's corroboration override", () => {
  it("counts a host it kept over triage's objection", async () => {
    const h = await runFixture({
      sweepOptions: { triage: true },
      script: {
        // Triage votes every host off; only the seenIn bar can save one.
        triage: (hosts: string[]) => ({
          verdicts: hosts.map((host) => ({ host, keep: false, why: "not this market" })),
        }),
      },
    })
    const t = h.result.report.triage as { hosts: number; kept: number; skipped: number; saved: number }
    // Whatever the fixture's corroboration, the three numbers have to agree
    // and `saved` can only ever be hosts that were kept.
    expect(t.kept + t.skipped).toBe(t.hosts)
    expect(t.saved).toBeLessThanOrEqual(t.kept)
    // With every verdict a drop, every kept host is a save (bar the anchor,
    // which hostList already excludes).
    expect(t.saved).toBe(t.kept)
  }, 30_000)
})
