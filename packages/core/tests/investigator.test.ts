import { describe, it, expect, afterEach } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EvidenceStore } from "../src/evidence.js"
import { SpanStream } from "../src/spans.js"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"
import { investigate } from "../src/investigator.js"
import { loadPrompt, composePrompt } from "../src/prompts.js"

const AGENTS_DIR = "prompts/agents"
const DOCTRINE_DIR = "prompts/doctrine"

describe("loadPrompt", () => {
  const temps: string[] = []
  afterEach(() => {
    while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
  })
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "openkb-prompt-"))
    temps.push(d)
    return d
  }

  it("reads frontmatter and body", () => {
    const p = loadPrompt("investigator", AGENTS_DIR)
    expect(p.frontmatter.agent).toBe("investigator")
    expect(p.frontmatter.includes).toContain("00-minimum")
    expect(p.body.length).toBeGreaterThan(200)
    expect(p.body.startsWith("---")).toBe(false)
  })

  it("fails loudly when the declared identity disagrees with the filename", () => {
    const dir = scratch()
    writeFileSync(join(dir, "investigator.md"), "---\nagent: scout\n---\nbody text here\n")
    expect(() => loadPrompt("investigator", dir)).toThrow(/declares "scout"/)
  })

  it("fails when there is no frontmatter at all", () => {
    const dir = scratch()
    writeFileSync(join(dir, "loose.md"), "just a body, no identity\n")
    expect(() => loadPrompt("loose", dir)).toThrow(/no frontmatter/)
  })
})

describe("composePrompt", () => {
  it("prepends every doctrine the agent declares", () => {
    const agentOnly = loadPrompt("investigator", AGENTS_DIR).body
    const doctrine = loadPrompt("00-minimum", DOCTRINE_DIR).body
    const composed = composePrompt("investigator", AGENTS_DIR, DOCTRINE_DIR)

    expect(composed).toContain(agentOnly)
    expect(composed).toContain(doctrine)
    // The doctrine is the bulk of what the agent reads; a composition that merely
    // returned the agent file would still "contain the agent file" and pass above.
    expect(composed.length).toBeGreaterThan(agentOnly.length + 1_000)
  })
})

describe("investigate", () => {
  it("runs the tool loop, writes findings, and reports what it spent", async () => {
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: new FakeSearch({
        "anti-bot bypass api": [{ url: "https://rival.com", title: "Rival", description: "bypass" }],
      }),
      fetch: new FakeFetch({
        "https://rival.com": {
          httpStatus: 200,
          body: "<p>" + "Rival sells an anti-bot bypass API to developers. ".repeat(8) + "</p>",
        },
      }),
      runId: "r1",
      agentId: "inv1",
      parentId: "lead",
      graph: { nodes: new Map(), edges: [] },
    }

    // Scripted model: search, then fetch, then remember, then a closing summary.
    // The turn is counted from the transcript the SDK hands back, so each step sees the
    // real tool results of the step before it — that transcript is the loop under test.
    //
    // `doGenerate`, not `doStream`: ToolLoopAgent.generate() routes through generateText,
    // which only ever calls doGenerate. A doStream-only mock throws "Not implemented".
    const call = (id: string, toolName: string, input: unknown) => [
      { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    ]

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "search", { queries: ["anti-bot bypass api"], why: "find rivals by capability" })
            : turn === 1
              ? call("2", "fetch", {
                  urls: ["https://rival.com"],
                  mode: "direct",
                  why: "confirm what this host is",
                })
              : turn === 2
                ? call("3", "remember", {
                    nodes: [
                      {
                        kind: "company",
                        name: "Rival",
                        what: "anti-bot bypass API",
                        whyHere: "sells the same capability to the same buyer",
                        howFound: "anti-bot bypass api",
                        evidence: [{ handle: "ev1", quote: "Rival sells an anti-bot bypass API" }],
                      },
                    ],
                    edges: [],
                  })
                : [{ type: "text" as const, text: "Found one rival." }]

        return {
          content,
          finishReason: { unified: turn >= 3 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
          warnings: [],
        }
      },
    })

    const out = await investigate({ anchor: "example.com", mission: "find head-on rivals", ctx, model, maxSteps: 6 })

    expect(out.nodes).toBe(1)
    expect(out.edges).toBe(0)
    expect(out.summary).toContain("Found one rival")
    expect(ctx.graph.nodes.size).toBe(1)

    const node = [...ctx.graph.nodes.values()][0]!
    expect(node.name).toBe("Rival")
    expect(node.whyHere).toContain("same capability")
    // The whole promise: the citation points at a URL this run actually fetched,
    // and the quote was proven against those bytes rather than asserted.
    expect(node.evidence[0]!.url).toBe("https://rival.com")
    expect(ctx.evidence.hasFetched(node.evidence[0]!.url)).toBe(true)
    expect(node.evidence[0]!.quote).toBe("Rival sells an anti-bot bypass API")

    // One search at $0.001 and one free direct fetch — the run reports what it spent.
    expect(out.usd).toBeCloseTo(0.001, 6)
  })
})
