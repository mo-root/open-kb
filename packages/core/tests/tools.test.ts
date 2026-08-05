import { describe, it, expect } from "vitest"
import { z } from "zod"
import { EvidenceStore } from "../src/evidence.js"
import { SpanStream } from "../src/spans.js"
import { FakeSearch, FakeFetch } from "../src/testing/fake-provider.js"
import { makeTools, anchorNode, nodeId, NODE_KINDS, type StoredNode, type StoredEdge } from "../src/tools.js"

const ctx = () => ({
  evidence: new EvidenceStore(() => "2026-08-03T10:00:00.000Z"),
  spans: new SpanStream(() => "2026-08-03T10:00:00.000Z"),
  search: new FakeSearch({ "anti-bot bypass api": [{ url: "https://rival.com", title: "Rival", description: "bypass" }] }),
  fetch: new FakeFetch({
    "https://rival.com": { httpStatus: 200, body: "<html><body><p>" + "Rival sells an anti-bot bypass API for developers. ".repeat(8) + "</p></body></html>" },
    "https://stripe.com/radar": { httpStatus: 200, body: "" },
    "https://rival.com/long": { httpStatus: 200, body: "Alpha ".repeat(2000) },
    // Two pages carrying the wording the live stripe.com run actually cited, so the
    // endpoint-resolution tests below prove their quotes the same way that run had to.
    "https://www.checkout.com/pricing": {
      httpStatus: 200,
      body:
        "<html><body><p>" +
        "Checkout.com is a global payment processing platform providing APIs, SDKs and fraud detection for online businesses. ".repeat(3) +
        "</p></body></html>",
    },
    "https://www.adyen.com/pricing": {
      httpStatus: 200,
      body:
        "<html><body><p>" +
        "Adyen is unified enterprise payment technology for processing, data and financial services. ".repeat(4) +
        "</p></body></html>",
    },
  }),
  runId: "r1",
  agentId: "inv1",
  parentId: "lead",
  graph: { nodes: new Map<string, StoredNode>(), edges: [] as StoredEdge[] },
})

type Ctx = ReturnType<typeof ctx>

/** Every span this context emitted, in order. */
const drainSpans = async (c: Ctx) => {
  const spans = []
  c.spans.close()
  for await (const s of c.spans.stream()) spans.push(s)
  return spans
}

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
    // above), but the run still recorded it internally. `read` must refuse it the same way
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

    // The two provable nodes were kept, and are really on the graph, not just counted.
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
    const nodeRejection = out.rejected.find((r: string) => r.includes("Ghost Co"))
    expect(nodeRejection).toBeDefined()
    expect(nodeRejection).toContain("quote not present")
    const edgeRejection = out.rejected.find((r: string) => r.includes("company:rival->company:ghost-co"))
    expect(edgeRejection).toBeDefined()
    expect(edgeRejection).toContain("quote not present")
  })
})

describe("remember, the kinds the model is told about", () => {
  /** The `kind` field of a node, as the model receives it. */
  const kindField = () => {
    const schema = z.toJSONSchema(makeTools(ctx()).remember.inputSchema as unknown as z.ZodType) as unknown as {
      properties: { nodes: { items: { properties: { kind: { enum: string[]; description?: string } } } } }
    }
    return schema.properties.nodes.items.properties.kind
  }

  it("offers every kind the graph supports, and says what each one is for", async () => {
    // A kind the model is never told about is a kind that stays empty. `capability` and `buyer`
    // were in this enum for the whole of the live stripe.com run and nothing said what they were
    // for; that run recorded four nodes and all four were companies. Being in the enum is not
    // enough, the prose the model reads has to name the kind too.
    const field = kindField()
    const described = `${makeTools(ctx()).remember.description ?? ""} ${field.description ?? ""}`
    for (const kind of NODE_KINDS) {
      expect(field.enum, `"${kind}" is a node kind the model is never offered`).toContain(kind)
      expect(described, `"${kind}" is offered but nothing says what to put in it`).toContain(kind)
    }
  })

  it("records a node of every kind, with evidence, exactly as it records a company", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!

    const out = await t.remember.execute!(
      {
        nodes: NODE_KINDS.map((kind) => ({
          kind,
          name: `${kind} one`,
          what: "what it is, and who it is for",
          whyHere: "recorded against the anchor, one node per kind the map supports",
          howFound: "anti-bot bypass api",
          evidence: [{ handle, quote: "anti-bot bypass API for developers" }],
        })),
        edges: [],
      },
      {} as never,
    )

    expect(out.rejected).toHaveLength(0)
    expect(out.written.nodes).toBe(NODE_KINDS.length)
    expect(c.graph.nodes.size).toBe(NODE_KINDS.length)
    for (const kind of NODE_KINDS) {
      const node = c.graph.nodes.get(nodeId(kind, `${kind} one`))
      expect(node, `no ${kind} node reached the graph`).toBeDefined()
      expect(node!.kind).toBe(kind)
      expect(node!.evidence).toHaveLength(1)
      expect(node!.evidence[0]!.url).toBe("https://rival.com")
      expect(node!.isAnchor).toBeUndefined()
    }
  })
})

describe("remember, edge endpoints", () => {
  /** Fetch both payment pages and hand back the handle for each. */
  const pages = async (t: ReturnType<typeof makeTools>) => {
    const f = await t.fetch.execute!(
      { urls: ["https://www.checkout.com/pricing", "https://www.adyen.com/pricing"], mode: "direct", why: "read both pricing pages" },
      {} as never,
    )
    return { checkout: f.results[0]!.handle! as string, adyen: f.results[1]!.handle! as string }
  }

  const CHECKOUT_QUOTE = "global payment processing platform providing APIs"
  const ADYEN_QUOTE = "unified enterprise payment technology for processing"

  const company = (name: string, handle: string, quote: string) => ({
    kind: "company" as const,
    name,
    what: "payment processing sold to online businesses",
    whyHere: "sells the same capability as the anchor, to the same buyer",
    howFound: "API-first payment gateway alternatives",
    evidence: [{ handle, quote }],
  })

  it("resolves endpoints written as the bare company name and stores real node ids", async () => {
    const c = ctx()
    const t = makeTools(c)
    const h = await pages(t)

    // Nodes and their edge in one call, the way a model actually writes a finding.
    const out = await t.remember.execute!(
      {
        nodes: [company("checkout.com", h.checkout, CHECKOUT_QUOTE), company("adyen.com", h.adyen, ADYEN_QUOTE)],
        edges: [
          {
            from: "checkout.com",
            to: "adyen.com",
            relation: "competitor",
            whyHere: "both process payments for the same online businesses",
            howFound: "API-first payment gateway alternatives",
            evidence: [{ handle: h.checkout, quote: CHECKOUT_QUOTE }],
          },
        ],
      },
      {} as never,
    )

    expect(out.rejected).toHaveLength(0)
    expect(out.written.edges).toBe(1)
    const edge = c.graph.edges[0]!
    expect(edge.from).toBe("company:checkout.com")
    expect(edge.to).toBe("company:adyen.com")
    expect(c.graph.nodes.has(edge.from)).toBe(true)
    expect(c.graph.nodes.has(edge.to)).toBe(true)
  })

  it("resolves an endpoint that differs only by www., a trailing slash, casing or whitespace", async () => {
    const c = ctx()
    const t = makeTools(c)
    const h = await pages(t)
    await t.remember.execute!(
      { nodes: [company("checkout.com", h.checkout, CHECKOUT_QUOTE), company("adyen.com", h.adyen, ADYEN_QUOTE)], edges: [] },
      {} as never,
    )

    const out = await t.remember.execute!(
      {
        nodes: [],
        edges: [
          {
            from: "https://www.Checkout.com/",
            to: "  ADYEN.com ",
            relation: "competitor",
            whyHere: "both process payments for the same online businesses",
            howFound: "API-first payment gateway alternatives",
            evidence: [{ handle: h.adyen, quote: ADYEN_QUOTE }],
          },
        ],
      },
      {} as never,
    )

    expect(out.rejected).toHaveLength(0)
    expect(out.written.edges).toBe(1)
    expect(c.graph.edges[0]!.from).toBe("company:checkout.com")
    expect(c.graph.edges[0]!.to).toBe("company:adyen.com")
  })

  it("rejects an edge naming a company nobody recorded, names it, and still lands its provable sibling", async () => {
    const c = ctx()
    const t = makeTools(c)
    const h = await pages(t)

    const out = await t.remember.execute!(
      {
        nodes: [company("checkout.com", h.checkout, CHECKOUT_QUOTE), company("adyen.com", h.adyen, ADYEN_QUOTE)],
        edges: [
          {
            from: "checkout.com",
            to: "hyperswitch.io",
            relation: "substitute",
            whyHere: "an open-source router replaces the hosted gateway",
            howFound: "open source payment orchestration",
            evidence: [{ handle: h.checkout, quote: CHECKOUT_QUOTE }],
          },
          {
            from: "checkout.com",
            to: "adyen.com",
            relation: "competitor",
            whyHere: "both process payments for the same online businesses",
            howFound: "API-first payment gateway alternatives",
            evidence: [{ handle: h.adyen, quote: ADYEN_QUOTE }],
          },
        ],
      },
      {} as never,
    )

    // The unresolvable edge did not land, and was not silently invented as a node either.
    expect(c.graph.nodes.size).toBe(2)
    expect(c.graph.nodes.has("company:hyperswitch.io")).toBe(false)

    // The provable sibling in the same call still landed.
    expect(out.written.edges).toBe(1)
    expect(c.graph.edges).toHaveLength(1)
    expect(c.graph.edges[0]!.to).toBe("company:adyen.com")

    // The rejection tells the model exactly what to do next: name the endpoint, record it.
    expect(out.rejected).toHaveLength(1)
    const rejection = out.rejected[0]!
    expect(rejection).toContain("hyperswitch.io")
    expect(rejection).toMatch(/node/i)
    expect(rejection).toMatch(/first/i)
  })

  it("refuses an endpoint two different nodes both answer to, rather than guessing between them", async () => {
    const c = ctx()
    const t = makeTools(c)
    const h = await pages(t)

    // A company and a capability that share a spelling. `company:checkout` and
    // `capability:checkout` are different entities; "checkout" names neither of them alone.
    await t.remember.execute!(
      {
        nodes: [
          company("Checkout", h.checkout, CHECKOUT_QUOTE),
          {
            kind: "capability" as const,
            name: "checkout",
            what: "taking a payment at the end of a purchase",
            whyHere: "the capability both companies compete on",
            howFound: "API-first payment gateway alternatives",
            evidence: [{ handle: h.checkout, quote: CHECKOUT_QUOTE }],
          },
          company("adyen.com", h.adyen, ADYEN_QUOTE),
        ],
        edges: [],
      },
      {} as never,
    )

    const out = await t.remember.execute!(
      {
        nodes: [],
        edges: [
          {
            from: "checkout",
            to: "adyen.com",
            relation: "competitor",
            whyHere: "both process payments for the same online businesses",
            howFound: "API-first payment gateway alternatives",
            evidence: [{ handle: h.adyen, quote: ADYEN_QUOTE }],
          },
        ],
      },
      {} as never,
    )

    expect(out.written.edges).toBe(0)
    expect(c.graph.edges).toHaveLength(0)
    expect(out.rejected).toHaveLength(1)
    // Both candidates are named, so the model can pick the one it meant.
    expect(out.rejected[0]).toContain("company:checkout")
    expect(out.rejected[0]).toContain("capability:checkout")
  })

  it("regression, the live stripe.com run: bare-domain endpoints connect the graph rather than dangling", async () => {
    const c = ctx()
    const t = makeTools(c)
    const h = await pages(t)

    // The anchor is on the map before the agent writes anything, exactly as investigate() puts it there.
    const seed = anchorNode("stripe.com")
    c.graph.nodes.set(seed.id, seed)

    // The two nodes that run really produced, minted as `company:<domain>`...
    // ...and the edge written the way that run's model really wrote it: bare domains.
    const out = await t.remember.execute!(
      {
        nodes: [company("adyen.com", h.adyen, ADYEN_QUOTE), company("checkout.com", h.checkout, CHECKOUT_QUOTE)],
        edges: [
          {
            from: "stripe.com",
            to: "checkout.com",
            relation: "competitor",
            whyHere: "a primary competitor in global payment processing",
            howFound: "API-first payment gateway alternatives to Stripe",
            evidence: [{ handle: h.checkout, quote: CHECKOUT_QUOTE }],
          },
        ],
      },
      {} as never,
    )

    expect(out.rejected).toHaveLength(0)
    expect(out.written.edges).toBe(1)
    expect(c.graph.edges[0]!.from).toBe("company:stripe.com")
    expect(c.graph.edges[0]!.to).toBe("company:checkout.com")

    // The whole point of the fix: no endpoint anywhere on the graph points at nothing.
    for (const e of c.graph.edges) {
      expect(c.graph.nodes.has(e.from)).toBe(true)
      expect(c.graph.nodes.has(e.to)).toBe(true)
    }
  })
})

describe("remember, rejections in the span", () => {
  it("puts the rejection reason in the span's error, naming the claim that failed", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!

    await t.remember.execute!(
      {
        nodes: [
          {
            kind: "company", name: "Ghost Co", what: "raised $50M last year",
            whyHere: "competitor", howFound: "anti-bot bypass api",
            evidence: [{ handle, quote: "Ghost Co raised $50M in Series B" }],
          },
        ],
        edges: [],
      },
      {} as never,
    )

    const span = (await drainSpans(c)).find((s) => s.kind === "remember")!
    expect(span.ok).toBe(false)
    // The live run logged eleven of these with an empty error field: eleven refusals,
    // no reason recorded anywhere. Reading the log must be enough to know why.
    expect(span.error).toBeTruthy()
    expect(span.error).toContain("Ghost Co")
    expect(span.error).toContain("quote not present")
  })

  it("summarises many rejections without losing the name of any failing claim", async () => {
    const c = ctx()
    const t = makeTools(c)
    const f = await t.fetch.execute!({ urls: ["https://rival.com"], mode: "direct", why: "x" }, {} as never)
    const handle = f.results[0]!.handle!
    const names = ["Alpha Co", "Beta Co", "Gamma Co", "Delta Co", "Epsilon Co"]

    await t.remember.execute!(
      {
        nodes: names.map((name) => ({
          kind: "company" as const, name, what: "unprovable", whyHere: "competitor",
          howFound: "anti-bot bypass api",
          evidence: [{ handle, quote: `${name} raised $50M in Series B` }],
        })),
        edges: [],
      },
      {} as never,
    )

    const span = (await drainSpans(c)).find((s) => s.kind === "remember")!
    expect(span.ok).toBe(false)
    expect(span.error).toContain("5")
    for (const name of names) expect(span.error).toContain(name)
  })
})
