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
import type { StoredNode, StoredEdge } from "../src/tools.js"

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
    expect(p.frontmatter.includes).toContain("03-evidence")
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
    const doctrine = loadPrompt("03-evidence", DOCTRINE_DIR).body
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
      graph: { nodes: new Map<string, StoredNode>(), edges: [] as StoredEdge[] },
    }

    // Another agent got here first. Several investigators share one graph, one span stream
    // and one evidence store, so what this run reports must be a delta against what it was
    // handed, an absolute total would credit this agent with the other one's work. Node,
    // edge and spend are all seeded, so a regression to absolutes fails on every counter
    // rather than only the one that happened to be covered.
    ctx.graph.nodes.set("company:already-here", {
      id: "company:already-here",
      kind: "company",
      name: "Already Here",
      what: "written by another investigator before this one started",
      whyHere: "someone else's finding",
      howFound: "someone else's query",
      evidence: [],
      alsoWhat: [],
      alsoWhyHere: [],
    })
    ctx.graph.edges.push({
      from: "company:already-here",
      to: "company:example.com",
      relation: "competitor",
      whyHere: "someone else's finding",
      howFound: "someone else's query",
      evidence: [],
    })
    ctx.spans.emit({
      runId: "r1",
      agentId: "other",
      parentId: "lead",
      kind: "search",
      name: "serp",
      argsDigest: "someone else's query",
      ms: 5,
      usd: 0.004,
      ok: true,
    })

    // Scripted model: search, then fetch, then remember, then a closing summary.
    // The turn is counted from the transcript the SDK hands back, so each step sees the
    // real tool results of the step before it, that transcript is the loop under test.
    //
    // `doGenerate`, not `doStream`: ToolLoopAgent.generate() routes through generateText,
    // which only ever calls doGenerate. A doStream-only mock throws "Not implemented".
    const call = (id: string, toolName: string, input: unknown) => [
      { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    ]

    // What the model was actually handed as its system prompt. `investigate` composing a
    // prompt it then fails to pass to the agent would be invisible to every other assertion
    // here, so capture it and check the doctrine really made the trip.
    let systemPrompt = ""

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const system = prompt.find((m) => m.role === "system")
        if (system) systemPrompt = String(system.content)
        const turn = prompt.filter((m) => m.role === "tool").length

        // Read the handle out of the transcript rather than hardcoding one. A real model cites
        // what it was just handed. Hardcoding `ev1` made this test depend on which tool happened
        // to record first, and when `search` began recording every hit so the whole result bag
        // is citable, the numbering shifted and the test broke on an implementation detail
        // rather than on a behaviour. Prefer a fetched page (it reports `bytes`); fall back to
        // the last handle seen.
        const toolMsgs = JSON.stringify(prompt.filter((m) => m.role === "tool"))
        const pageHandle =
          toolMsgs.match(/"handle":"(ev\d+)"[^}]*"bytes"/)?.[1] ??
          toolMsgs.match(/"handle":"(ev\d+)"/g)?.slice(-1)[0]?.match(/ev\d+/)?.[0] ??
          "ev1"

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
                        evidence: [{ handle: pageHandle, quote: "Rival sells an anti-bot bypass API" }],
                      },
                    ],
                    edges: [
                      {
                        from: "company:rival",
                        to: "company:example.com",
                        relation: "competitor",
                        whyHere: "sells the anchor's capability to the anchor's buyer",
                        howFound: "anti-bot bypass api",
                        evidence: [{ handle: pageHandle, quote: "anti-bot bypass API to developers" }],
                      },
                    ],
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

    // The doctrine is what makes this agent an investigator rather than a chat model with
    // four tools. If it never reached the model, nothing else in this test would notice.
    expect(systemPrompt).toContain("The anchor is the ceiling, not the count")
    expect(systemPrompt).toContain("A finding you did not record did not happen")
    expect(systemPrompt).toContain("Work that mission")

    // One node and one edge written by this run, on a graph that already held someone
    // else's one of each. Absolute counts would read 2 and 2 here.
    expect(out.nodes).toBe(1)
    expect(out.edges).toBe(1)
    expect(out.summary).toContain("Found one rival")
    // Three nodes on the graph: the other investigator's, the anchor this run seeded before
    // its counters were read, and the one this run proved. Only the last is its delta.
    expect(ctx.graph.nodes.size).toBe(3)
    expect(ctx.graph.edges.length).toBe(2)

    const node = ctx.graph.nodes.get("company:rival")!
    expect(node.name).toBe("Rival")
    expect(node.whyHere).toContain("same capability")
    // The whole promise: the citation points at a URL this run actually fetched, and the
    // quote was proven against those bytes rather than asserted. `hasFetched` is only true
    // for a URL this run stored a `found` body for, so it cannot be satisfied by a URL the
    // model merely named.
    expect(node.evidence[0]!.url).toBe("https://rival.com")
    expect(ctx.evidence.hasFetched(node.evidence[0]!.url)).toBe(true)
    expect(node.evidence[0]!.quote).toBe("Rival sells an anti-bot bypass API")

    const edge = ctx.graph.edges.find((e) => e.from === "company:rival")!
    expect(edge.relation).toBe("competitor")
    expect(ctx.evidence.hasFetched(edge.evidence[0]!.url)).toBe(true)

    // One search at $0.001 and one free direct fetch, what this run spent, not the
    // $0.005 on the shared stream.
    expect(out.usd).toBeCloseTo(0.001, 6)
    expect(ctx.spans.totalUsd()).toBeCloseTo(0.005, 6)
  })

  it("seeds the anchor as a node, so an edge stated from the anchor resolves", async () => {
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: new FakeSearch({}),
      fetch: new FakeFetch({
        "https://rival.com": {
          httpStatus: 200,
          body: "<p>" + "Rival sells an anti-bot bypass API to developers. ".repeat(8) + "</p>",
        },
      }),
      runId: "r2",
      agentId: "inv1",
      parentId: null,
      graph: { nodes: new Map<string, StoredNode>(), edges: [] as StoredEdge[] },
    }

    const call = (id: string, toolName: string, input: unknown) => [
      { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    ]

    // The model writes `from: "example.com"`, the anchor, named the way it thinks of it,
    // which is exactly what the live stripe.com run did on all eight of its edges.
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length

        // Read the handle out of the transcript rather than hardcoding one. A real model cites
        // what it was just handed. Hardcoding `ev1` made this test depend on which tool happened
        // to record first, and when `search` began recording every hit so the whole result bag
        // is citable, the numbering shifted and the test broke on an implementation detail
        // rather than on a behaviour. Prefer a fetched page (it reports `bytes`); fall back to
        // the last handle seen.
        const toolMsgs = JSON.stringify(prompt.filter((m) => m.role === "tool"))
        const pageHandle =
          toolMsgs.match(/"handle":"(ev\d+)"[^}]*"bytes"/)?.[1] ??
          toolMsgs.match(/"handle":"(ev\d+)"/g)?.slice(-1)[0]?.match(/ev\d+/)?.[0] ??
          "ev1"

        const content =
          turn === 0
            ? call("1", "fetch", { urls: ["https://rival.com"], mode: "direct", why: "confirm what this host is" })
            : turn === 1
              ? call("2", "remember", {
                  nodes: [
                    {
                      kind: "company",
                      name: "Rival",
                      what: "anti-bot bypass API",
                      whyHere: "sells the same capability to the same buyer",
                      howFound: "anti-bot bypass api",
                      evidence: [{ handle: pageHandle, quote: "Rival sells an anti-bot bypass API" }],
                    },
                  ],
                  edges: [
                    {
                      from: "example.com",
                      to: "Rival",
                      relation: "competitor",
                      whyHere: "takes the anchor's buyer with the anchor's capability",
                      howFound: "anti-bot bypass api",
                      evidence: [{ handle: pageHandle, quote: "anti-bot bypass API to developers" }],
                    },
                  ],
                })
              : [{ type: "text" as const, text: "Done." }]

        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
          warnings: [],
        }
      },
    })

    const out = await investigate({ anchor: "example.com", mission: "find head-on rivals", ctx, model, maxSteps: 6 })

    // The anchor is a real entity on the map, the one everything else is stated against.
    const anchor = ctx.graph.nodes.get("company:example.com")!
    expect(anchor).toBeDefined()
    expect(anchor.kind).toBe("company")
    expect(anchor.name).toBe("example.com")
    // Nothing was fetched to prove the anchor, and it says so rather than pretending.
    expect(anchor.evidence).toHaveLength(0)
    expect(anchor.isAnchor).toBe(true)
    expect(anchor.howFound).toMatch(/anchor/i)

    // Seeding the anchor is not a finding: the delta this run reports is the node it proved.
    expect(out.nodes).toBe(1)
    expect(out.edges).toBe(1)

    const edge = ctx.graph.edges[0]!
    expect(edge.from).toBe("company:example.com")
    expect(edge.to).toBe("company:rival")
    for (const e of ctx.graph.edges) {
      expect(ctx.graph.nodes.has(e.from)).toBe(true)
      expect(ctx.graph.nodes.has(e.to)).toBe(true)
    }
  })

  it("does not re-seed an anchor a prior investigator already enriched", async () => {
    // The seed guard (`if (!ctx.graph.nodes.has(seed.id)) ...`) only ever ran its
    // true branch in this file's other tests — a fresh graph, first arrival, seed
    // written. Its whole reason to exist, per its own comment ("an unguarded write
    // would also discard citations a previous agent proved against the anchor's
    // own id"), is the false branch: a second investigator reaching an anchor a
    // first one already enriched. `remember` (tools.ts ~line 565-578) merges into
    // an existing node by pushing onto `alsoWhat`/`alsoWhyHere` rather than
    // replacing it, so that is exactly the shape a live multi-investigator run
    // leaves behind — proven here directly on the graph rather than by re-running
    // the tool, since the guard itself doesn't care how the enrichment arrived.
    const seededAnchor = {
      id: "company:example.com",
      kind: "company" as const,
      name: "example.com",
      what: "Not established by this run — no page was fetched to describe the anchor itself.",
      whyHere: "This is the anchor. The map exists to explain this company's position, and every other node here is stated against it.",
      howFound: "Seeded as the anchor of this run, before any search ran. Not discovered, and carries no evidence.",
      evidence: [] as StoredNode["evidence"],
      alsoWhat: ["a prior investigator's remember call found this about the anchor itself"],
      alsoWhyHere: [] as string[],
      isAnchor: true as const,
    }

    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: new FakeSearch({}),
      fetch: new FakeFetch({}),
      runId: "r3",
      agentId: "inv2",
      parentId: null,
      graph: {
        nodes: new Map<string, StoredNode>([[seededAnchor.id, seededAnchor]]),
        edges: [] as StoredEdge[],
      },
    }

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Nothing new to report." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
    })

    const out = await investigate({ anchor: "example.com", mission: "find head-on rivals", ctx, model, maxSteps: 6 })

    // The guard fired: the already-there anchor is the exact same object, untouched,
    // not replaced by `anchorNode("example.com")`'s bare seed. A regression to an
    // unguarded `.set()` would pass an equality check on the plain fields but wipe
    // `alsoWhat` back to `[]` — asserted on directly, not inferred from object identity.
    const anchor = ctx.graph.nodes.get("company:example.com")!
    expect(anchor.alsoWhat).toEqual(["a prior investigator's remember call found this about the anchor itself"])
    expect(ctx.graph.nodes.size).toBe(1)
    // The anchor was already on the map before this investigator started, so it
    // contributes nothing to this run's own delta.
    expect(out.nodes).toBe(0)
  })

  it("prices a model turn against the rate the caller supplies, instead of reporting it free", async () => {
    // onStepFinish (investigator.ts ~94-117) runs on every turn of every test above, but
    // every one of them calls investigate() without `pricing`, so `rate` is always falsy
    // there: `usd` always takes the `: 0` branch and `error` always takes the "no model
    // pricing supplied" branch. The truthy side — an actual caller charging real tokens
    // at a real rate — had never run once (coverage: investigator.ts branch 37.5%, the
    // only file lines it names, 98-114, are exactly this block). That is the one path
    // that turns tokens into dollars, so a broken rate formula would ship silent.
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: new FakeSearch({}),
      fetch: new FakeFetch({}),
      runId: "r4",
      agentId: "inv1",
      parentId: null,
      graph: { nodes: new Map<string, StoredNode>(), edges: [] as StoredEdge[] },
    }

    // One turn, no tool calls, straight to a close — the pricing math is the point here,
    // the tool loop itself is already exercised above. Omitting `maxSteps` also covers the
    // `opts.maxSteps ?? 24` default (investigator.ts:75), safe because this model stops
    // on its first turn regardless of the cap.
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Nothing to report." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 500_000, noCache: 500_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100_000, text: 100_000, reasoning: 0 },
        },
        warnings: [],
      }),
    })

    const out = await investigate({
      anchor: "example.com",
      mission: "find head-on rivals",
      ctx,
      model,
      pricing: { inUsdPerM: 2, outUsdPerM: 10 },
      modelName: "test-model",
    })

    // (500_000 / 1e6) * 2 + (100_000 / 1e6) * 10 = 1.0 + 1.0
    expect(out.usd).toBeCloseTo(2, 6)
    expect(ctx.spans.totalUsd()).toBeCloseTo(2, 6)

    ctx.spans.close()
    const spans = []
    for await (const s of ctx.spans.stream()) spans.push(s)
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.kind).toBe("model")
    expect(span.name).toBe("test-model")
    expect(span.tokensIn).toBe(500_000)
    expect(span.tokensOut).toBe(100_000)
    expect(span.usd).toBeCloseTo(2, 6)
    // Priced, so no "unpriced run" complaint — the opposite of what every other test in
    // this file gets, since none of them supply a rate.
    expect(span.error).toBeUndefined()
  })

  it("prices a turn a provider reports with no token counts at all as free, not NaN", async () => {
    // investigator.ts:98-99 reads `step.usage?.inputTokens ?? 0` and `?.outputTokens ?? 0`.
    // Every test above, this file's own pricing test included, has the mock model report
    // full counts, so the `?? 0` side of both never ran (coverage: investigator.ts branch
    // 81.81%, naming exactly these two lines). The `ai` SDK normalizes a provider's raw
    // `doGenerate` usage (`inputTokens.total`, `outputTokens.total`, both spelled
    // `number | undefined` in `@ai-sdk/provider` — "if reported by the provider") into the
    // `LanguageModelUsage` this callback reads, where `inputTokens`/`outputTokens`
    // themselves stay `number | undefined`. So a provider that does not report tokens is
    // real input, not a hypothetical: without the fallback, `(undefined / 1e6) * rate` is
    // `NaN`, and a `NaN` cost would poison the run's spend ceiling silently rather than
    // just under- or over-charging it.
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: new FakeSearch({}),
      fetch: new FakeFetch({}),
      runId: "r5",
      agentId: "inv1",
      parentId: null,
      graph: { nodes: new Map<string, StoredNode>(), edges: [] as StoredEdge[] },
    }

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Nothing to report." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    })

    const out = await investigate({
      anchor: "example.com",
      mission: "find head-on rivals",
      ctx,
      model,
      pricing: { inUsdPerM: 2, outUsdPerM: 10 },
      modelName: "test-model",
    })

    // Both fallbacks land on 0, so the whole rate formula is 0, not NaN.
    expect(out.usd).toBe(0)
    expect(Number.isNaN(out.usd)).toBe(false)
    expect(ctx.spans.totalUsd()).toBe(0)

    ctx.spans.close()
    const spans = []
    for await (const s of ctx.spans.stream()) spans.push(s)
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.tokensIn).toBe(0)
    expect(span.tokensOut).toBe(0)
    expect(span.usd).toBe(0)
    // Priced (a rate was supplied), so this is the zero-tokens case, not the
    // unpriced-run one — the span carries no complaint.
    expect(span.error).toBeUndefined()
  })
})
