/**
 * The knowledge lake, exported: a run becomes a folder of markdown a person
 * can read and an agent can walk. Wikilinks are the edges, frontmatter is the
 * index, and every claim ships beside its receipt — the same honesty rules as
 * the map, in a shape that leaves the app.
 *
 * Structural types, not imports (the drift.ts precedent): both engines'
 * run JSONs satisfy them, and core stays free of the sweep's vocabulary.
 * The export is a build artifact — regenerated, never hand-edited; a change
 * belongs upstream in the engine, so the folder always matches its run.
 */

export interface ExportEntity {
  name: string
  domain?: string
  kind: string
  relation: string
  what?: string
  why?: string
  because?: string
  tier?: string
  descGrounded?: number
  spans?: string[]
  foundBy?: string[]
  also?: Array<{ name?: string; what: string }>
}

export interface ExportEdge {
  from: string
  to: string
  relation: string
  why?: string
  confidence?: string
}

export interface ExportRunLike {
  anchor?: string
  entities: ExportEntity[]
  edges?: ExportEdge[]
  report?: {
    usd?: number
    seconds?: number
    kernel?: Record<string, unknown>
    recall?: { pooled?: number | null; probes?: unknown[]; aliasExclusion?: { hosts?: string[]; note?: string } }
    scorecard?: { gate?: { refusals?: number; objections?: string[] } }
    ending?: { reason?: string; humanReason?: string }
  }
  stats?: { usd?: number; seconds?: number }
  decomposition?: { sells?: string; buyer?: string }
}

export interface ExportedFile {
  path: string
  content: string
}

const TIER_RANK: Record<string, number> = { "own-page": 0, page: 1, snippet: 2 }

export function slugOf(e: Pick<ExportEntity, "name" | "domain" | "kind">): string {
  const base = (e.domain && e.domain.trim()) || `${e.kind}-${e.name}`
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function fm(pairs: Array<[string, unknown]>): string {
  const lines = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(String(v)).slice(1, -1)}`)
  return `---\n${lines.join("\n")}\n---\n`
}

function tierSort(a: ExportEntity, b: ExportEntity): number {
  const ta = TIER_RANK[a.tier ?? ""] ?? 3
  const tb = TIER_RANK[b.tier ?? ""] ?? 3
  return ta - tb || a.name.localeCompare(b.name)
}

function segmentOf(e: ExportEntity): string {
  return e.foundBy?.[0] ?? "unattributed"
}

/** Build every file of the export. Deterministic: same run, same bytes. */
export function exportKbFiles(run: ExportRunLike): ExportedFile[] {
  const anchor = run.anchor ?? "the anchor"
  const kept = run.entities.filter((e) => e.kind !== "noise")
  const bySlug = new Map<string, ExportEntity>()
  for (const e of kept) {
    const s = slugOf(e)
    if (!bySlug.has(s)) bySlug.set(s, e)
  }
  const edges = run.edges ?? []
  const edgesOf = (slug: string) =>
    edges.filter((ed) => slugifyRef(ed.from) === slug || slugifyRef(ed.to) === slug)
  const slugifyRef = (host: string) => host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

  const files: ExportedFile[] = []

  // entities/
  for (const [slug, e] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: string[] = []
    lines.push(
      fm([
        ["name", e.name],
        ["domain", e.domain],
        ["kind", e.kind],
        ["relation", e.relation],
        ["tier", e.tier],
        ["segment", segmentOf(e)],
        ["descGrounded", e.descGrounded],
      ]),
    )
    lines.push(`# ${e.name}\n`)
    if (e.what) lines.push(`${e.what}\n`)
    const lane = e.foundBy?.length
      ? `surfaced by the ${e.foundBy[0]} lane's de-branded queries`
      : `surfaced by this run's queries`
    lines.push(`**Route:** ${lane} → judged ${e.tier ?? "untiered"} → ${e.relation} to ${anchor}.\n`)
    if (e.why) lines.push(`**Why it's on the map:** ${e.why}\n`)
    if (e.because) lines.push(`**Downgraded:** ${e.because}\n`)
    if (e.spans?.length) {
      lines.push(`**Receipts** (verbatim from its page this run):\n`)
      for (const s of e.spans) lines.push(`> ${s}\n`)
    }
    if (e.also?.length) {
      lines.push(`**Also recorded here:** ${e.also.map((a) => (a.name ? `${a.name} — ${a.what}` : a.what)).join("; ")}\n`)
    }
    const myEdges = edgesOf(slug)
    if (myEdges.length) {
      lines.push(`**Edges:**\n`)
      for (const ed of myEdges) {
        const other = slugifyRef(ed.from) === slug ? ed.to : ed.from
        const dashed = ed.confidence === "inferred" ? " *(inferred)*" : ""
        lines.push(`- ${ed.relation} [[${slugifyRef(other)}]]${dashed}`)
      }
      lines.push("")
    }
    files.push({ path: `entities/${slug}.md`, content: lines.join("\n") })
  }

  // relations/
  const byRelation = new Map<string, ExportEntity[]>()
  for (const e of kept) {
    const list = byRelation.get(e.relation) ?? []
    list.push(e)
    byRelation.set(e.relation, list)
  }
  for (const [rel, list] of [...byRelation.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = [...list].sort(tierSort).map((e) => {
      const extra = e.relation === "unknown" && e.because ? ` — ${e.because}` : ""
      return `- [[${slugOf(e)}]] (${e.tier ?? "untiered"})${extra}`
    })
    const head =
      rel === "unknown"
        ? `# unknown\n\nThese are refusals, not absences: each claim failed an evidence bar and\nwears the reason. Resolving one means fetching better evidence, not deleting\nthe row.\n`
        : `# ${rel}\n\nOrdered by evidence tier, strongest first.\n`
    files.push({ path: `relations/${rel}.md`, content: `${head}\n${rows.join("\n")}\n` })
  }

  // segments/
  const bySegment = new Map<string, ExportEntity[]>()
  for (const e of kept) {
    const seg = segmentOf(e)
    const list = bySegment.get(seg) ?? []
    list.push(e)
    bySegment.set(seg, list)
  }
  for (const [seg, list] of [...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const straddlers = list.filter((e) => (e.foundBy?.length ?? 0) > 1)
    const rows = [...list].sort(tierSort).map((e) => {
      const lanes = (e.foundBy?.length ?? 0) > 1 ? ` *(also: ${e.foundBy!.slice(1).join(", ")})*` : ""
      return `- [[${slugOf(e)}]] — ${e.relation}${lanes}`
    })
    const slug = seg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unattributed"
    files.push({
      path: `segments/${slug}.md`,
      content: `# ${seg}\n\n${list.length} entities, ${straddlers.length} straddling other segments.\n\n${rows.join("\n")}\n`,
    })
  }

  // evidence/receipts.md
  const receiptRows = kept
    .filter((e) => e.spans?.length)
    .sort((a, b) => slugOf(a).localeCompare(slugOf(b)))
    .flatMap((e) => e.spans!.map((s) => `- [[${slugOf(e)}]]: "${s}"`))
  files.push({
    path: "evidence/receipts.md",
    content: `# Receipts\n\nEvery quote below was verified as a literal substring of the entity's own\npage as fetched this run. A quote proves the words are from the page; that\nthey support the description is the model's claim, metered by descGrounded.\n\n${receiptRows.join("\n") || "_This run predates span receipts._"}\n`,
  })

  // README.md
  const rep = run.report
  const usd = rep?.usd ?? run.stats?.usd
  const seconds = rep?.seconds ?? run.stats?.seconds
  const counts = new Map<string, number>()
  for (const e of kept) counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1)
  const countLine = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ")
  const gate = rep?.scorecard?.gate
  const health: string[] = []
  if (usd !== undefined) health.push(`- Cost: $${usd.toFixed(2)}${seconds ? ` over ${Math.round(seconds)}s` : ""}`)
  if (rep?.recall?.pooled != null)
    health.push(`- Answer-key recall: ${(rep.recall.pooled as number).toFixed(2)} over ${rep.recall.probes?.length ?? 0} probe page(s)`)
  if (rep?.recall?.aliasExclusion?.note) health.push(`- ${rep.recall.aliasExclusion.note}`)
  if (gate?.refusals) health.push(`- The finish gate refused ${gate.refusals} time(s); the objections are preserved below.`)
  if (rep?.ending?.humanReason) health.push(`- Ending: ${rep.ending.humanReason}`)
  const gateBlock = gate?.refusals
    ? `\n## The gate exchange\n\n${(gate.objections ?? []).map((o) => `> ${o}`).join("\n")}\n`
    : ""
  files.push({
    path: "README.md",
    content: `# ${anchor} — market map\n\n${run.decomposition?.sells ? `${run.decomposition.sells}\n\n` : ""}${kept.length} entities: ${countLine}.\n\n## Run health\n\n${health.join("\n") || "_No report block on this run._"}\n${gateBlock}\n## Where to start\n\n- [relations/competitor.md](relations/competitor.md) — the rivals, strongest evidence first\n- [segments/](segments/) — the market's structure, from provenance\n- [relations/unknown.md](relations/unknown.md) — what the run refused to guess\n- [AGENTS.md](AGENTS.md) — how to read this folder honestly\n`,
  })

  // AGENTS.md
  files.push({
    path: "AGENTS.md",
    content: `# How to use this knowledge base

This folder is a build artifact of one mapping run. Regenerate it from the run
file; never hand-edit — a correction belongs upstream in the engine.

Reading rules, in the map's own vocabulary:

- **tier** is where the evidence came from: \`own-page\` (the entity's own site,
  fetched this run) > \`page\` (some page fetched this run) > \`snippet\` (a search
  result). Trust claims in that order.
- **relation: unknown is a refusal, not an absence.** The run had a claim and
  refused it for the stated reason (\`because\`). Do not read unknown as "not a
  competitor"; read it as "not proven this run".
- **A why is evidence for the relation**, never a restatement of what the
  entity is. If a why reads hollow, check the receipts.
- **Receipts are literal quotes** from the entity's fetched page. They prove
  provenance, not support — descGrounded (0..1) meters how much of the
  description's vocabulary the page actually contains, and it is a relative
  drift meter, not a truth score.
- **Wikilinks are the graph.** Walk entity → edges → entity; segments/ groups
  by the provenance lane that surfaced each entity; straddlers legitimately
  appear between segments.
`,
  })

  // SKILL.md — the agent door: consumption recipes in the vocabulary the
  // knowledge-base MCP already chose (battlecard, ecosystem, coverage), as
  // plain file operations so any agent that can read files can walk the map.
  const competitorCount = counts.get("competitor") ?? 0
  const unknownCount = counts.get("unknown") ?? 0
  files.push({
    path: "SKILL.md",
    content: `---
name: kb-${anchor.replace(/\W+/g, "-")}
description: Walk the ${anchor} market map — competitors, substitutes, segments, buyers and the evidence behind every claim. Use when asked who competes with ${anchor}, for a battlecard, an ecosystem overview, why an entity is on this map, or how much of it to trust. Every answer should carry the note's receipts.
---

# Swimming in this map

${kept.length} entities around **${anchor}**${run.decomposition?.sells ? ` (${run.decomposition.sells.replace(/\.$/, "").toLowerCase()})` : ""}, every one carrying its evidence. You never need the app that built this — the files are the database.

## Recipes

**Battlecard (top rivals):** read \`relations/competitor.md\` — already ordered by evidence
tier, strongest first. For each rival open \`entities/<key>.md\`: the *what* is the pitch,
the *why* is the evidence for the rivalry, the receipts are quotable verbatim. ${competitorCount} competitors here.

**Ecosystem overview:** read \`README.md\` then every file in \`segments/\` — the market's
structure from provenance, with straddlers marked (entities legitimately in two segments
are often the most strategically interesting).

**Why is X on this map:** open \`entities/<key>.md\` — the *route* line says which market
lane surfaced it and how it stands to the anchor; the edges are wikilinks you can follow;
the receipts are the proof. If the relation is \`unknown\`, the *because* is the refusal —
treat it as "not proven", never "not a competitor". ${unknownCount} refusals here.

**Who buys / where they argue:** \`relations/buyer.md\` and \`relations/discusses.md\` →
the community entities.

**Search:** grep \`entities/\` frontmatter (\`relation:\`, \`tier:\`, \`segment:\`) — it is the
index. \`manifest.json\` has every key for programmatic access.

## Trust rules (measured, not disclaimers)

- Trust by **tier**: own-page > page > snippet. A tier is where the evidence came from.
- **Receipts prove provenance, not support**: the quote is verbatim from the entity's own
  fetched page; that it supports the description is the model's claim, metered by
  \`descGrounded\` (a relative drift meter — 0.68 is a normal honest score, not 68% true).
- The head of each relation list is solid; treat the snippet-tier tail as leads to check.
- Never repeat a *why* about an unfamiliar entity as established fact — quote its receipt
  or go fetch its page.
`,
  })

  // llms.txt — the product is built on reading these; its own export speaks one.
  files.push({
    path: "llms.txt",
    content: `# ${anchor} market map\n\n> ${kept.length} entities with evidence-tiered relations to ${anchor}: ${countLine}.\n\n- [README.md](README.md): the map at a glance and run health\n- [SKILL.md](SKILL.md): recipes for walking this map as an agent\n- [AGENTS.md](AGENTS.md): the honesty rules\n- [relations/competitor.md](relations/competitor.md): rivals by evidence tier\n- [manifest.json](manifest.json): programmatic index\n`,
  })

  // manifest.json
  const manifest = {
    anchor,
    entities: [...bySlug.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, e]) => ({ key: slug, path: `entities/${slug}.md`, name: e.name, relation: e.relation, tier: e.tier ?? null })),
    files: [...files.map((f) => f.path), "manifest.json"].sort(),
  }
  files.push({ path: "manifest.json", content: JSON.stringify(manifest, null, 2) + "\n" })

  return files.sort((a, b) => a.path.localeCompare(b.path))
}
