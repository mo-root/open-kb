import { describe, it, expect } from "vitest"
import { runFixture, ANCHOR, COINAGE } from "./fixture.js"

/**
 * Phase one as an agent: `discovery: "agent"` hands the reading of the company
 * to the tool-loop agent from @open-kb/core instead of the single pre-fetched
 * call. The flag exists for a head-to-head, so what these tests pin is the
 * contract of the seam: the agent's findings, not the call's, are what the rest
 * of the run descends from — and the default path does not move.
 */
describe("discovery: agent", () => {
  it("builds the decomposition from what the agent submitted, not from an understand call", async () => {
    const h = await runFixture({ sweepOptions: { discovery: "agent" } })

    // The agent took turns. Two tool turns and the closing text, all model
    // calls, all recorded.
    const turns = h.calls.filter((c) => c.phase === "discovery")
    expect(turns.length).toBeGreaterThanOrEqual(3)

    // What the run knows about the company is what the agent submitted...
    const d = h.result.decomposition
    expect(d.products.map((p) => p.name).sort()).toEqual(["Log Search Cloud", "Uptime Alerts"])
    expect(d.sells).toContain("hosted log search")
    expect(d.coinages).toContain(COINAGE)

    // ...grouped into markets by the one judgement call the agent does not
    // make. Its prompt carries the agent's own product list.
    const grouping = h.calls.find((c) => c.phase === "understand")
    expect(grouping, "the grouping call").toBeDefined()
    expect(grouping!.prompt).toContain("Log Search Cloud")
    expect(grouping!.prompt).toContain("would these have different competitors")
    expect(d.capabilities.map((c) => c.name).sort()).toEqual(["log search", "uptime alerts"])
  })

  it("runs the whole engine downstream of the agent — queries fire, hosts are judged, the map is written", async () => {
    const h = await runFixture({ sweepOptions: { discovery: "agent" } })
    expect(h.asked.length).toBeGreaterThan(0)
    expect(h.result.entities.length).toBeGreaterThan(0)
    // The agent's spend reaches the run's own ledger: understand's line exists
    // and carries the agent turns, not zero.
    const understand = (h.result.report.cost as { byAgent: Array<{ label: string; usd: number }> }).byAgent.find(
      (l) => l.label === "understand",
    )
    expect(understand, "understand on the bill").toBeDefined()
    expect(understand!.usd).toBeGreaterThan(0)
  })

  it("falls back to the single call when the agent comes back empty-handed", async () => {
    const h = await runFixture({
      sweepOptions: { discovery: "agent" },
      script: {
        // An agent that reads and then finishes without one submission.
        discovery: (turn) =>
          turn === 0
            ? { tools: [{ toolName: "finish", input: { sells: "", buyer: "", coinages: [] } }] }
            : { text: "nothing found" },
      },
    })
    // The run did not ship an empty market: the understand call answered.
    expect(h.result.decomposition.products.length).toBeGreaterThan(0)
    expect(h.says.some((s) => s.includes("falling back to the single-call reading"))).toBe(true)
  })

  it("does not take a single agent turn when the flag is off", async () => {
    const h = await runFixture({})
    expect(h.calls.filter((c) => c.phase === "discovery")).toHaveLength(0)
    expect(h.result.decomposition.products.length).toBeGreaterThan(0)
    void ANCHOR
  })
})
