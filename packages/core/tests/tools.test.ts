import { describe, it, expect } from "vitest"
import { EvidenceStore } from "../src/evidence.js"
import { SpanStream } from "../src/spans.js"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"
import { makeTools } from "../src/tools.js"

const ctx = () => ({
  evidence: new EvidenceStore(() => "2026-08-03T10:00:00.000Z"),
  spans: new SpanStream(() => "2026-08-03T10:00:00.000Z"),
  search: new FakeSearch({ "anti-bot bypass api": [{ url: "https://rival.com", title: "Rival", description: "bypass" }] }),
  fetch: new FakeFetch({
    "https://rival.com": { httpStatus: 200, body: "<html><body><p>" + "Rival sells an anti-bot bypass API for developers. ".repeat(8) + "</p></body></html>" },
    "https://stripe.com/radar": { httpStatus: 200, body: "" },
  }),
  runId: "r1",
  agentId: "inv1",
  parentId: "lead",
  graph: { nodes: new Map(), edges: [] },
})

describe("search tool", () => {
  it("returns hits and emits one span carrying the query text", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.search.execute!({ queries: ["anti-bot bypass api"], why: "find rivals by what they do" }, {} as never)
    expect(out.results[0]!.hits).toHaveLength(1)
    const spans = []
    c.spans.close()
    for await (const s of c.spans.stream()) spans.push(s)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.argsDigest).toBe("anti-bot bypass api")
    expect(spans[0]!.kind).toBe("search")
  })
})

describe("fetch tool", () => {
  it("stores fetched bytes and hands back a handle plus a slice", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "learn what this host is" }, {} as never)
    const r = out.results[0]!
    expect(r.status).toBe("found")
    expect(r.handle).toMatch(/^ev\d+$/)
    expect(r.slice).toContain("anti-bot bypass API")
  })

  it("reports the measured empty-body block as blocked, in words, without throwing", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.fetch.execute!({ urls: ["https://stripe.com/radar"], mode: "unlocked", why: "read the product page" }, {} as never)
    const r = out.results[0]!
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("empty-body")
    expect(r.handle).toBeUndefined()
  })
})

describe("remember tool", () => {
  it("writes a node when every quote verifies", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!
    const out = await t.remember.execute!({
      nodes: [{
        kind: "company", name: "Rival", what: "sells an anti-bot bypass API",
        whyHere: "sells the same capability as the anchor, to the same buyer",
        howFound: "anti-bot bypass api",
        evidence: [{ handle, quote: "Rival sells an anti-bot bypass API" }],
      }],
      edges: [],
    }, {} as never)
    expect(out.written.nodes).toBe(1)
    expect(out.rejected).toHaveLength(0)
  })

  it("rejects a node whose quote was never fetched, and says why", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!
    const out = await t.remember.execute!({
      nodes: [{
        kind: "company", name: "Rival", what: "raised $50M last year",
        whyHere: "competitor", howFound: "anti-bot bypass api",
        evidence: [{ handle, quote: "Rival raised $50M in Series B" }],
      }],
      edges: [],
    }, {} as never)
    expect(out.written.nodes).toBe(0)
    expect(out.rejected[0]).toContain("quote not present")
  })
})
