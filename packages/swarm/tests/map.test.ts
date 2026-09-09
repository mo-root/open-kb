import { describe, it, expect } from "vitest"
import { nodeKey, landedBy, MapState, type MapNode } from "../src/index.js"

/**
 * nodeKey is the one place a node's identity is minted (map.ts). No dedicated
 * coverage existed before this — every prior test reaches it only through
 * rememberTool with a bare-hostname domain, so the scheme-strip branch itself
 * was never exercised.
 */
describe("nodeKey", () => {
  it("strips a lowercase scheme before keying", () => {
    expect(nodeKey("company", "Example", "https://example.com")).toBe("example.com")
  })

  it("strips an uppercase or mixed-case scheme the same way — a model echoing a URL it just read keeps its capitals", () => {
    expect(nodeKey("company", "Example", "HTTPS://example.com")).toBe("example.com")
    expect(nodeKey("company", "Example", "Http://Example.com")).toBe("example.com")
  })

  it("a bare hostname needs no stripping at all", () => {
    expect(nodeKey("company", "Example", "example.com")).toBe("example.com")
  })

  // The doc comment above nodeKey in map.ts states a third outcome — "" when
  // the item cannot be keyed — but nothing exercised it: every call anywhere
  // in this repo (all four tools-free.ts sites, every fixture here) always
  // passes a non-blank name for a domain-less kind, so `name.trim() ? ... :
  // ""` at map.ts:164 only ever walked its truthy arm (coverage: 7/7 hits,
  // the `""` alternate at 0). A capability/buyer/community claim with a
  // blank or whitespace-only name and no domain is exactly the case the
  // comment describes, and it should still come back "" rather than mint
  // a garbage key like "capability:".
  it("a domain-less kind with a blank name cannot be keyed at all", () => {
    expect(nodeKey("capability", "", "")).toBe("")
    expect(nodeKey("capability", "   ", "")).toBe("")
  })

  // Untested until now: this module's own doc comment calls capability and
  // buyer "kinds without a domain", and every fixture in this repo agrees —
  // no `kind: "buyer"` or `kind: "capability"` node anywhere carries a real
  // domain — but nothing in the schema or the gate enforces that absence
  // (agent.ts's remember tool requires `domain: z.string()` on every kind
  // alike). A capability or buyer claim that arrives with a stray host-shaped
  // domain must still key on `kind:name-slug`, not fall into company/
  // product's host-identity space, or it would silently merge onto — and
  // potentially relabel the kind of — an unrelated node already keyed at
  // that host.
  it("capability and buyer ignore a stray domain and key on kind:name-slug regardless", () => {
    expect(nodeKey("capability", "Fraud scoring", "rival.com")).toBe("capability:fraud-scoring")
    expect(nodeKey("buyer", "SMB finance teams", "rival.com")).toBe("buyer:smb-finance-teams")
  })

  // Contrast case, pinning what the fix must NOT change: community is the
  // one domain-bearing kind the doc names ("community without a home" keys
  // on kind:name-slug, implying one WITH a home keys on that home) — every
  // `kind: "community"` fixture in tools-free.test.ts carries a real domain
  // and expects host-based merge, so community must keep falling into the
  // host branch exactly like company/product.
  it("community with a domain still keys on the bare host, unlike capability/buyer", () => {
    expect(nodeKey("community", "Rival's dev forum", "rival.com")).toBe("rival.com")
  })
})

/**
 * The constructor is the one place `MapState.anchor` is minted, and no
 * dedicated test existed for it: every fixture anywhere in this suite
 * constructs `new MapState("anchor.com")`, a domain registrableHost never
 * reduces to "". A domain that DOES — "www.", ".", "WWW." (registrableHost
 * strips exactly those to nothing, packages/core/src/url.ts) — never got
 * exercised here, so the class's own field could still come out "" despite
 * orchestrator.ts's `seedMission` and its own `runSwarm`-local `anchor`
 * already guarding the identical registrableHost(domain) read with
 * `|| domain`.
 */
describe("MapState constructor", () => {
  it("a domain that registrableHost reduces to empty falls back to the raw domain, not \"\"", () => {
    expect(new MapState("www.").anchor).toBe("www.")
    expect(new MapState(".").anchor).toBe(".")
    expect(new MapState("WWW.").anchor).toBe("WWW.")
  })

  it("a domain registrableHost can key is untouched by the fallback", () => {
    expect(new MapState("Anchor.com").anchor).toBe("anchor.com")
  })
})

/**
 * landedBy is the landing digest's only source: agent.ts:1192 feeds its
 * added/merged split straight into InvestigatorDigest, which the lead reads
 * to judge a mission. No dedicated test existed anywhere — every prior
 * exercise of it was incidental, through full runLead/runInvestigator
 * integration fixtures that never isolated the added-vs-merged split or the
 * retracted-node exclusion the doc comment above it calls out by name.
 */
describe("landedBy", () => {
  const node = (key: string, writer: string, extra: Partial<MapNode> = {}): MapNode => ({
    key,
    name: key,
    domain: key,
    kind: "company",
    what: "",
    relation: "unknown",
    why: "",
    tier: "page",
    evidence: [],
    also: [],
    contributions: [{ writer, tier: "page" }],
    ...extra,
  })

  it("an empty map yields nothing", () => {
    const map = new MapState("anchor.com")
    expect(landedBy(map, "lane-1", new Set())).toEqual({ added: [], merged: [] })
  })

  it("a node the writer touched that was not live before is added", () => {
    const map = new MapState("anchor.com")
    const n = node("new.com", "lane-1")
    map.nodes.set(n.key, n)
    const out = landedBy(map, "lane-1", new Set())
    expect(out.added).toEqual([n])
    expect(out.merged).toEqual([])
  })

  it("a node the writer touched that was already live is merged, not added", () => {
    const map = new MapState("anchor.com")
    const n = node("old.com", "lane-1")
    map.nodes.set(n.key, n)
    const out = landedBy(map, "lane-1", new Set(["old.com"]))
    expect(out.merged).toEqual([n])
    expect(out.added).toEqual([])
  })

  it("a node with no contribution from this writer counts for neither list", () => {
    const map = new MapState("anchor.com")
    const n = node("other.com", "lane-2")
    map.nodes.set(n.key, n)
    const out = landedBy(map, "lane-1", new Set())
    expect(out).toEqual({ added: [], merged: [] })
  })

  it("a retracted node counts for nobody, even one this writer's own contribution stamped", () => {
    const map = new MapState("anchor.com")
    const n = node("gone.com", "lane-1", { retracted: { why: "duplicate" } })
    map.nodes.set(n.key, n)
    const out = landedBy(map, "lane-1", new Set(["gone.com"]))
    expect(out).toEqual({ added: [], merged: [] })
  })

  it("splits a mixed set correctly, and other writers' contributions on the same node don't matter", () => {
    const map = new MapState("anchor.com")
    const found = node("found.com", "lane-1")
    const confirmed = node("confirmed.com", "lane-1", {
      contributions: [{ writer: "lead", tier: "snippet" }, { writer: "lane-1", tier: "page" }],
    })
    const untouched = node("untouched.com", "lane-2")
    map.nodes.set(found.key, found)
    map.nodes.set(confirmed.key, confirmed)
    map.nodes.set(untouched.key, untouched)
    const out = landedBy(map, "lane-1", new Set(["confirmed.com", "untouched.com"]))
    expect(out.added).toEqual([found])
    expect(out.merged).toEqual([confirmed])
  })
})

/**
 * entityEdges' domainOf (map.ts:207) reads `this.nodes.get(key)?.domain ||
 * key` — a fallback to the raw key when the endpoint has no node entry.
 * tools-free.ts's endpointOf lets an edge name the anchor itself
 * (`nodeKey("company", "anchor.com", "anchor.com")` mints the anchor's own
 * host, and endpointOnMap admits it via `key === this.anchor`) without ever
 * requiring a node claim for the anchor — a model draws "rival competes
 * with us" without first filing a claim about the site the whole map is
 * about. Every existing entityEdges() fixture (map.test.ts, tools-free.test)
 * only ever joins two claimed nodes, so the `|| key` arm had 0 hits in the
 * full-suite branch map (coverage-final.json branch id 35, columns 59-72)
 * while the left side ran every time.
 */
describe("MapState.entityEdges", () => {
  it("an edge naming the anchor with no node claim for it falls back to the anchor's own key as its domain", () => {
    const map = new MapState("anchor.com")
    const rival: MapNode = {
      key: "rival.com",
      name: "Acme",
      domain: "rival.com",
      kind: "company",
      what: "",
      relation: "competitor",
      why: "",
      tier: "page",
      evidence: [],
      also: [],
      contributions: [{ writer: "lane-1", tier: "page" }],
    }
    map.nodes.set(rival.key, rival)
    map.edges.push({ from: "rival.com", to: "anchor.com", relation: "competitor", why: "x", confidence: "measured", evidence: [] })
    expect(map.entityEdges()).toEqual([
      { from: "rival.com", to: "anchor.com", relation: "competitor", why: "x", confidence: "measured" },
    ])
  })
})
