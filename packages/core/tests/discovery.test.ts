import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { FakeFetch } from "../src/testing/fake-provider.js"
import { discover } from "../src/discovery.js"

/**
 * `discover()` had no dedicated test at all — every other caller of a
 * ToolLoopAgent in this package (investigate, catalog) has one, this did not.
 *
 * The gap that mattered: the file tracks `finished` (did the agent call its
 * own `finish` tool, or did it run out of turns?) but never returned it — the
 * comment right above the return says a run that stops without calling finish
 * still hands back whatever it found, which means a reader NEEDS to be able
 * to tell a complete list from a truncated one, and nothing exposed that. The
 * field existed, was written, and was thrown away by a no-op
 * `...(finished ? {} : {})` spread. Fixed by returning it; these two tests
 * pin both branches so it cannot regress the same way twice.
 */
describe("discover", () => {
  const call = (id: string, toolName: string, input: unknown) => [
    { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
  ]
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  }

  it("reports finished: true and the submitted facts when the agent calls finish", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "submitProduct", { name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" })
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: ["Widgetify"] })
              : [{ type: "text" as const, text: "Found one product." }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 6 })

    expect(out.finished).toBe(true)
    expect(out.products).toEqual([{ name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" }])
    expect(out.sells).toBe("widgets")
    expect(out.buyer).toBe("widget buyers")
  })

  it("reports finished: false but keeps what it found when the turn ceiling is hit first", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        // Never calls finish — always another product, so the ceiling is what stops it.
        return {
          content: call(String(turn + 1), "submitProduct", {
            name: `Widget ${turn}`,
            does: "does widget things",
            foundAt: "https://acme.com/widget",
          }),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 2 })

    expect(out.finished).toBe(false)
    // Truncated, not empty: the whole point of keeping a result on a missing
    // `finish` call is that the partial list still ships.
    expect(out.products.length).toBeGreaterThan(0)
    expect(out.sells).toContain("did not summarise")
  })
})
