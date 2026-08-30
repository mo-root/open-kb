import { describe, expect, it } from "vitest"
import { exportDrop, exportKbFiles, receiptSource, slugOf, withoutStolenNames } from "../src/export-kb.js"
import type { ExportEntity } from "../src/export-kb.js"

/** A tiered run (the swarm shape): every kept row carries a provenance tier, so
 *  the export is allowed to explain what a tier is. Also carries one row per
 *  export gate, and an edge into a gated row. */
const run = {
  anchor: "brightdata.com",
  decomposition: { sells: "Proxies and scraping APIs.", buyer: "data teams" },
  entities: [
    {
      name: "Oxylabs",
      domain: "oxylabs.io",
      kind: "company",
      relation: "competitor",
      what: "An enterprise proxy provider.",
      why: "Sells the same lineup to the same buyer.",
      tier: "own-page",
      descGrounded: 0.82,
      spans: ["175M+ ethically sourced IPs"],
      foundBy: ["Proxy Networks", "Web Scraping APIs"],
    },
    {
      name: "Bright Data",
      domain: "brightdata.com",
      kind: "company",
      relation: "shaper",
      what: "The anchor.",
      why: "It defines the segment.",
      tier: "own-page",
    },
    {
      name: "Watering Hole",
      domain: "hole.example",
      kind: "community",
      relation: "discusses",
      what: "A forum for scraping engineers.",
      why: "Buyers compare vendors here.",
      tier: "page",
    },
    {
      name: "Maybe Rival",
      domain: "maybe.example",
      kind: "company",
      relation: "unknown",
      what: "A data vendor of some kind.",
      why: "The page names the same buyer but never says what it sells.",
      because: "its front page could not be read this run (empty-body)",
      tier: "snippet",
      foundBy: ["Proxy Networks"],
    },
    // One per gate, in exportDrop's own order.
    { name: "Noise Row", domain: "noise.example", kind: "noise", relation: "none" },
    { name: "Silent Row", domain: "silent.example", kind: "unknown", relation: "unknown", because: "http-403" },
    {
      name: "Unrelated Row",
      domain: "unrelated.example",
      kind: "company",
      relation: "none",
      what: "A veterinary practice.",
      why: "It is unrelated to the proxy market.",
      tier: "page",
    },
    {
      name: "Reader",
      domain: "reader.example",
      kind: "publisher",
      relation: "covers",
      what: "A trade publication.",
      why: "It writes about this market.",
      tier: "snippet",
    },
    {
      name: "A Developer",
      domain: "adeveloper.example",
      kind: "publisher",
      relation: "discusses",
      what: "A personal blog publishing notes on scraping.",
      why: "The author posts about proxy tooling.",
      tier: "page",
    },
    {
      name: "Unexplained",
      domain: "unexplained.example",
      kind: "unknown",
      relation: "unknown",
      what: "A company.",
      why: "Something was found.",
      tier: "snippet",
    },
  ],
  edges: [
    { from: "oxylabs.io", to: "brightdata.com", relation: "competitor", confidence: "inferred" },
    { from: "oxylabs.io", to: "reader.example", relation: "covers", confidence: "measured" },
  ],
  report: {
    usd: 5.15,
    seconds: 4195,
    recall: { pooled: 0.4, probes: [{}], aliasExclusion: { hosts: ["brightdata.es"], note: "the rise is a bug fix in the instrument, not a coverage improvement" } },
    scorecard: { gate: { refusals: 1, objections: ["9 of 16 planned families have zero page-tier nodes"] } },
  },
}

describe("exportKbFiles", () => {
  const files = exportKbFiles(run)
  const get = (p: string) => files.find((f) => f.path === p)?.content ?? ""

  it("writes one entity note per kept entity, none for noise", () => {
    expect(get("entities/oxylabs-io.md")).toContain("# Oxylabs")
    expect(get("entities/maybe-example.md")).toContain("Downgraded:")
    expect(files.some((f) => f.path.includes("noise-example"))).toBe(false)
  })

  it("frontmatter carries the index fields and the receipt rides the note", () => {
    const note = get("entities/oxylabs-io.md")
    expect(note).toContain("relation: competitor")
    expect(note).toContain("tier: own-page")
    expect(note).toContain("descGrounded: 0.82")
    expect(note).toContain("> 175M+ ethically sourced IPs")
  })

  it("edges become wikilinks and inferred confidence is marked", () => {
    const note = get("entities/oxylabs-io.md")
    expect(note).toContain("[[brightdata-com]]")
    expect(note).toContain("*(inferred)*")
  })

  it("unknown.md frames refusals as refusals with their because", () => {
    const rel = get("relations/unknown.md")
    expect(rel).toContain("refusals, not absences")
    expect(rel).toContain("empty-body")
  })

  it("segments come from provenance and straddlers name their other lanes", () => {
    const seg = get("segments/proxy-networks.md")
    expect(seg).toContain("[[oxylabs-io]]")
    expect(seg).toContain("also: Web Scraping APIs")
  })

  it("README carries the health block, the alias honesty note, and the gate exchange", () => {
    const readme = get("README.md")
    expect(readme).toContain("$5.15")
    expect(readme).toContain("bug fix in the instrument")
    expect(readme).toContain("refused 1 time(s)")
    expect(readme).toContain("9 of 16 planned families")
  })

  it("manifest lists every file and every entity key", () => {
    const manifest = JSON.parse(get("manifest.json"))
    expect(manifest.entities.map((e: { key: string }) => e.key)).toContain("oxylabs-io")
    for (const f of files) expect(manifest.files).toContain(f.path)
  })

  /**
   * The invariant `scripts/export-kb.ts`'s lake INDEX now depends on: a
   * folder's entity count is the number of pages in it, and re-deriving it
   * from the run's non-noise rows gives a DIFFERENT, larger number. The INDEX
   * used to re-derive it that way and overstated every one of the twelve maps
   * in demo/ — clerk 445 against 197 pages, supabase 1478 against 541 — because
   * `noise` is one of seven gates and it was subtracting only that one.
   */
  it("the README's count is the number of pages, not the number of non-noise rows", () => {
    const pages = files.filter((f) => f.path.startsWith("entities/")).length
    const stated = Number(/^(\d+) entities:/m.exec(get("README.md"))?.[1])
    const nonNoise = run.entities.filter((e) => e.kind !== "noise").length
    expect(stated).toBe(pages)
    expect(nonNoise).toBeGreaterThan(pages)
  })

  it("is deterministic: same run, same bytes", () => {
    const again = exportKbFiles(run)
    expect(again).toEqual(files)
  })

  it("tolerates a kernel-era run with no report, spans, or foundBy", () => {
    const bare = exportKbFiles({ entities: [{ name: "X", domain: "x.example", kind: "company", relation: "competitor", what: "A rival." }] })
    expect(bare.find((f) => f.path === "README.md")?.content).toContain("No report block")
    expect(bare.find((f) => f.path === "segments/unattributed.md")?.content).toContain("[[x-example]]")
  })
})

/**
 * The export gates. Each drops a row on a verdict the run already reached, so
 * the folder can still claim a machine wrote every sentence in it — nothing
 * here rewrites a description, and a row either ships whole or not at all.
 */
describe("what leaves the app is the map, not the crawl", () => {
  const files = exportKbFiles(run)
  const get = (p: string) => files.find((f) => f.path === p)?.content ?? ""
  const has = (slug: string) => files.some((f) => f.path === `entities/${slug}.md`)

  const byHost = (h: string) => run.entities.find((e) => e.domain === h)!

  it("names a reason for every row it drops, and keeps the rest", () => {
    expect(exportDrop(byHost("noise.example"))).toBe("noise")
    expect(exportDrop(byHost("silent.example"))).toBe("silent")
    expect(exportDrop(byHost("unrelated.example"))).toBe("unrelated")
    expect(exportDrop(byHost("reader.example"))).toBe("commentary")
    expect(exportDrop(byHost("adeveloper.example"))).toBe("personal")
    expect(exportDrop(byHost("unexplained.example"))).toBe("unexplained")
    expect(exportDrop(byHost("oxylabs.io"))).toBeNull()
    expect(exportDrop(byHost("maybe.example"))).toBeNull()
  })

  // `withdrawn` is exportDrop's one gate this fixture's "one per gate" run
  // cannot cover: it only fires on a row `withoutStolenNames` has already
  // repaired (a stolen-name row turned into a bare host, `because: WITHDRAWN`),
  // which is a shape this file's `run` never carries. Untested until now —
  // confirmed with `grep -n "exportDrop"` across every test file before writing
  // this. The function's own doc comment calls out exactly the risk this closes:
  // "[withdrawn] reaches `silent`'s test... but it is not the same thing and
  // must not be counted as it" — silent's check (`!what && !why && !spans`) is
  // true of a withdrawn row too, since the repair clears all three, so this
  // pins that `withdrawn` is checked first in exportDrop's own ordering and
  // wins. Built from the real `withoutStolenNames` output, not a hand-copied
  // WITHDRAWN string, so a wording change to that constant cannot desync this.
  it("a name-stolen row reads as `withdrawn`, not `silent`, though it matches silent's own test too", () => {
    const repaired = withoutStolenNames<ExportEntity, never>({
      anchor: "stripe.com",
      entities: [{ name: "Stripe", domain: "aws.amazon.com", kind: "product", relation: "competitor", what: "x", why: "y" }],
    })
    const row = repaired.entities[0]!
    expect(row.what).toBe("")
    expect(row.why).toBe("")
    expect(row.spans).toBeUndefined()
    expect(exportDrop(row)).toBe("withdrawn")
  })

  it("gives no page to a row that could only say a named host refused us", () => {
    expect(has("silent-example")).toBe(false)
    for (const f of files) expect(f.content).not.toContain("http-403")
  })

  it("gives no page to a host the run itself placed in no relation", () => {
    expect(has("unrelated-example")).toBe(false)
    expect(files.some((f) => f.path === "relations/none.md")).toBe(false)
  })

  it("gives no page to an entity that merely publishes near the market", () => {
    expect(has("reader-example")).toBe(false)
    expect(files.some((f) => f.path === "relations/covers.md")).toBe(false)
  })

  it("gives no page to a personal site, whatever relation the run gave it", () => {
    expect(has("adeveloper-example")).toBe(false)
    expect(exportDrop({ name: "n", domain: "someone.medium.com", kind: "publisher", relation: "competitor", what: "A vendor." })).toBe("personal")
    expect(exportDrop({ name: "n", domain: "medium.com", kind: "publisher", relation: "lists", what: "A publishing platform." })).toBeNull()
  })

  it("gives no page to a refusal that does not wear its reason", () => {
    expect(has("unexplained-example")).toBe(false)
    expect(has("maybe-example")).toBe(true)
  })

  it("counts the gated hosts in run health and names none of them", () => {
    const readme = get("README.md")
    expect(readme).toContain("6 host(s) surfaced and did not make the map")
    expect(readme).toContain("unreadable this run")
    for (const host of ["noise.example", "silent.example", "unrelated.example", "reader.example", "adeveloper.example", "unexplained.example"])
      expect(readme).not.toContain(host)
  })

  it("prunes an edge whose other end was gated, so no wikilink dangles", () => {
    expect(get("entities/oxylabs-io.md")).not.toContain("[[reader-example]]")
    const slugs = new Set(files.filter((f) => f.path.startsWith("entities/")).map((f) => f.path.slice(9, -3)))
    for (const f of files) {
      for (const m of f.content.matchAll(/\[\[([^\]]+)\]\]/g)) expect(slugs).toContain(m[1])
    }
  })

  it("ships no bulk quote corpus — a receipt lives beside the claim it grounds", () => {
    expect(files.some((f) => f.path.startsWith("evidence/"))).toBe(false)
    expect(get("entities/oxylabs-io.md")).toContain("> 175M+ ethically sourced IPs")
  })
})

/** A run with no tier on any row — the sweep shape. The folder must not explain
 *  a field none of its rows carries. */
describe("an untiered run says nothing about tiers", () => {
  const untiered = {
    anchor: "clerk.com",
    entities: [
      { name: "Auth0", domain: "auth0.com", kind: "product", relation: "competitor", what: "An auth platform.", why: "Same buyer.", spans: ["adaptable authentication"] },
      { name: "A Forum", domain: "forum.example", kind: "community", relation: "discusses", what: "A forum.", why: "Buyers argue here." },
    ],
  }
  const files = exportKbFiles(untiered)
  const get = (p: string) => files.find((f) => f.path === p)?.content ?? ""

  it("drops the tier bullet from AGENTS.md and the trust rules from SKILL.md", () => {
    expect(get("AGENTS.md")).not.toContain("tier")
    expect(get("SKILL.md")).not.toContain("own-page > page > snippet")
    // The untiered trust rule used to say the lists are "alphabetical, not
    // ranked" and to weight a row by its receipts "not its position". Once
    // relation lists learned to sort by how many queries surfaced each host,
    // that told a reader to ignore the only ranking the file has. What the
    // test pins is the INTENT — say nothing about tiers, say what the order
    // actually is — rather than the sentence that carried it.
    expect(get("SKILL.md")).not.toContain("tier")
    expect(get("SKILL.md")).toContain("ordered by how many distinct queries surfaced each host")
  })

  it("does not tell an agent to grep a frontmatter field no note has", () => {
    expect(get("SKILL.md")).toContain("(`relation:`, `segment:`)")
    expect(get("entities/auth0-com.md")).not.toContain("tier:")
    expect(get("entities/auth0-com.md")).toContain("**Route:** surfaced by this run's queries → competitor to clerk.com.")
  })

  it("does not claim a receipt came from the page when the page would not open", () => {
    /**
     * A host whose front page is walled is judged from the titles and
     * descriptions of the search results, and its spans are verified against
     * THAT text. The header said "verbatim from its page this run" anyway, two
     * lines under a `Downgraded:` line saying the page could not be read.
     * Measured: 165 of 1,215 kept rows on a shopify export, 131 of them
     * snippet-judged.
     */
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [
        {
          name: "Walled", domain: "walled.example", kind: "publisher", relation: "lists",
          what: "A directory.", why: "It enumerates vendors.",
          because: "its front page could not be read this run (http-403); judged from the search results that surfaced it",
          spans: ["the best auth platforms"],
        },
        {
          name: "Rescued", domain: "rescued.example", kind: "company", relation: "competitor",
          what: "A rival.", why: "Same buyer.",
          because: "its front page could not be read this run (http-403); second look at https://rescued.example/pricing",
          spans: ["priced per active user"],
        },
        {
          name: "Read", domain: "read.example", kind: "company", relation: "competitor",
          what: "A rival.", why: "Same buyer.", spans: ["we sell authentication"],
        },
      ],
    })
    const get = (p: string) => files.find((f) => f.path === p)?.content ?? ""
    expect(get("entities/walled-example.md")).toContain("the search results that surfaced it")
    expect(get("entities/walled-example.md")).not.toContain("verbatim from its page this run")
    // A second look DID reach a page — just not the front door.
    expect(get("entities/rescued-example.md")).toContain("the page a second look reached")
    // And a host that was simply read still says so.
    expect(get("entities/read-example.md")).toContain("verbatim from its page this run")
  })

  it("does not count the refusals among the entities with cited relations", () => {
    /**
     * An `unknown` row is this export's word for "the run would not say" — the
     * relation is withheld and the `why` blanked, which is why
     * relations/unknown.md opens "refusals, not absences". llms.txt counted
     * them anyway: on a real shopify export, 103 of 1,106 rows.
     */
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [
        { name: "Auth0", domain: "auth0.com", kind: "product", relation: "competitor", what: "An auth platform.", why: "Same buyer." },
        { name: "Walled", domain: "walled.example", kind: "company", relation: "unknown", what: "A vendor of some kind.", because: "its front page could not be read this run (http-403)" },
      ],
    })
    const llms = files.find((f) => f.path === "llms.txt")?.content ?? ""
    expect(llms).toContain("2 entities: 1 with cited")
    expect(llms).toContain("1 the run refused to place")
  })

  it("says how an untiered list is ordered, and does not claim tiers it has none of", () => {
    expect(get("relations/competitor.md")).toContain("Ordered by how many distinct queries surfaced each host")
    expect(get("relations/competitor.md")).not.toContain("(untiered)")
    expect(get("llms.txt")).not.toContain("evidence-tiered")
  })

  it("puts the most-surfaced rival first, not the alphabetically first", () => {
    /**
     * `tier` is a swarm concept the sweep never sets, so every sweep-exported
     * map fell through to the slug and `relations/competitor.md` — the file
     * the README calls "the rivals" — was alphabetical. On a real shopify run
     * that opened activecampaign, adyen, altfunding, anchanto, arirms… with
     * Stripe forty rows down, out of 236.
     */
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [
        // Alphabetically first, barely corroborated.
        { name: "Aardvark", domain: "aardvark.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", seenIn: 1 },
        // Alphabetically last, the one the market actually points at.
        { name: "Zebra", domain: "zebra.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", seenIn: 19 },
      ],
    })
    const list = files.find((f) => f.path === "relations/competitor.md")?.content ?? ""
    expect(list.indexOf("zebra-example")).toBeLessThan(list.indexOf("aardvark-example"))
  })

  it("keeps the tier prose when the run does carry tiers", () => {
    const tiered = exportKbFiles(run)
    const skill = tiered.find((f) => f.path === "SKILL.md")?.content ?? ""
    expect(skill).toContain("own-page > page > snippet")
    expect(tiered.find((f) => f.path === "AGENTS.md")?.content).toContain("**tier** is where the evidence came from")
  })

})

describe("a tiered relation list sorts by tier first, ahead of seenIn", () => {
  it("orders own-page before page before snippet, even against a higher seenIn", () => {
    /**
     * `relations/*.md` heads a tiered list with "Ordered by evidence tier,
     * strongest first," but every fixture in this file that carries mixed
     * tiers puts one entity per relation, and every fixture with more than
     * one same-relation entity leaves tier unset (the seenIn tie-break
     * tests above, in "an untiered run says nothing about tiers"). Grepped
     * this file for "Ordered by evidence tier" and "strongest first" before
     * this test: no match — tierSort's own tier-first key had never been
     * exercised, only its seenIn/slug tie-breaks. The snippet row here
     * carries the highest seenIn of the three, so a regression that sorted
     * by seenIn ahead of tier (or a typo that priced tiers the other way
     * round, own-page ranking after snippet) would still pass every other
     * test in this file.
     */
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [
        { name: "Gamma", domain: "gamma-snippet.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", tier: "snippet", seenIn: 50 },
        { name: "Alpha", domain: "alpha-own.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", tier: "own-page", seenIn: 1 },
        { name: "Beta", domain: "beta-page.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", tier: "page", seenIn: 1 },
      ],
    })
    const list = files.find((f) => f.path === "relations/competitor.md")?.content ?? ""
    expect(list).toContain("Ordered by evidence tier, strongest first.")
    const iOwn = list.indexOf("alpha-own-example")
    const iPage = list.indexOf("beta-page-example")
    const iSnippet = list.indexOf("gamma-snippet-example")
    expect(iOwn).toBeGreaterThan(-1)
    expect(iPage).toBeGreaterThan(-1)
    expect(iSnippet).toBeGreaterThan(-1)
    expect(iOwn).toBeLessThan(iPage)
    expect(iPage).toBeLessThan(iSnippet)
  })
})

describe("a segment says its own shape", () => {
  it("carries the relation split, because the biggest lane is a third to two thirds of the map", () => {
    /**
     * Measured across four anchors: the largest segment holds 43% on shopify,
     * 37% cloudflare, 33% openai and 60% on stripe — whose payments lane is
     * 672 rows. "N entities, M straddling" says nothing about a file that
     * long, and the relation counts are the one cut it does not already carry.
     */
    const row = (slug: string, relation: string) => ({
      name: slug, domain: `${slug}.example`, kind: "company", relation,
      what: "A thing.", why: "Because.", foundBy: ["Payments"],
    })
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [row("a", "competitor"), row("b", "adjacent"), row("c", "adjacent"), row("d", "lists")],
    })
    const seg = files.find((f) => f.path === "segments/payments.md")?.content ?? ""
    expect(seg).toContain("4 entities, 0 straddling other segments.")
    // Most-common relation first, so the line reads as the shape of the lane.
    expect(seg).toContain("adjacent 2 · competitor 1 · lists 1.")
  })
})

describe("the manifest carries the ranking the relation lists use", () => {
  it("emits seenIn where the run recorded it, so both access paths agree", () => {
    /**
     * SKILL.md sends a human to relations/competitor.md, now ordered by
     * `seenIn`, and an agent to manifest.json for "programmatic access". The
     * manifest carried no ranking at all, so the two paths into one map gave
     * different answers about which rivals matter.
     */
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [
        { name: "Aardvark", domain: "aardvark.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", seenIn: 1 },
        { name: "Zebra", domain: "zebra.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer.", seenIn: 19 },
      ],
    })
    const manifest = JSON.parse(files.find((f) => f.path === "manifest.json")?.content ?? "{}")
    const by = Object.fromEntries(manifest.entities.map((e: { key: string; seenIn?: number }) => [e.key, e.seenIn]))
    expect(by["zebra-example"]).toBe(19)
    expect(by["aardvark-example"]).toBe(1)
    // The manifest itself stays key-sorted so a diff between two is readable;
    // the ranking travels as data, not as row order.
    const keys = manifest.entities.map((e: { key: string }) => e.key)
    expect(keys).toEqual([...keys].sort())
  })

  it("omits seenIn entirely on a map that never recorded it", () => {
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [{ name: "A", domain: "a.example", kind: "company", relation: "competitor", what: "A rival." }],
    })
    const manifest = JSON.parse(files.find((f) => f.path === "manifest.json")?.content ?? "{}")
    expect("seenIn" in manifest.entities[0]).toBe(false)
  })
})

describe("unknown.md hoists a reason its rows all share", () => {
  const withheld = (slug: string, rel: string) => ({
    name: slug, domain: `${slug}.example`, kind: "company", relation: "unknown",
    what: "A vendor of some kind.",
    because: `its front page could not be read this run (http-403), and the search results read as ${rel} — a call that the host's own page bears out less than 80% of the time, so the relation is withheld rather than guessed`,
  })

  it("lifts the shared tail to the heading and leaves what differs on the row", () => {
    /**
     * The snippet gate grew this file from ~10 rows to ~100, and every one
     * ended with the same thirty words. The two things that differ per row —
     * which relation was withheld, how the page failed — were buried mid
     * sentence.
     */
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [withheld("a", "competitor"), withheld("b", "adjacent"), withheld("c", "covers")],
    })
    const md = files.find((f) => f.path === "relations/unknown.md")?.content ?? ""
    expect(md).toContain("Most of these share one reason: a call that the host's own page bears out")
    // Said once, not once per row.
    expect(md.split("bears out less than 80%").length - 1).toBe(1)
    // And each row still carries its own two facts.
    expect(md).toContain("[[a-example]] — its front page could not be read this run (http-403), and the search results read as competitor")
    expect(md).toContain("read as adjacent")
    expect(md).toContain("read as covers")
  })

  it("leaves rows alone when they share nothing worth hoisting", () => {
    const files = exportKbFiles({
      anchor: "clerk.com",
      entities: [
        { name: "A", domain: "a.example", kind: "company", relation: "unknown", what: "x", because: "its front page links 40 distinct vendor domains" },
        { name: "B", domain: "b.example", kind: "company", relation: "unknown", what: "x", because: "nothing on its own site says it does this" },
        { name: "C", domain: "c.example", kind: "company", relation: "unknown", what: "x", because: "the page answered as another brand entirely" },
      ],
    })
    const md = files.find((f) => f.path === "relations/unknown.md")?.content ?? ""
    expect(md).not.toContain("Most of these share one reason")
    expect(md).toContain("its front page links 40 distinct vendor domains")
    expect(md).toContain("nothing on its own site says it does this")
  })
})

describe("receiptSource — which text a quote came from", () => {
  it("says the page when nothing downgraded the row", () => {
    expect(receiptSource(undefined)).toBe("its page this run")
  })

  it("says the search results when the page would not open", () => {
    expect(
      receiptSource("its front page could not be read this run (http-403); judged from the search results that surfaced it"),
    ).toContain("the search results that surfaced it")
  })

  it("says the second look's page, because that one IS a page", () => {
    expect(
      receiptSource("its front page could not be read this run (http-403); second look at https://x.example/pricing"),
    ).toBe("the page a second look reached")
  })

  it("falls back to the page for a `because` about something else entirely", () => {
    // A downgrade that says nothing about readability leaves the provenance
    // where it was — the row was read, it just did not survive a gate.
    expect(receiptSource("its front page links 40 distinct vendor domains")).toBe("its page this run")
  })
})

describe("slugOf", () => {
  it("keys on domain when present, kind:name otherwise", () => {
    expect(slugOf({ name: "Oxylabs", domain: "oxylabs.io", kind: "company" })).toBe("oxylabs-io")
    expect(slugOf({ name: "Data Teams", kind: "buyer" })).toBe("buyer-data-teams")
  })
})

describe("the agent door", () => {
  const files = exportKbFiles(run)
  const get = (p: string) => files.find((f) => f.path === p)?.content ?? ""

  it("ships a SKILL.md with real frontmatter, the recipes, and the trust rules", () => {
    const skill = get("SKILL.md")
    expect(skill).toMatch(/^---\nname: kb-brightdata-com\n/)
    expect(skill).toContain("Battlecard")
    expect(skill).toContain("relations/competitor.md")
    expect(skill).toContain("own-page > page > snippet")
    expect(skill).toContain("not proven")
  })

  it("speaks llms.txt at the root", () => {
    const llms = get("llms.txt")
    expect(llms).toMatch(/^# brightdata\.com market map/)
    expect(llms).toContain("[SKILL.md](SKILL.md)")
  })

  it("every entity note carries its route from lane to relation", () => {
    expect(get("entities/oxylabs-io.md")).toContain(
      "**Route:** surfaced by the Proxy Networks lane's de-branded queries → judged own-page → competitor to brightdata.com.",
    )
    expect(get("entities/x-example.md")).toBe("") // not in this fixture
  })

  it("counts in the skill body match the run", () => {
    expect(get("SKILL.md")).toContain("1 competitors here")
    expect(get("SKILL.md")).toContain("1 refusals here")
  })

  it("offers only the doors this run actually wrote", () => {
    // relations/buyer.md was advertised in every export and existed in almost none.
    const skill = get("SKILL.md")
    expect(skill).not.toContain("relations/buyer.md")
    expect(skill).toContain("`relations/discusses.md`")
    const noRivals = exportKbFiles({ entities: [{ name: "A Forum", domain: "f.example", kind: "community", relation: "discusses", what: "A forum.", why: "They argue." }] })
    const readme = noRivals.find((f) => f.path === "README.md")?.content ?? ""
    expect(readme).not.toContain("relations/competitor.md")
    expect(readme).not.toContain("relations/unknown.md")
  })
})

/**
 * A stored map that gave a stranger the anchor's name, on its way out of the
 * app. `withoutStolenNames` runs first inside `exportKbFiles`, so the vault and
 * the browser reach the same verdict; the rule itself is documented beside it.
 *
 * This was not theoretical. At the commit before this one,
 * `runs/exports/kb-sweep-vercel-com-202608062351/entities/aws-amazon-com.md`
 * opened `name: Vercel / domain: aws.amazon.com / kind: product / relation:
 * competitor` under the heading `# Vercel`, and 9 of the 14 such rows in the
 * committed maps cleared the gates above.
 */
describe("a name the stored map never owned", () => {
  const stolen = {
    anchor: "vercel.com",
    entities: [
      { name: "Vercel", domain: "aws.amazon.com", kind: "product", relation: "competitor", what: "Frontend hosting.", why: "It sells the same thing.", spans: ["deploy in seconds"], descGrounded: 0.28 },
      // The anchor reached another way, which the rule spares: its own host
      // spells the name.
      { name: "Vercel", domain: "vercel.fr", kind: "company", relation: "competitor", what: "Frontend hosting.", why: "The anchor's French site." },
      { name: "Neighbour", domain: "n.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same shortlist." },
    ],
    edges: [
      { from: "n.example", to: "aws.amazon.com", relation: "competitor", why: 'a page on n.example names "Vercel"', confidence: "measured" },
      { from: "aws.amazon.com", to: "n.example", relation: "competitor", why: 'a page on aws.amazon.com names "Neighbour"', confidence: "measured" },
    ],
  }

  it("ships no page under a name the run never settled", () => {
    const files = exportKbFiles(stolen)
    const get = (p: string) => files.find((f) => f.path === p)?.content ?? ""
    // Nothing left to say — no description, no reason, no receipt — so the
    // `silent` gate takes it, and no page in the vault is titled "Vercel".
    expect(get("entities/aws-amazon-com.md")).toBe("")
    // Gone from the manifest and the graph too, not merely from the pages.
    expect(files.filter((f) => f.content.includes("aws.amazon.com"))).toEqual([])
    // The look-alike keeps its name and its page.
    expect(get("entities/vercel-fr.md")).toContain("# Vercel")
    // And the edge bought with the stolen name is not a wikilink anywhere.
    expect(get("entities/n-example.md")).not.toContain("aws-amazon-com")
    expect(get("graph.json")).not.toContain('names \\"Vercel\\"')
  })

  it("declines on an anchor whose label is too short to identify anything", () => {
    // judge.ts's own floor: a one- or two-letter label matches names that have
    // nothing to do with the anchor, so the rule does not fire at all.
    const files = exportKbFiles({
      anchor: "x.com",
      entities: [{ name: "X", domain: "other.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer." }],
    })
    expect(files.find((f) => f.path === "entities/other-example.md")?.content ?? "").toContain("# X")
  })
})

/**
 * `withoutStolenNames` itself, not just `exportKbFiles`'s markdown around it.
 * Every existing case above drives it only through the rendered vault, so the
 * function's own return contract — `entities`, `edges`, and `stripped` — has
 * never been asserted directly, in either of its two callers: this file's
 * `exportKbFiles` (line 528) and `packages/web/lib/kb-from-run.ts`'s `place`
 * (line 404), which reads `.entities`/`.edges` and drops `.stripped` on the
 * floor — so `stripped`, the one field neither caller touches, had zero
 * coverage of any kind anywhere in the repo.
 */
describe("withoutStolenNames", () => {
  const anchor = "stripe.com" // label "stripe", 6 chars — well past the 3-char floor

  it("repairs a host wearing the anchor's name, and names it in stripped", () => {
    const result = withoutStolenNames({
      anchor,
      entities: [
        {
          name: "Stripe",
          domain: "aws.amazon.com",
          kind: "product",
          relation: "competitor",
          what: "Payments infrastructure.",
          why: "Sells the same thing.",
          spans: ["accept payments in minutes"],
          descGrounded: 0.6,
          descSpans: { verified: 1, claimed: 1 },
        },
      ],
    })
    expect(result.stripped).toEqual(["aws.amazon.com"])
    expect(result.entities).toEqual([
      {
        name: "aws.amazon.com",
        domain: "aws.amazon.com",
        kind: "unknown",
        relation: "unknown",
        what: "",
        why: "",
        because: "the stored map gave this host the anchor's own identity, so nothing it said about it stands",
        spans: undefined,
        descGrounded: undefined,
        descSpans: undefined,
      },
    ])
  })

  it("spares a host whose own name spells the anchor", () => {
    // "stripe.ie" -> identityKey "stripeie", which includes anchorLabel "stripe":
    // the anchor reached another way, not a theft.
    const result = withoutStolenNames({
      anchor,
      entities: [{ name: "Stripe", domain: "stripe.ie", kind: "company", relation: "competitor", what: "The anchor's Irish site.", why: "Same brand." }],
    })
    expect(result.stripped).toEqual([])
    expect(result.entities[0]?.name).toBe("Stripe")
  })

  it("leaves a nameless-host row untouched — no host, nothing to fall back to", () => {
    const result = withoutStolenNames({
      anchor,
      entities: [{ name: "Stripe", kind: "company", relation: "competitor", what: "No domain on this row." }],
    })
    expect(result.stripped).toEqual([])
    expect(result.entities[0]?.what).toBe("No domain on this row.")
  })

  it("only strips an edge whose why quotes the exact stolen name, into the stolen host", () => {
    const result = withoutStolenNames({
      anchor,
      entities: [
        { name: "Stripe", domain: "aws.amazon.com", kind: "product", relation: "competitor", what: "x", why: "y" },
        { name: "Neighbour", domain: "n.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same shortlist." },
      ],
      edges: [
        // Minted by the stolen name, `to` the stolen host: dropped.
        { from: "n.example", to: "aws.amazon.com", why: 'a page on n.example names "Stripe"' },
        // Touches the stolen host but was minted by a different name: kept.
        { from: "x.example", to: "aws.amazon.com", why: "a page on x.example discusses payments" },
        // `to` a different host entirely: kept regardless of wording.
        { from: "aws.amazon.com", to: "n.example", why: 'a page on aws.amazon.com names "Neighbour"' },
      ],
    })
    expect(result.edges).toEqual([
      { from: "x.example", to: "aws.amazon.com", why: "a page on x.example discusses payments" },
      { from: "aws.amazon.com", to: "n.example", why: 'a page on aws.amazon.com names "Neighbour"' },
    ])
  })

  it("declines below the 3-char floor, unchanged and with nothing stripped", () => {
    const entities = [{ name: "X", domain: "other.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same buyer." }]
    const result = withoutStolenNames({ anchor: "x.com", entities })
    expect(result.stripped).toEqual([])
    expect(result.entities).toEqual(entities)
  })

  it("defaults edges to an empty array when the run carries none", () => {
    const result = withoutStolenNames({ anchor, entities: [] })
    expect(result.edges).toEqual([])
  })
})

/**
 * The export's edge integrity, measured before it was fixed: 999 of a fresh
 * vercel map's 3,465 edges (28.8%) had exactly one exported end and rendered
 * NOWHERE — github.com's page simply never said it discusses runtime.news,
 * because the induced-subgraph cut deleted every edge touching a gated
 * entity. Borrowed from graphify's taxonomy: too weak to link is still too
 * real to delete.
 */
describe("an edge to a gated entity is labeled, never deleted", () => {
  const run = {
    anchor: "anchor.example",
    entities: [
      { name: "Kept", domain: "kept.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same shortlist." },
      // Gated as commentary: covers leaves the export by policy.
      { name: "Zine", domain: "zine.example", kind: "publisher", relation: "covers", what: "Writes about the market.", why: "Coverage." },
      // Gated as noise: not a finding at all.
      { name: "Trash", domain: "trash.example", kind: "noise", relation: "none", what: "", why: "" },
    ],
    edges: [
      { from: "kept.example", to: "zine.example", relation: "covers", why: "the zine reviews it", confidence: "measured" },
      { from: "kept.example", to: "trash.example", relation: "discusses", why: "a memory", confidence: "inferred" },
    ],
  }

  it("renders the policy-gated end as plain text wearing its drop label", () => {
    const files = exportKbFiles(run)
    const page = files.find((f) => f.path === "entities/kept-example.md")?.content ?? ""
    expect(page).toContain("**Edges:**")
    expect(page).toContain("covers zine.example")
    expect(page).toContain("publishing near the market")
    // No wikilink to a page that does not exist.
    expect(page).not.toContain("[[zine-example]]")
  })

  it("still deletes an edge whose end is tainted, not merely gated", () => {
    const files = exportKbFiles(run)
    const page = files.find((f) => f.path === "entities/kept-example.md")?.content ?? ""
    expect(page).not.toContain("trash.example")
  })

  it("prints the roads on a page whose entity carries them", () => {
    const files = exportKbFiles({
      anchor: "anchor.example",
      entities: [
        { name: "Kept", domain: "kept.example", kind: "company", relation: "competitor", what: "A rival.", why: "Same shortlist.", roads: ["log search", "grep alternatives"] },
      ],
    })
    const page = files.find((f) => f.path === "entities/kept-example.md")?.content ?? ""
    expect(page).toContain("**Found by:** `log search` · `grep alternatives`")
  })
})
