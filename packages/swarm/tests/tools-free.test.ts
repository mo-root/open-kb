import { describe, it, expect } from "vitest"
import { Ledger, Board } from "@open-kb/core"
import {
  RunEvidence,
  MapState,
  readTool,
  recallTool,
  rememberTool,
  SLICE,
  type MapNode,
  type RememberCtx,
  type ReadCtx,
  type RecallCtx,
} from "../src/index.js"

// ── fixtures ─────────────────────────────────────────────────────────────────

const ledger = () => new Ledger(1.5) // spendable 1.35 after the finish reserve

/** A page on the rival's own site, long enough to be worth quoting. */
const RIVAL_TEXT =
  "Acme sells a scraping API to developers. Our platform helps engineering teams collect " +
  "structured web data at scale, handling proxies, rendering and retries automatically."

const RIVAL_RAW = `<html><body><h1>Acme Scraper</h1><p>${RIVAL_TEXT}</p><a href="/pricing">Pricing</a><a href="https://twitter.com/acme">tw</a></body></html>`

function seeded() {
  const evidence = new RunEvidence()
  const map = new MapState("anchor.com")
  const page = evidence.record({ url: "https://rival.com/", text: RIVAL_TEXT, raw: RIVAL_RAW, status: "found", tier: "page" })
  const snippet = evidence.record({
    url: "https://third.com/roundup",
    text: "Best scraping tools 2026\nAcme and anchor compared head to head on price and coverage",
    status: "found",
    tier: "snippet",
  })
  return { evidence, map, page, snippet }
}

const ctxOf = (s: ReturnType<typeof seeded>): RememberCtx => ({ map: s.map, evidence: s.evidence, ledger: ledger() })

// ── RunEvidence.cite ─────────────────────────────────────────────────────────

describe("RunEvidence cite-by-url", () => {
  it("proves against the page over the snippet when both exist for one url", () => {
    const evidence = new RunEvidence()
    evidence.record({ url: "https://a.com/", text: "the snippet words about a.com's product line", status: "found", tier: "snippet" })
    evidence.record({ url: "https://a.com/", text: "the full page words about the product line and more", status: "found", tier: "page" })
    const c = evidence.cite("https://a.com/", "full page words about the product")
    expect(c.ok).toBe(true)
    if (c.ok) expect(c.evidence.tier).toBe("page")
  })

  it("a url nobody fetched is a sentence, not a throw", () => {
    const s = seeded()
    const c = s.evidence.cite("https://never.com/", "any words at all here")
    expect(c).toMatchObject({ ok: false })
    if (!c.ok) expect(c.reason).toContain("nothing was fetched from https://never.com/")
  })

  it("surfaces the mint's own sentences verbatim", () => {
    const s = seeded()
    const notThere = s.evidence.cite("https://rival.com/", "words that appear nowhere on that page")
    if (notThere.ok) throw new Error("should not prove")
    expect(notThere.reason).toBe("quote not present in https://rival.com/")

    const tooShort = s.evidence.cite("https://rival.com/", "Acme")
    if (tooShort.ok) throw new Error("should not prove")
    expect(tooShort.reason).toBe("quote too short to prove anything (minimum 8 characters)")
  })
})

// ── read ─────────────────────────────────────────────────────────────────────

describe("readTool", () => {
  const rctx = (s: ReturnType<typeof seeded>): ReadCtx => ({ evidence: s.evidence, ledger: ledger() })

  it("a missing handle answers the exact sentence, with poolLeftUsd still on it", () => {
    const s = seeded()
    const r = readTool(rctx(s), { handle: "ev99" })
    expect(r).toMatchObject({ ok: false, reason: "no such handle in this run" })
    expect(r.poolLeftUsd).toBeCloseTo(1.35)
  })

  it("a blocked record explains itself instead of returning bytes", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://x.com/", text: "", status: "blocked", reason: "thin-render" })
    const r = readTool({ evidence, ledger: ledger() }, { handle: rec.handle })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("that page was blocked (thin-render); there is nothing to read")
  })

  it("slices text at 8KB by default and reports the true total", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://big.com/", text: "x".repeat(20_000), status: "found", tier: "page" })
    const r = readTool({ evidence, ledger: ledger() }, { handle: rec.handle })
    if (!r.ok) throw new Error(r.reason)
    expect(r.text.length).toBe(SLICE)
    expect(r.totalChars).toBe(20_000)
  })

  it("projects headings out of raw html", () => {
    const s = seeded()
    const r = readTool(rctx(s), { handle: s.page.handle, project: "headings" })
    if (!r.ok) throw new Error(r.reason)
    expect(r.text).toBe("# Acme Scraper")
  })

  it("projects links with anchor text, resolving relative hrefs against the page", () => {
    const s = seeded()
    const r = readTool(rctx(s), { handle: s.page.handle, project: "links" })
    if (!r.ok) throw new Error(r.reason)
    expect(r.text).toContain("https://rival.com/pricing — Pricing")
    expect(r.text).toContain("https://twitter.com/acme — tw")
  })

  it("grep keeps matching lines and counts them; range slices before the cap", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({
      url: "https://l.com/",
      text: "alpha one\nbeta two\nalpha three\ngamma four",
      status: "found",
      tier: "page",
    })
    const g = readTool({ evidence, ledger: ledger() }, { handle: rec.handle, grep: "alpha" })
    if (!g.ok) throw new Error(g.reason)
    expect(g.matches).toBe(2)
    expect(g.text).toBe("alpha one\nalpha three")

    const ranged = readTool({ evidence, ledger: ledger() }, { handle: rec.handle, range: { start: 6, end: 9 } })
    if (!ranged.ok) throw new Error(ranged.reason)
    expect(ranged.text).toBe("one")
    expect(ranged.totalChars).toBe(41)
  })

  it("a broken grep regex is treated as literal text rather than refused", () => {
    const evidence = new RunEvidence()
    const rec = evidence.record({ url: "https://l.com/", text: "price (usd\nother line", status: "found", tier: "page" })
    const r = readTool({ evidence, ledger: ledger() }, { handle: rec.handle, grep: "(usd" })
    if (!r.ok) throw new Error(r.reason)
    expect(r.text).toBe("price (usd")
  })
})

// ── recall ───────────────────────────────────────────────────────────────────

function populated() {
  const s = seeded()
  const ctx = ctxOf(s)
  rememberTool(ctx, {
    nodes: [
      {
        name: "Acme",
        domain: "rival.com",
        kind: "company",
        what: "scraping api",
        relation: "competitor",
        why: "sells the same collection job to the same engineering buyer, as its core product",
        evidence: [{ url: "https://rival.com/", quote: "sells a scraping API to developers" }],
      },
      {
        name: "Roundup",
        domain: "third.com",
        kind: "community",
        what: "comparison blog",
        relation: "covers",
        why: "thin",
        evidence: [{ url: "https://third.com/roundup", quote: "compared head to head" }],
      },
    ],
    edges: [
      {
        from: "third.com",
        to: "rival.com",
        relation: "covers",
        why: "the roundup ranks Acme",
        evidence: [{ url: "https://third.com/roundup", quote: "Acme and anchor compared head to head" }],
      },
    ],
    why: "seed the map",
  })
  return { ...s, ctx }
}

describe("recallTool", () => {
  const rctx = (s: ReturnType<typeof populated>, extra?: Partial<RecallCtx>): RecallCtx => ({
    map: s.map,
    evidence: s.evidence,
    ledger: ledger(),
    ...extra,
  })

  it("find matches on any text field and answers compact rows", () => {
    const s = populated()
    const r = recallTool(rctx(s), { op: "find", q: "scraping" })
    expect(r.rows.map((x) => x.key)).toContain("rival.com")
    expect(r.poolLeftUsd).toBeCloseTo(1.35)
  })

  it("neighbors answers the edges touching a key, naming the other end", () => {
    const s = populated()
    const r = recallTool(rctx(s), { op: "neighbors", key: "rival.com" })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ from: "third.com", to: "rival.com", relation: "covers" })
  })

  it("stats counts the live map", () => {
    const s = populated()
    const r = recallTool(rctx(s), { op: "stats" })
    expect(r.rows[0]).toMatchObject({ nodes: 2, edges: 1, retracted: 0 })
  })

  it("gaps surfaces single-sourced nodes and thin reasons", () => {
    const s = populated()
    const r = recallTool(rctx(s), { op: "gaps" })
    // Both nodes are single-sourced; the community's why is also thin.
    const thin = r.rows.find((x) => x.key === "third.com")
    expect(thin).toMatchObject({ thin: true })
    expect(r.rows.find((x) => x.key === "rival.com")).toBeDefined()
  })

  it("barren names terms searched twice that never produced a verified company", () => {
    const s = populated()
    const r = recallTool(
      rctx(s, {
        searches: [
          { query: "residential proxy pools", ok: true, urls: ["https://blog.nowhere.org/post"] },
          { query: "residential proxy pools", ok: true, urls: [] },
          { query: "scraping api pricing", ok: true, urls: ["https://docs.rival.com/pricing"] },
          { query: "scraping api pricing", ok: true, urls: [] },
          { query: "asked once only", ok: true, urls: [] },
        ],
      }),
      { op: "barren" },
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ term: "residential proxy pools", searches: 2 })
  })

  it("unread lists snippet-only urls nobody opened", () => {
    const s = populated()
    const r = recallTool(rctx(s), { op: "unread" })
    expect(r.rows.map((x) => x.url)).toEqual(["https://third.com/roundup"])
  })

  it("board reads the residue when a board is given, and answers empty rows when none is", () => {
    const s = populated()
    const board = new Board()
    board.push({ lens: "registries", brief: "who licenses this", why: "regulated market", priority: 80, tier: "peek", dedupeKey: "registries" }, "lead")
    const withBoard = recallTool(rctx(s, { board }), { op: "board" })
    expect(withBoard.rows[0]).toMatchObject({ priority: 80, tier: "peek", lens: "registries", unreviewed: false })
    const without = recallTool(rctx(s), { op: "board" })
    expect(without.rows).toEqual([])
  })
})

// ── remember ─────────────────────────────────────────────────────────────────

describe("rememberTool", () => {
  it("a proven claim lands as a sweep-shaped entity", () => {
    const s = populated()
    const rows = s.map.entities()
    const acme = rows.find((r) => r.domain === "rival.com")
    expect(acme).toMatchObject({ name: "Acme", kind: "company", relation: "competitor", what: "scraping api" })
    const edges = s.map.entityEdges()
    expect(edges).toEqual([
      { from: "third.com", to: "rival.com", relation: "covers", why: "the roundup ranks Acme", confidence: "measured" },
    ])
  })

  it("rejects a quote from a url nobody fetched, in a sentence", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), {
      nodes: [
        {
          name: "Ghost", domain: "ghost.com", kind: "company", what: "x", relation: "competitor",
          why: "made up", evidence: [{ url: "https://ghost.com/", quote: "we sell everything" }],
        },
      ],
      why: "test",
    })
    expect(r.added.nodes).toBe(0)
    expect(r.rejected[0]!.item).toBe('node "Ghost"')
    expect(r.rejected[0]!.reason).toContain("nothing was fetched from https://ghost.com/")
  })

  it("surfaces the mint's rejection verbatim when the quote is not a substring", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), {
      nodes: [
        {
          name: "Acme", domain: "rival.com", kind: "company", what: "x", relation: "competitor",
          why: "real host, fake quote", evidence: [{ url: "https://rival.com/", quote: "words never on the page" }],
        },
      ],
      why: "test",
    })
    expect(r.rejected[0]!.reason).toBe("quote not present in https://rival.com/")
  })

  it("stamps provenance: own-page beats page beats snippet", () => {
    const s = seeded()
    const ctx = ctxOf(s)
    // rival.com proven from its own page
    rememberTool(ctx, {
      nodes: [{
        name: "Acme", domain: "rival.com", kind: "company", what: "scraping api", relation: "competitor",
        why: "same job same buyer, sold standalone", evidence: [{ url: "https://rival.com/", quote: "sells a scraping API" }],
      }],
      why: "t",
    })
    // third.com proven only from a snippet
    rememberTool(ctx, {
      nodes: [{
        name: "Roundup", domain: "third.com", kind: "community", what: "blog", relation: "covers",
        why: "ranks the vendors in this market", evidence: [{ url: "https://third.com/roundup", quote: "compared head to head" }],
      }],
      why: "t",
    })
    expect(s.map.nodes.get("rival.com")!.tier).toBe("own-page")
    expect(s.map.nodes.get("third.com")!.tier).toBe("snippet")
  })

  it("keys identity on the registrable host: docs.apify.com merges into apify.com", () => {
    const evidence = new RunEvidence()
    const map = new MapState("anchor.com")
    const ctx: RememberCtx = { map, evidence, ledger: ledger() }
    evidence.record({ url: "https://docs.apify.com/x", text: "Apify is a web scraping and automation platform for developers", status: "found", tier: "page" })
    const first = rememberTool(ctx, {
      nodes: [{
        name: "Apify", domain: "apify.com", kind: "company", what: "scraping platform", relation: "competitor",
        why: "sells the same collection job to the same developer buyer",
        evidence: [{ url: "https://docs.apify.com/x", quote: "web scraping and automation platform" }],
      }],
      why: "t",
    })
    const second = rememberTool(ctx, {
      nodes: [{
        name: "Apify Docs", domain: "docs.apify.com", kind: "company", what: "docs portal", relation: "competitor",
        why: "same host seen again from its docs subdomain",
        evidence: [{ url: "https://docs.apify.com/x", quote: "automation platform for developers" }],
      }],
      why: "t",
    })
    expect(first.added.nodes).toBe(1)
    expect(second.added.nodes).toBe(0)
    expect(second.merged.nodes).toBe(1)
    expect(map.nodes.size).toBe(1)
    const node = map.nodes.get("apify.com")!
    expect(node.evidence).toHaveLength(2)
    expect(node.also).toContainEqual({ name: "Apify Docs", what: "docs portal" })
  })

  it("merge is commutative on key: either arrival order lands one node with both quotes", () => {
    const build = (order: "ab" | "ba") => {
      const evidence = new RunEvidence()
      const map = new MapState("anchor.com")
      const ctx: RememberCtx = { map, evidence, ledger: ledger() }
      evidence.record({ url: "https://x.com/a", text: "account one says x.com sells widgets to plumbers", status: "found", tier: "page" })
      evidence.record({ url: "https://y.com/b", text: "account two says x.com resells the anchor's own widgets", status: "found", tier: "page" })
      const a = {
        name: "X", domain: "x.com", kind: "company", what: "widgets", relation: "competitor" as const,
        why: "first angle on the company, from its own page",
        evidence: [{ url: "https://x.com/a", quote: "sells widgets to plumbers" }],
      }
      const b = {
        name: "X", domain: "x.com", kind: "company", what: "widget reseller", relation: "competitor" as const,
        why: "second angle, from a third party",
        evidence: [{ url: "https://y.com/b", quote: "resells the anchor's own widgets" }],
      }
      for (const n of order === "ab" ? [a, b] : [b, a]) rememberTool(ctx, { nodes: [n], why: "t" })
      return map.nodes.get("x.com")!
    }
    const ab = build("ab")
    const ba = build("ba")
    expect(ab.evidence).toHaveLength(2)
    expect(ba.evidence).toHaveLength(2)
    // The own-page account owns the scalars whichever order it arrived in.
    expect(ab.what).toBe("widgets")
    expect(ba.what).toBe("widgets")
    expect(ab.tier).toBe("own-page")
    expect(ba.tier).toBe("own-page")
  })

  it("merge commutes across the downgrade/recovery seam: both orders land the same node", () => {
    // The surviving fields of a merged node — everything a reader of the map
    // sees. Evidence compares as a set of URLs; arrival order may differ.
    const surviving = (n: MapNode) => ({
      name: n.name,
      kind: n.kind,
      what: n.what,
      relation: n.relation,
      why: n.why,
      because: n.because,
      tier: n.tier,
      also: n.also,
      urls: [...new Set(n.evidence.map((e) => e.url))].sort(),
    })

    type Account = {
      name: string; domain: string; kind: string; what: string; relation: string; why: string
      evidence: Array<{ url: string; quote: string }>
    }

    const bothOrders = (seed: (evidence: RunEvidence) => void, a: Account, b: Account, key: string) => {
      const run = (first: Account, second: Account) => {
        const evidence = new RunEvidence()
        const map = new MapState("anchor.com")
        const ctx: RememberCtx = { map, evidence, ledger: ledger() }
        seed(evidence)
        for (const n of [first, second]) {
          const r = rememberTool(ctx, { nodes: [n], why: "t" })
          expect(r.rejected).toEqual([])
        }
        return map.nodes.get(key)!
      }
      return { ab: run(a, b), ba: run(b, a) }
    }

    // A snippet naming h.com as a venue, and a third-party page calling it a vendor.
    const seed = (evidence: RunEvidence) => {
      evidence.record({
        url: "https://finder.com/list",
        text: "h.com gathers the scraping crowd weekly for tips and war stories",
        status: "found",
        tier: "snippet",
      })
      evidence.record({
        url: "https://press.com/story",
        text: "the story says h.com sells a scraping api to developers at scale",
        status: "found",
        tier: "page",
      })
    }
    const supportedWeaker: Account = {
      name: "H", domain: "h.com", kind: "community", what: "weekly roundup", relation: "covers",
      why: "a venue this market gathers in, seen in search",
      evidence: [{ url: "https://finder.com/list", quote: "gathers the scraping crowd weekly" }],
    }
    // A commercial claim with no page from h.com itself behind it: admit()
    // downgrades this to unknown + because, at the stronger page tier.
    const downgradedStronger: Account = {
      name: "H", domain: "h.com", kind: "company", what: "scraping api vendor", relation: "competitor",
      why: "a press story calls it a rival",
      evidence: [{ url: "https://press.com/story", quote: "sells a scraping api to developers" }],
    }

    // Pair 1 — the reviewer's repro: downgraded-stronger + supported-weaker.
    {
      const { ab, ba } = bothOrders(seed, downgradedStronger, supportedWeaker, "h.com")
      expect(surviving(ab)).toEqual(surviving(ba))
      // And concretely: the downgrade never outranks the supported claim.
      expect(ab.kind).toBe("community")
      expect(ab.relation).toBe("covers")
      expect(ab.because).toBeUndefined()
      expect(ab.tier).toBe("page")
    }

    // Pair 2 — supported-stronger + supported-weaker.
    {
      const seedOwn = (evidence: RunEvidence) => {
        seed(evidence)
        evidence.record({
          url: "https://h.com/",
          text: "h.com sells a scraping api to developers worldwide, on its own terms",
          status: "found",
          tier: "page",
        })
      }
      const supportedStronger: Account = {
        name: "H Corp", domain: "h.com", kind: "company", what: "scraping api", relation: "competitor",
        why: "same job, same buyer, in its own words",
        evidence: [{ url: "https://h.com/", quote: "sells a scraping api to developers worldwide" }],
      }
      const { ab, ba } = bothOrders(seedOwn, supportedStronger, supportedWeaker, "h.com")
      expect(surviving(ab)).toEqual(surviving(ba))
      expect(ab.relation).toBe("competitor")
      expect(ab.tier).toBe("own-page")
    }

    // Pair 3 — two downgraded accounts.
    {
      const downgradedWeaker: Account = {
        name: "H", domain: "h.com", kind: "company", what: "scraping shop", relation: "competitor",
        why: "the snippet made it sound like a vendor",
        evidence: [{ url: "https://finder.com/list", quote: "gathers the scraping crowd" }],
      }
      const { ab, ba } = bothOrders(seed, downgradedStronger, downgradedWeaker, "h.com")
      expect(surviving(ab)).toEqual(surviving(ba))
      expect(ab.relation).toBe("unknown")
      expect(ab.because).toBeDefined()
      expect(ab.tier).toBe("page")
    }
  })

  it("a stronger merge keeps the displaced name in also[], so a product folded into its host stays recoverable", () => {
    const build = (order: "company-first" | "product-first") => {
      const evidence = new RunEvidence()
      const map = new MapState("anchor.com")
      const ctx: RememberCtx = { map, evidence, ledger: ledger() }
      evidence.record({
        url: "https://brightdata.com/",
        text: "Bright Data operates a web data platform with proxies and unblocking for enterprises",
        status: "found",
        tier: "page",
      })
      evidence.record({
        url: "https://review.com/tools",
        text: "the review says Web Unlocker defeats bot detection on hard sites",
        status: "found",
        tier: "page",
      })
      const company = {
        name: "Bright Data", domain: "brightdata.com", kind: "company", what: "web data platform", relation: "competitor",
        why: "sells the same collection job to the same buyer",
        evidence: [{ url: "https://brightdata.com/", quote: "web data platform with proxies" }],
      }
      const product = {
        name: "Web Unlocker", domain: "brightdata.com", kind: "product", what: "unblocking product", relation: "competitor",
        why: "the product that overlaps the anchor's core",
        evidence: [{ url: "https://review.com/tools", quote: "defeats bot detection on hard sites" }],
      }
      for (const n of order === "company-first" ? [company, product] : [product, company]) {
        const r = rememberTool(ctx, { nodes: [n], why: "t" })
        expect(r.rejected).toEqual([])
      }
      return map.nodes.get("brightdata.com")!
    }
    for (const order of ["company-first", "product-first"] as const) {
      const node = build(order)
      // The own-page account owns the primary name; the folded product's name
      // survives beside its what instead of being overwritten away.
      expect(node.name).toBe("Bright Data")
      expect(node.also).toContainEqual({ name: "Web Unlocker", what: "unblocking product" })
    }
  })

  it("admit downgrades a commercial claim with no readable own page — landed, wearing its refusal", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), {
      nodes: [{
        name: "Roundup", domain: "third.com", kind: "company", what: "vendor?", relation: "competitor",
        why: "the snippet made it sound like a vendor",
        evidence: [{ url: "https://third.com/roundup", quote: "compared head to head" }],
      }],
      why: "t",
    })
    expect(r.added.nodes).toBe(1)
    const node = s.map.nodes.get("third.com")!
    expect(node.relation).toBe("unknown")
    expect(node.because).toContain("could not be read this run")
    // Never deleted: the entity row still ships, wearing the refusal.
    expect(s.map.entities().find((e) => e.domain === "third.com")).toMatchObject({ relation: "unknown" })
  })

  it("admit lets a commercial claim stand when the run read the host's own page", () => {
    const s = populated()
    expect(s.map.nodes.get("rival.com")!.relation).toBe("competitor")
    expect(s.map.nodes.get("rival.com")!.because).toBeUndefined()
  })

  it("with a threshold, a company whose own page enumerates vendors becomes a directory", () => {
    const evidence = new RunEvidence()
    const map = new MapState("anchor.com")
    const links = Array.from({ length: 15 }, (_, i) => `<a href="https://vendor${i}.com/">v${i}</a>`).join(" ")
    evidence.record({
      url: "https://listicle.com/",
      text: "The 15 best scraping vendors of 2026, ranked by price and coverage for busy buyers",
      raw: `<html><body><p>The 15 best scraping vendors of 2026.</p>${links}</body></html>`,
      status: "found",
      tier: "page",
    })
    const r = rememberTool({ map, evidence, ledger: ledger(), aggregatorThreshold: 12 }, {
      nodes: [{
        name: "Listicle", domain: "listicle.com", kind: "company", what: "vendor", relation: "competitor",
        why: "appeared in the market's search results",
        evidence: [{ url: "https://listicle.com/", quote: "best scraping vendors of 2026" }],
      }],
      why: "t",
    })
    expect(r.added.nodes).toBe(1)
    const node = map.nodes.get("listicle.com")!
    expect(node.kind).toBe("directory")
    expect(node.relation).toBe("lists")
    expect(node.because).toContain("15 distinct vendor domains")
  })

  it("refuses a kind or relation the skill does not teach, naming the accepted set", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), {
      nodes: [{
        name: "A", domain: "rival.com", kind: "publisher", what: "x", relation: "covers",
        why: "kind from the classifier's vocabulary, not the skill's",
        evidence: [{ url: "https://rival.com/", quote: "sells a scraping API" }],
      }],
      why: "t",
    })
    expect(r.rejected[0]!.reason).toContain('"publisher" is not a kind this map holds')
    expect(r.rejected[0]!.reason).toContain("company, product, capability, buyer, community")
  })

  it("refuses to re-record the anchor as a company", () => {
    const s = seeded()
    const anchorPage = s.evidence.record({ url: "https://anchor.com/", text: "anchor.com sells the thing this whole map is about, at scale", status: "found", tier: "page" })
    void anchorPage
    const r = rememberTool(ctxOf(s), {
      nodes: [{
        name: "Anchor", domain: "anchor.com", kind: "company", what: "itself", relation: "competitor",
        why: "found itself in its own results",
        evidence: [{ url: "https://anchor.com/", quote: "sells the thing this whole map is about" }],
      }],
      why: "t",
    })
    expect(r.added.nodes).toBe(0)
    expect(r.rejected[0]!.reason).toContain("that is the anchor")
  })

  it("an edge may name the anchor as an endpoint", () => {
    const s = populated()
    const r = rememberTool(s.ctx, {
      edges: [{ from: "rival.com", to: "anchor.com", relation: "competitor", why: "same shortlist, both ways" }],
      why: "t",
    })
    expect(r.added.edges).toBe(1)
    expect(r.rejected).toEqual([])
  })

  it("an edge to something not on the map is refused with the recovery spelled out", () => {
    const s = populated()
    const r = rememberTool(s.ctx, {
      edges: [{ from: "rival.com", to: "nowhere.io", relation: "integration", why: "guessing" }],
      why: "t",
    })
    expect(r.added.edges).toBe(0)
    expect(r.rejected[0]!.reason).toContain('"nowhere.io" is not on this map')
    expect(r.rejected[0]!.reason).toContain("nodes land before edges")
  })

  it("nodes land before edges inside one call, so a finding writes whole", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), {
      nodes: [{
        name: "Acme", domain: "rival.com", kind: "company", what: "scraping api", relation: "competitor",
        why: "same job, same buyer, standalone product",
        evidence: [{ url: "https://rival.com/", quote: "sells a scraping API" }],
      }],
      edges: [{ from: "rival.com", to: "anchor.com", relation: "competitor", why: "head to head" }],
      why: "one finding, nodes and relation together",
    })
    expect(r.added).toMatchObject({ nodes: 1, edges: 1 })
  })

  it("an edge without evidence is inferred; claiming measured without a quote is refused", () => {
    const s = populated()
    const inferred = rememberTool(s.ctx, {
      edges: [{ from: "rival.com", to: "anchor.com", relation: "substitute", why: "reasoned from what each sells" }],
      why: "t",
    })
    expect(inferred.added.edges).toBe(1)
    expect(s.map.edges.find((e) => e.relation === "substitute")!.confidence).toBe("inferred")

    const dishonest = rememberTool(s.ctx, {
      edges: [{ from: "rival.com", to: "anchor.com", relation: "shaper", why: "x", confidence: "measured" }],
      why: "t",
    })
    expect(dishonest.added.edges).toBe(0)
    expect(dishonest.rejected[0]!.reason).toContain("a measured edge cites a page")
  })

  it("the same edge claimed twice merges instead of duplicating", () => {
    const s = populated()
    const again = rememberTool(s.ctx, {
      edges: [{
        from: "third.com", to: "rival.com", relation: "covers", why: "seen again",
        evidence: [{ url: "https://third.com/roundup", quote: "compared head to head" }],
      }],
      why: "t",
    })
    expect(again.added.edges).toBe(0)
    expect(again.merged.edges).toBe(1)
    expect(s.map.entityEdges()).toHaveLength(1)
  })

  it("retract takes a node off the map with its why kept; retracting nothing is a sentence", () => {
    const s = populated()
    const r = rememberTool(s.ctx, {
      retract: [{ node: "third.com", why: "it is a roundup page, not a venue this market gathers in" }],
      why: "critic pass",
    })
    expect(r.added.retractions).toBe(1)
    expect(s.map.entities().find((e) => e.domain === "third.com")).toBeUndefined()
    expect(s.map.retractions[0]).toMatchObject({ target: "third.com" })
    // The retracted node's edges leave the render with it.
    expect(s.map.entityEdges()).toEqual([])

    const miss = rememberTool(s.ctx, { retract: [{ node: "ghost.com", why: "x" }], why: "t" })
    expect(miss.rejected[0]!.reason).toContain('nothing named "ghost.com" is on this map')
  })

  it("a claim with an empty evidence array is refused with the snippet route named", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), {
      nodes: [{ name: "A", domain: "a.com", kind: "company", what: "x", relation: "competitor", why: "y", evidence: [] }],
      why: "t",
    })
    expect(r.rejected[0]!.reason).toContain("at least one quote")
    expect(r.rejected[0]!.reason).toContain("snippet")
  })

  it("every remember return carries poolLeftUsd", () => {
    const s = seeded()
    const r = rememberTool(ctxOf(s), { why: "empty call" })
    expect(r.poolLeftUsd).toBeCloseTo(1.35)
  })
})
