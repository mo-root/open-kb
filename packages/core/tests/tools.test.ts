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
    "https://rival.com/long": { httpStatus: 200, body: "Alpha ".repeat(2000) },
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
    expect(r.truncated).toBe(false)
    expect(r.nextOffset).toBeUndefined()
  })

  it("truncates long pages and tells the model where to resume", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.fetch.execute!({ urls: ["https://rival.com/long"], mode: "direct", why: "read a long page" }, {} as never)
    const r = out.results[0]!
    expect(r.status).toBe("found")
    expect(r.truncated).toBe(true)
    expect(r.bytes).toBeGreaterThan(8_000)
    expect(r.nextOffset).toBe(8_000)
    expect(r.slice).toHaveLength(8_000)
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

describe("read tool", () => {
  it("reports an unknown handle with a usable reason, without throwing", async () => {
    const c = ctx()
    const t = makeTools(c)
    const out = await t.read.execute!({ handle: "ev999", offset: 0 }, {} as never)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("no such handle")
  })

  it("reports a blocked page's handle as unreadable, in words, without throwing", async () => {
    const c = ctx()
    const t = makeTools(c)
    // The fetch tool never hands a blocked page's handle to the model (see the fetch tests
    // above) — but the run still recorded it internally. `read` must refuse it the same way
    // `remember` would, and say why, rather than pretending the page has content.
    const rec = c.evidence.record({ url: "https://stripe.com/radar", text: "", status: "blocked", reason: "empty-body" })
    const out = await t.read.execute!({ handle: rec.handle, offset: 0 }, {} as never)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("blocked")
    expect(out.reason).toContain("empty-body")
  })

  it("re-slices a genuinely fetched page from the given offset, with correct bytes and offset", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const first = f.results[0]!
    const out = await t.read.execute!({ handle: first.handle!, offset: 5 }, {} as never)
    expect(out.ok).toBe(true)
    expect(out.slice).toBe(first.slice!.slice(5))
    expect(out.bytes).toBe(first.bytes)
    expect(out.offset).toBe(5)
  })

  it("resumes exactly where a truncated fetch's nextOffset says to", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com/long"], mode: "direct", why: "x" }, {} as never)
    const first = f.results[0]!
    expect(first.truncated).toBe(true)
    const out = await t.read.execute!({ handle: first.handle!, offset: first.nextOffset! }, {} as never)
    expect(out.ok).toBe(true)
    expect(out.offset).toBe(first.nextOffset)
    expect(out.slice).toHaveLength(first.bytes! - first.nextOffset!)
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

  it("keeps the provable nodes of a mixed batch and names the one that fails, without aborting the batch", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!
    const out = await t.remember.execute!({
      nodes: [
        {
          kind: "company", name: "Rival", what: "sells an anti-bot bypass API",
          whyHere: "sells the same capability as the anchor, to the same buyer",
          howFound: "anti-bot bypass api",
          evidence: [{ handle, quote: "Rival sells an anti-bot bypass API" }],
        },
        {
          kind: "capability", name: "Anti-bot Bypass API",
          what: "an anti-bot bypass API sold to developers",
          whyHere: "the capability Rival competes on",
          howFound: "anti-bot bypass api",
          evidence: [{ handle, quote: "anti-bot bypass API for developers" }],
        },
        {
          kind: "company", name: "Ghost Co", what: "raised $50M last year",
          whyHere: "competitor", howFound: "anti-bot bypass api",
          evidence: [{ handle, quote: "Rival raised $50M in Series B" }],
        },
      ],
      edges: [
        {
          from: "company:rival", to: "company:ghost-co", relation: "competitor",
          whyHere: "both sell the same capability", howFound: "anti-bot bypass api",
          evidence: [{ handle, quote: "Ghost Co led a $200M funding round" }],
        },
      ],
    }, {} as never)

    // The two provable nodes were kept, and are really on the graph — not just counted.
    expect(out.written.nodes).toBe(2)
    expect(c.graph.nodes.has("company:rival")).toBe(true)
    expect(c.graph.nodes.has("capability:anti-bot-bypass-api")).toBe(true)

    // The unprovable node never reached the graph.
    expect(c.graph.nodes.has("company:ghost-co")).toBe(false)
    expect(c.graph.nodes.size).toBe(2)

    // The one bad edge did not write either, and did not take the good nodes down with it.
    expect(out.written.edges).toBe(0)
    expect(c.graph.edges).toHaveLength(0)

    // The rejection is specific enough that a model reading it knows exactly what to fix:
    // which claim failed (by name), and why (the quote it offered isn't on the page).
    expect(out.rejected).toHaveLength(2)
    const nodeRejection = out.rejected.find((r) => r.includes("Ghost Co"))
    expect(nodeRejection).toBeDefined()
    expect(nodeRejection).toContain("quote not present")
    const edgeRejection = out.rejected.find((r) => r.includes("company:rival->company:ghost-co"))
    expect(edgeRejection).toBeDefined()
    expect(edgeRejection).toContain("quote not present")
  })
})
