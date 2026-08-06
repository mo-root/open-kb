import { describe, expect, it } from "vitest"
import { exportKbFiles, slugOf } from "../src/export-kb.js"

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
      name: "Ghost Host",
      domain: "ghost.example",
      kind: "unknown",
      relation: "unknown",
      because: "its front page could not be read this run (empty-body)",
      foundBy: ["Proxy Networks"],
    },
    { name: "Noise Row", domain: "noise.example", kind: "noise", relation: "none" },
    { name: "Reader", domain: "reader.example", kind: "publisher", relation: "covers", tier: "snippet" },
  ],
  edges: [{ from: "oxylabs.io", to: "brightdata.com", relation: "competitor", confidence: "inferred" }],
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
    expect(get("entities/ghost-example.md")).toContain("Downgraded:")
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
    const bare = exportKbFiles({ entities: [{ name: "X", domain: "x.example", kind: "company", relation: "competitor" }] })
    expect(bare.find((f) => f.path === "README.md")?.content).toContain("No report block")
    expect(bare.find((f) => f.path === "evidence/receipts.md")?.content).toContain("predates span receipts")
    expect(bare.find((f) => f.path === "segments/unattributed.md")?.content).toContain("[[x-example]]")
  })
})

describe("slugOf", () => {
  it("keys on domain when present, kind:name otherwise", () => {
    expect(slugOf({ name: "Oxylabs", domain: "oxylabs.io", kind: "company" })).toBe("oxylabs-io")
    expect(slugOf({ name: "Data Teams", kind: "buyer" })).toBe("buyer-data-teams")
  })
})
