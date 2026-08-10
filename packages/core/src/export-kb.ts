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

/**
 * WHAT LEAVES THE APP IS THE MAP, NOT THE CRAWL.
 *
 * A run touches every host a query returned. A market map is the subset that
 * stands in some relation to the anchor, and the difference is not a matter of
 * taste — the run itself says which is which, and the export used to ship both.
 * Each gate below drops a row on a verdict the run already reached, in the
 * run's own words. Nothing is rewritten: a described entity ships exactly the
 * sentences the model wrote, or it does not ship. That is the only way the
 * folder can still claim a machine produced it.
 *
 * These are also the file's third-party safety rules, and that is deliberate:
 * every row that names a person or an organisation with no stake in this market
 * is a row the run had already declined to place, so honesty and safety cut in
 * the same direction and one gate serves both.
 */
export type DropReason = "noise" | "silent" | "unrelated" | "commentary" | "personal" | "unexplained"

/** A description the RUN wrote that says the site belongs to a person. The map
 *  is of a market; a market has no natural-person members, and a machine-written
 *  paragraph about a named individual is the one thing this export must never
 *  publish. Matched on the model's own words, so the gate never has to guess. */
const PERSONAL_PROSE =
  /\bpersonal\s+(?:\S+\s+){0,2}(?:blog|site|website|portfolio|page)\b|\bindividual(?:'s)?\s+(?:\S+\s+){0,2}(?:blog|site|website|portfolio)\b|\bnewsletter author\b|\bportfolio (?:site|website) of\b/i

/** One label under a personal-publishing platform — `x.medium.com`, not
 *  `medium.com`, which is a publisher in its own right. */
const PERSONAL_HOST = /^[a-z0-9-]+\.(?:medium|substack|tistory|wordpress)\.com$|\.blogspot\./i

/**
 * Why this entity is not in the export, or null to keep it.
 *
 * - `noise`     the classifier already said this leaves the map.
 * - `silent`    nothing was read: no description, no reason, no quote. The page
 *               could only assert that a named third party's site refused us or
 *               404'd on one day — a standing public claim about someone else
 *               with no product value behind it.
 * - `unrelated` `relation: "none"` is the run's finding that there is no
 *               relation. It is `noise` said with less confidence: every one of
 *               these rows carries a why that argues the entity is in a
 *               different market. A map of a market does not list them.
 * - `commentary` `covers` names entities that merely publish near the market.
 *               That set is unbounded — most of the web publishes near any
 *               market — and an unbounded set inside a map is noise by
 *               construction. Competitors compete, substitutes substitute,
 *               integrations integrate, directories put the anchor on a
 *               shortlist and communities are where its buyers argue; all five
 *               are bounded and load-bearing. "Also writes about this" is not.
 * - `personal`  see PERSONAL_PROSE.
 * - `unexplained` AGENTS.md promises every refusal wears its reason. An
 *               `unknown` with no `because` is a refusal that does not, so the
 *               export cannot honour the promise by shipping it.
 */
export function exportDrop(e: ExportEntity): DropReason | null {
  if (e.kind === "noise") return "noise"
  if (!e.what && !e.why && !e.spans?.length) return "silent"
  if (e.relation === "none") return "unrelated"
  if (e.relation === "covers") return "commentary"
  if (PERSONAL_PROSE.test(e.what ?? "") || PERSONAL_HOST.test(e.domain ?? "")) return "personal"
  if (e.relation === "unknown" && !e.because) return "unexplained"
  return null
}

/** Reads after a count, at any count: "55 judged unrelated to this market". */
const DROP_LABEL: Record<DropReason, string> = {
  noise: "judged unrelated to this market",
  unrelated: "judged unrelated to this market",
  silent: "unreadable this run",
  commentary: "publishing near the market, not in it",
  personal: "personal, not a market entity",
  unexplained: "refused with no stated reason",
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

/** Tier first, then the key the row actually displays — a list whose stated
 *  order is invisible in its own text reads as no order at all, and on an
 *  untiered run the key is the whole of the order. */
function tierSort(a: ExportEntity, b: ExportEntity): number {
  const ta = TIER_RANK[a.tier ?? ""] ?? 3
  const tb = TIER_RANK[b.tier ?? ""] ?? 3
  return ta - tb || slugOf(a).localeCompare(slugOf(b))
}

function segmentOf(e: ExportEntity): string {
  return e.foundBy?.[0] ?? "unattributed"
}

/** Build every file of the export. Deterministic: same run, same bytes. */
export function exportKbFiles(run: ExportRunLike): ExportedFile[] {
  const anchor = run.anchor ?? "the anchor"
  const kept: ExportEntity[] = []
  const dropped = new Map<DropReason, number>()
  for (const e of run.entities) {
    const why = exportDrop(e)
    if (why) dropped.set(why, (dropped.get(why) ?? 0) + 1)
    else kept.push(e)
  }
  const bySlug = new Map<string, ExportEntity>()
  for (const e of kept) {
    const s = slugOf(e)
    if (!bySlug.has(s)) bySlug.set(s, e)
  }
  const slugifyRef = (host: string) => host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  // An edge is a wikilink, and a wikilink to a gated entity is a dead link. The
  // graph is therefore the induced subgraph on what survived — both ends or
  // neither. (The old code kept every edge touching a kept node, which was only
  // ever safe because nothing this run linked to a dropped one.)
  const edges = (run.edges ?? []).filter((ed) => bySlug.has(slugifyRef(ed.from)) && bySlug.has(slugifyRef(ed.to)))
  const edgesOf = (slug: string) => edges.filter((ed) => slugifyRef(ed.from) === slug || slugifyRef(ed.to) === slug)

  // The tier vocabulary is the swarm's; a sweep run has no tiers to report.
  // Prose that explains how to read a field no shipped row carries is the most
  // checkable kind of lie a document can tell, so every tier sentence below is
  // conditional on the export actually having one.
  const tiered = kept.some((e) => e.tier)

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
    const judged = e.tier ? ` → judged ${e.tier}` : ""
    lines.push(`**Route:** ${lane}${judged} → ${e.relation} to ${anchor}.\n`)
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
      return `- [[${slugOf(e)}]]${e.tier ? ` (${e.tier})` : ""}${extra}`
    })
    const order = tiered ? "Ordered by evidence tier, strongest first." : "Ordered by key; this run recorded no evidence tiers."
    const head =
      rel === "unknown"
        ? `# unknown\n\nThese are refusals, not absences: each claim failed an evidence bar and\nwears the reason. Resolving one means fetching better evidence, not deleting\nthe row.\n`
        : `# ${rel}\n\n${order}\n`
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

  // NO evidence/receipts.md.
  //
  // It used to exist and it was every span in the run concatenated into one
  // file — 484 quotes, 47KB, on the clerk.com export. Not one of those quotes
  // was unique to it: the same span is already blockquoted on the entity's own
  // page, from this same array, so the file carried zero information and
  // nothing in the vault linked to it. What it did carry was the only thing in
  // the folder shaped like a scrape dump rather than a citation — third-party
  // page copy in bulk, detached from any claim it supports.
  //
  // "Every claim carries its receipt" is the promise, and a quote sitting
  // beside the sentence it grounds keeps it better than a corpus does. Removing
  // this file resolves no citation less: `grep -r` over entities/ is the index
  // it was pretending to be.

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
  // The gated hosts are counted, never named. A map that reports its own blind
  // spot in aggregate is more honest than one that publishes a page per host
  // saying that host blocked us — and it accuses nobody.
  const dropTotal = [...dropped.values()].reduce((a, b) => a + b, 0)
  if (dropTotal) {
    const byLabel = new Map<string, number>()
    for (const [why, n] of dropped) byLabel.set(DROP_LABEL[why], (byLabel.get(DROP_LABEL[why]) ?? 0) + n)
    const breakdown = [...byLabel.entries()].sort(([, a], [, b]) => b - a).map(([l, n]) => `${n} ${l}`)
    health.push(`- ${dropTotal} host(s) surfaced and did not make the map: ${breakdown.join(" · ")}.`)
  }
  const gateBlock = gate?.refusals
    ? `\n## The gate exchange\n\n${(gate.objections ?? []).map((o) => `> ${o}`).join("\n")}\n`
    : ""
  // Only offer a door that exists: a run with no competitors writes no
  // relations/competitor.md, and a link to it would be the map's first lie.
  const relFile = (rel: string) => (byRelation.has(rel) ? `relations/${rel}.md` : null)
  const starts = [
    relFile("competitor") && `- [${relFile("competitor")}](${relFile("competitor")}) — the rivals${tiered ? ", strongest evidence first" : ""}`,
    `- [segments/](segments/) — the market's structure, from provenance`,
    relFile("unknown") && `- [${relFile("unknown")}](${relFile("unknown")}) — what the run refused to guess`,
    `- [AGENTS.md](AGENTS.md) — how to read this folder honestly`,
  ].filter(Boolean)
  files.push({
    path: "README.md",
    content: `# ${anchor} — market map\n\n${run.decomposition?.sells ? `${run.decomposition.sells}\n\n` : ""}${kept.length} entities: ${countLine}.\n\n## Run health\n\n${health.join("\n") || "_No report block on this run._"}\n${gateBlock}\n## Where to start\n\n${starts.join("\n")}\n`,
  })

  // AGENTS.md
  const agentRules = [
    tiered &&
      `- **tier** is where the evidence came from: \`own-page\` (the entity's own site,
  fetched this run) > \`page\` (some page fetched this run) > \`snippet\` (a search
  result). Trust claims in that order.`,
    byRelation.has("unknown") &&
      `- **relation: unknown is a refusal, not an absence.** The run had a claim and
  refused it for the stated reason (\`because\`). Do not read unknown as "not a
  competitor"; read it as "not proven this run".`,
    `- **A why is evidence for the relation**, never a restatement of what the
  entity is. If a why reads hollow, check the receipts.`,
    `- **Receipts are literal quotes** from the entity's fetched page, blockquoted
  on the entity's own note beside the claim they ground. They prove provenance,
  not support — descGrounded (0..1) meters how much of the description's
  vocabulary the page actually contains, and it is a relative drift meter, not
  a truth score.`,
    `- **Wikilinks are the graph.** Walk entity → edges → entity; segments/ groups
  by the provenance lane that surfaced each entity; straddlers legitimately
  appear between segments.`,
    `- **This is the map, not the crawl.** Hosts the run read and placed in no
  relation to ${anchor}, could not read at all, or found only publishing near
  the market are counted in the README's run health and are not given pages.
  An absent host is not a judgement about that host.`,
  ].filter(Boolean)
  files.push({
    path: "AGENTS.md",
    content: `# How to use this knowledge base

This folder is a build artifact of one mapping run. Regenerate it from the run
file; never hand-edit — a correction belongs upstream in the engine.

Reading rules, in the map's own vocabulary:

${agentRules.join("\n")}
`,
  })

  // SKILL.md — the agent door: consumption recipes in the vocabulary the
  // knowledge-base MCP already chose (battlecard, ecosystem, coverage), as
  // plain file operations so any agent that can read files can walk the map.
  const competitorCount = counts.get("competitor") ?? 0
  const unknownCount = counts.get("unknown") ?? 0
  const battlecard = competitorCount
    ? `**Battlecard (top rivals):** read \`relations/competitor.md\`${tiered ? ", already ordered by evidence tier,\nstrongest first" : ""}.
For each rival open \`entities/<key>.md\`: the *what* is the pitch, the *why* is the
evidence for the rivalry, the receipts are quotable verbatim. ${competitorCount} competitors here.`
    : `**Battlecard (top rivals):** this run placed no entity as a competitor. \`relations/\`
holds the relations it did find.`
  const whyOnMap = `**Why is X on this map:** open \`entities/<key>.md\` — the *route* line says which market
lane surfaced it and how it stands to ${anchor}; the edges are wikilinks you can follow;
the receipts are the proof.${
    unknownCount
      ? ` If the relation is \`unknown\`, the *because* is the refusal —
treat it as "not proven", never "not a competitor". ${unknownCount} refusals here.`
      : ""
  }`
  // Name only the relation files this run actually wrote; `relations/buyer.md`
  // was advertised here for every export and existed in almost none of them.
  const audience = ["buyer", "discusses"].filter((r) => byRelation.has(r))
  const whoBuys = audience.length
    ? `\n\n**Who buys / where they argue:** ${audience.map((r) => `\`relations/${r}.md\``).join(" and ")} →
the community entities.`
    : ""
  const grepFields = ["relation:", tiered && "tier:", "segment:"].filter(Boolean).map((f) => `\`${f}\``).join(", ")
  const trustRules = [
    tiered && `- Trust by **tier**: own-page > page > snippet. A tier is where the evidence came from.`,
    `- **Receipts prove provenance, not support**: the quote is verbatim from the entity's own
  fetched page; that it supports the description is the model's claim, metered by
  \`descGrounded\` (a relative drift meter — 0.68 is a normal honest score, not 68% true).`,
    tiered
      ? `- The head of each relation list is solid; treat the snippet-tier tail as leads to check.`
      : `- This run recorded no evidence tiers, so the relation lists are alphabetical, not
  ranked. Weight a row by its receipts, not its position.`,
    `- Never repeat a *why* about an unfamiliar entity as established fact — quote its receipt
  or go fetch its page.`,
  ].filter(Boolean)
  files.push({
    path: "SKILL.md",
    content: `---
name: kb-${anchor.replace(/\W+/g, "-")}
description: Walk the ${anchor} market map — competitors, substitutes, segments, buyers and the evidence behind every claim. Use when asked who competes with ${anchor}, for a battlecard, an ecosystem overview, why an entity is on this map, or how much of it to trust. Every answer should carry the note's receipts.
---

# Swimming in this map

${kept.length} entities around **${anchor}**${run.decomposition?.sells ? ` (${run.decomposition.sells.replace(/\.$/, "").toLowerCase()})` : ""}, every one carrying its evidence. You never need the app that built this — the files are the database.

## Recipes

${battlecard}

**Ecosystem overview:** read \`README.md\` then every file in \`segments/\` — the market's
structure from provenance, with straddlers marked (entities legitimately in two segments
are often the most strategically interesting).

${whyOnMap}${whoBuys}

**Search:** grep \`entities/\` frontmatter (${grepFields}) — it is the
index. \`manifest.json\` has every key for programmatic access.

## Trust rules (measured, not disclaimers)

${trustRules.join("\n")}
`,
  })

  // llms.txt — the product is built on reading these; its own export speaks one.
  const llmsRows = [
    `- [README.md](README.md): the map at a glance and run health`,
    `- [SKILL.md](SKILL.md): recipes for walking this map as an agent`,
    `- [AGENTS.md](AGENTS.md): the honesty rules`,
    relFile("competitor") && `- [${relFile("competitor")}](${relFile("competitor")}): the rivals${tiered ? ", by evidence tier" : ""}`,
    `- [manifest.json](manifest.json): programmatic index`,
  ].filter(Boolean)
  files.push({
    path: "llms.txt",
    content: `# ${anchor} market map\n\n> ${kept.length} entities with cited${tiered ? ", evidence-tiered" : ""} relations to ${anchor}: ${countLine}.\n\n${llmsRows.join("\n")}\n`,
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
