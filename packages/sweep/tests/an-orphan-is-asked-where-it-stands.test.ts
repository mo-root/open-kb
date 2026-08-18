import { describe, expect, it } from "vitest"
import { runFixture, HOSTS } from "./fixture.js"

/**
 * The orphan ask. After the free naming pass and the co-occurrence pairs,
 * 36-38% of two measured maps had no edge to anything — the pair selector
 * needs co-occurrence in two searches and most hosts are seen once. Every
 * such entity is now asked, batched, where it stands among its market's most
 * prominent members; "nobody" is an accepted answer.
 *
 * The fixture's forum co-occurs with everything exactly once, so it reaches
 * this phase as the resident orphan.
 */
describe("an orphan is asked where it stands", () => {
  it("asks once, and an answered stand becomes an inferred edge", async () => {
    const h = await runFixture({
      script: {
        orphan: () => ({
          stands: [
            {
              from: HOSTS.forum,
              to: HOSTS.grepstack,
              relation: "discusses",
              why: "its threads argue about the vendors selling log search",
            },
          ],
        }),
      },
    })
    const e = (h.result.edges ?? []).find((x) => x.from === HOSTS.forum && x.to === HOSTS.grepstack)
    expect(e, "the orphan's edge").toBeDefined()
    expect(e!.relation).toBe("discusses")
    expect(e!.confidence).toBe("inferred")
    const orphanCalls = h.calls.filter((c) => c.phase === "orphan")
    expect(orphanCalls).toHaveLength(1)
    // The prompt carries the orphan's own judged description and candidates.
    expect(orphanCalls[0]!.prompt).toContain(HOSTS.forum)
    expect(orphanCalls[0]!.prompt).toContain("candidates:")
    const stats = (h.result.report.linking as { orphans: { orphans: number; linked: number } }).orphans
    expect(stats.orphans).toBeGreaterThan(0)
    expect(stats.linked).toBe(1)
  })

  it("accepts nobody, and invents nothing", async () => {
    const h = await runFixture() // default orphan script answers nobody for all
    const stats = (h.result.report.linking as { orphans: { orphans: number; linked: number } }).orphans
    expect(stats.orphans).toBeGreaterThan(0)
    expect(stats.linked).toBe(0)
    // No edge whose endpoint is off the map, whatever the model said.
    const doms = new Set(h.result.entities.map((e) => e.domain))
    for (const e of h.result.edges ?? []) {
      expect(doms.has(e.from), e.from).toBe(true)
      expect(doms.has(e.to), e.to).toBe(true)
    }
  })

  it("drops a stand naming a host that is not on the map", async () => {
    const h = await runFixture({
      script: {
        orphan: () => ({
          stands: [
            { from: HOSTS.forum, to: "ghost.example", relation: "discusses", why: "a memory, not a finding" },
          ],
        }),
      },
    })
    expect((h.result.edges ?? []).some((e) => e.to === "ghost.example")).toBe(false)
  })
})
