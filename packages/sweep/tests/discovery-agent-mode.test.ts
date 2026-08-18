import { describe, it, expect } from "vitest"
import { runFixture, ANCHOR, COINAGE, HOSTS } from "./fixture.js"

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
  })

  it("reads the docs and carries what they say the products plug into", async () => {
    const h = await runFixture({
      sweepOptions: { discovery: "agent" },
      fetchTable: {
        [`https://docs.${ANCHOR}/`]: {
          httpStatus: 200,
          contentType: "text/html",
          body:
            `<html><head><title>Docs</title></head><body><h1>Pellucid Docs</h1>` +
            `<a href="/integrations/pagerduty">Send alerts to PagerDuty</a>` +
            `<p>Log Search Cloud ships alerts straight to PagerDuty escalation policies. This paragraph pads the page past the two hundred bytes a real docs index always clears.</p></body></html>`,
        },
      },
      script: {
        discovery: (turn) =>
          turn === 0
            ? { tools: [{ toolName: "findDocs", input: {} }] }
            : turn === 1
              ? {
                  tools: [
                    {
                      toolName: "submitProduct",
                      input: { name: "Log Search Cloud", does: "searches application logs", foundAt: `https://${ANCHOR}/products/log-search` },
                    },
                    {
                      toolName: "submitIntegration",
                      input: { with: "PagerDuty", does: "ships alerts to escalation policies", foundAt: `https://docs.${ANCHOR}/` },
                    },
                  ],
                }
              : turn === 2
                ? {
                    tools: [
                      {
                        toolName: "finish",
                        input: { sells: "hosted log search", buyer: "a platform team mid-incident", coinages: [COINAGE] },
                      },
                    ],
                  }
                : { text: "done" },
      },
    })

    // findDocs answered with the docs index the fetch table serves...
    const docsTurn = h.calls.filter((c) => c.phase === "discovery")[1]
    expect(docsTurn, "the turn after findDocs").toBeDefined()
    expect(docsTurn!.prompt).toContain("integrations/pagerduty")

    // ...and the integration the agent submitted reaches the run's report,
    // as the company's claim, not as a judged entity.
    const disc = h.result.report.discovery as {
      integrations: Array<{ with: string; foundAt: string }>
    }
    expect(disc.integrations.map((i) => i.with)).toEqual(["PagerDuty"])
    expect(disc.integrations[0]!.foundAt).toBe(`https://docs.${ANCHOR}/`)
    expect(h.result.entities.map((e) => e.name)).not.toContain("PagerDuty")
  })

  it("draws a declared integration as an edge when its name is on the map", async () => {
    // The docs said the product plugs into Grepstack; the sweep found
    // grepstack.example and kept it. Those two facts become one edge,
    // anchor -> entity, citing the docs page — inferred, because what the run
    // holds is the agent's account of the page, not the page's bytes.
    const h = await runFixture({
      sweepOptions: { discovery: "agent" },
      script: {
        discovery: (turn) =>
          turn === 0
            ? {
                tools: [
                  {
                    toolName: "submitProduct",
                    input: { name: "Log Search Cloud", does: "searches application logs", foundAt: `https://${ANCHOR}/products/log-search` },
                  },
                  {
                    toolName: "submitIntegration",
                    input: { with: "Grepstack", does: "forwards alerts into Grepstack dashboards", foundAt: `https://${ANCHOR}/docs/integrations` },
                  },
                ],
              }
            : turn === 1
              ? { tools: [{ toolName: "finish", input: { sells: "hosted log search", buyer: "a platform team", coinages: [COINAGE] } }] }
              : { text: "done" },
      },
    })
    const e = (h.result.edges ?? []).find(
      (x) => x.from === ANCHOR && x.to === HOSTS.grepstack && x.relation === "integration",
    )
    expect(e, "the docs-cited integration edge").toBeDefined()
    expect(e!.confidence).toBe("inferred")
    expect(e!.why).toContain("docs/integrations")
    const stats = (h.result.report.linking as { integrations: { declared: number; matched: number } }).integrations
    expect(stats).toEqual({ declared: 1, matched: 1 })
  })

  it("leaves an unmatched integration name as a lead, never a node", async () => {
    const h = await runFixture({
      sweepOptions: { discovery: "agent" },
      script: {
        discovery: (turn) =>
          turn === 0
            ? {
                tools: [
                  { toolName: "submitProduct", input: { name: "Log Search Cloud", does: "searches logs", foundAt: `https://${ANCHOR}/products/log-search` } },
                  { toolName: "submitIntegration", input: { with: "PagerDuty", does: "pages on-call", foundAt: `https://${ANCHOR}/docs` } },
                ],
              }
            : turn === 1
              ? { tools: [{ toolName: "finish", input: { sells: "hosted log search", buyer: "a team", coinages: [COINAGE] } }] }
              : { text: "done" },
      },
    })
    // PagerDuty never surfaced in any search, so it is not on the map and no
    // edge invents it.
    expect(h.result.entities.some((e) => /pagerduty/i.test(e.name))).toBe(false)
    expect((h.result.edges ?? []).some((e) => /pagerduty/i.test(e.to))).toBe(false)
  })

  it("reports discovery: null on the default path — nothing was investigated", async () => {
    const h = await runFixture({})
    expect(h.result.report.discovery).toBeNull()
  })
})
