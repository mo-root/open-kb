import { describe, it, expect } from "vitest"
import { runFixture, HOSTS } from "./fixture.js"

/**
 * The triage stage: batched keep/skip verdicts from search metadata, before
 * any fetch. Its whole contract is three sentences — it is off unless asked
 * for, its only power is to skip, and every failure fails open — and each
 * sentence gets its suite below.
 */

describe("triage", () => {
  it("does not exist unless asked for", async () => {
    const h = await runFixture()
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
