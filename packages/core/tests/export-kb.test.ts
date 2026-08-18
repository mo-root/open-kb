import { describe, expect, it } from "vitest"
import { exportDrop, exportKbFiles, slugOf } from "../src/export-kb.js"

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
    expect(get("SKILL.md")).toContain("no evidence tiers")
  })

  it("does not tell an agent to grep a frontmatter field no note has", () => {
    expect(get("SKILL.md")).toContain("(`relation:`, `segment:`)")
    expect(get("entities/auth0-com.md")).not.toContain("tier:")
    expect(get("entities/auth0-com.md")).toContain("**Route:** surfaced by this run's queries → competitor to clerk.com.")
  })

  it("does not claim a relation list is ranked when it is alphabetical", () => {
    expect(get("relations/competitor.md")).toContain("Ordered by key")
    expect(get("relations/competitor.md")).not.toContain("(untiered)")
    expect(get("llms.txt")).not.toContain("evidence-tiered")
  })

  it("keeps the tier prose when the run does carry tiers", () => {
    const tiered = exportKbFiles(run)
    const skill = tiered.find((f) => f.path === "SKILL.md")?.content ?? ""
    expect(skill).toContain("own-page > page > snippet")
    expect(tiered.find((f) => f.path === "AGENTS.md")?.content).toContain("**tier** is where the evidence came from")
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
