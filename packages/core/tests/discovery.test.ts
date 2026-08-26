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

  /**
   * `submitProduct` and `submitIntegration` both dedup on
   * `name.trim().toLowerCase()` before pushing — the one guard standing
   * between an agent that re-describes something it already found and a map
   * that lists it twice. Neither branch had a test anywhere in the repo
   * (checked: no test file references the "already submitted" reject path),
   * so a rewrite of either guard could silently start doubling entries and
   * nothing would fail.
   */
  it("submitProduct rejects a name that only differs by case or whitespace from one already submitted", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "submitProduct", { name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" })
            : turn === 1
              ? call("2", "submitProduct", { name: "  WIDGET ", does: "same thing, reworded", foundAt: "https://acme.com/widget-2" })
              : turn === 2
                ? call("3", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
                : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 3 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 6 })

    // The near-duplicate never landed: still one product, the first one.
    expect(out.products).toEqual([{ name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" }])

    // And it was refused, not silently ignored — the model saw why.
    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const rejected = results.find((r) => r.toolCallId === "2")
    expect(rejected?.output).toEqual({ ok: false, reason: expect.stringContaining("already submitted") })
  })

  it("submitIntegration rejects a name that only differs by case or whitespace from one already submitted", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "submitIntegration", { with: "PagerDuty", does: "pages on-call", foundAt: "https://acme.com/docs" })
            : turn === 1
              ? call("2", "submitIntegration", { with: " pagerduty ", does: "reworded", foundAt: "https://acme.com/docs/2" })
              : turn === 2
                ? call("3", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
                : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 3 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 6 })

    expect(out.integrations).toEqual([{ with: "PagerDuty", does: "pages on-call", foundAt: "https://acme.com/docs" }])

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const rejected = results.find((r) => r.toolCallId === "2")
    expect(rejected?.output).toEqual({ ok: false, reason: expect.stringContaining("already submitted") })
  })
})
