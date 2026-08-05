import {
  admit,
  extractText,
  isHtml,
  outboundHosts,
  registrableHost,
  type Evidence,
  type Ledger,
} from "@open-kb/core"
import { RunEvidence, originKey, strongerTier, type ProvenanceTier } from "./run-evidence.js"
import {
  MapState,
  nodeKey,
  SWARM_NODE_KINDS,
  SWARM_RELATIONS,
  type MapNode,
} from "./map.js"

/**
 * The three free tools: read, recall, remember. No provider call anywhere in
 * this file — a 65KB page re-reads for nothing, the map answers questions for
 * nothing, and writing a finding costs nothing but proof. Every return still
 * carries `poolLeftUsd`, because the skill promises it on every tool return:
 * the price of a model's own verbosity is on every turn even when the turn
 * bought nothing.
 *
 * Failures are sentences in the return value. Nothing in this file throws at
 * a model.
 */

/** How much of any projection reaches the model per call. Matches the kernel's
 *  slice: pages run to 900KB; contexts do not. */
export const SLICE = 8_000

// ── read ─────────────────────────────────────────────────────────────────────

export interface ReadInput {
  handle: string
  /** How to look at the bytes. `text` (default) is what quotes are proven
   *  against; `raw` is the body as the wire delivered it; `headings` and
   *  `links` are structure projections computed from the raw markup. */
  project?: "text" | "headings" | "links" | "raw"
  /** Keep only lines matching this pattern (case-insensitive; a broken regex
   *  is treated as literal text rather than refused). */
  grep?: string
  /** Character range over the projection, before the slice cap. */
  range?: { start: number; end?: number }
}

export type ReadReturn =
  | { ok: true; text: string; totalChars: number; matches?: number; poolLeftUsd: number }
  | { ok: false; reason: string; poolLeftUsd: number }

export interface ReadCtx {
  evidence: RunEvidence
  ledger: Ledger
}

const MD_HEADING = /^#{1,6}\s/
const HTML_HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
const HTML_ANCHOR = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g

function projectHeadings(text: string, raw: string | undefined): string {
  if (raw !== undefined && isHtml(raw)) {
    const out: string[] = []
    for (const m of raw.matchAll(HTML_HEADING)) {
      const line = extractText(m[2]!)
      if (line) out.push(`${"#".repeat(Number(m[1]!))} ${line}`)
    }
    return out.join("\n")
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => MD_HEADING.test(l))
    .join("\n")
}

/** Anchors with their text, resolved absolute. A site's own navigation is the
 *  universal machine-readable summary; the paid fetch returns these first-class. */
export function linksOf(raw: string, baseUrl: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = []
  for (const m of raw.matchAll(HTML_ANCHOR)) {
    let href = m[1]!
    try {
      href = new URL(href, baseUrl).toString()
    } catch {
      continue
    }
    out.push({ href, text: extractText(m[2]!) })
  }
  return out
}

function projectLinks(text: string, raw: string | undefined, baseUrl: string): string {
  const lines: string[] = []
  if (raw !== undefined && isHtml(raw)) {
    for (const l of linksOf(raw, baseUrl)) lines.push(l.text ? `${l.href} — ${l.text}` : l.href)
  } else {
    for (const m of text.matchAll(MD_LINK)) lines.push(`${m[2]!} — ${m[1]!}`)
  }
  return lines.join("\n")
}

/**
 * FREE. Re-read bytes the run already fetched — projected, grepped, ranged —
 * without a provider call. This is what turns 65KB into a few hundred bytes
 * at zero cost and keeps an 880KB page out of every prompt.
 */
export function readTool(ctx: ReadCtx, input: ReadInput): ReadReturn {
  const poolLeftUsd = ctx.ledger.spendable()
  const rec = ctx.evidence.get(input.handle)
  if (!rec) {
    if (ctx.evidence.isPending(input.handle)) {
      return {
        ok: false,
        reason: "that fetch is still in flight; its bytes land in the store when it returns — ask again in a moment",
        poolLeftUsd,
      }
    }
    return { ok: false, reason: "no such handle in this run", poolLeftUsd }
  }
  if (rec.status !== "found") {
    return {
      ok: false,
      reason: `that page was ${rec.status}${rec.reason ? ` (${rec.reason})` : ""}; there is nothing to read`,
      poolLeftUsd,
    }
  }

  const raw = ctx.evidence.rawOf(input.handle)
  const project = input.project ?? "text"
  let text =
    project === "raw"
      ? (raw ?? rec.text)
      : project === "headings"
        ? projectHeadings(rec.text, raw)
        : project === "links"
          ? projectLinks(rec.text, raw, rec.url)
          : rec.text

  let matches: number | undefined
  if (input.grep !== undefined && input.grep !== "") {
    let re: RegExp
    try {
      re = new RegExp(input.grep, "i")
    } catch {
      re = new RegExp(input.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    }
    const kept = text.split("\n").filter((l) => re.test(l))
    matches = kept.length
    text = kept.join("\n")
  }

  const totalChars = text.length
  if (input.range) {
    const start = Math.max(0, Math.floor(input.range.start))
    const end = input.range.end === undefined ? undefined : Math.max(start, Math.floor(input.range.end))
    text = text.slice(start, end)
  }
  text = text.slice(0, SLICE)

  return { ok: true, text, totalChars, ...(matches === undefined ? {} : { matches }), poolLeftUsd }
}

// ── recall ───────────────────────────────────────────────────────────────────

/** One search the run paid for, and what came back — the raw material for
 *  `barren`. The paid search tool appends these; recall only reads them. */
export interface SearchTrace {
  query: string
  ok: boolean
  urls: string[]
}

export interface RecallCtx {
  map: MapState
  evidence: RunEvidence
  ledger: Ledger
  /** The board, when the caller has one; `op:"board"` answers empty rows without it. */
  board?: { residue(): ReadonlyArray<{ priority: number; tier: string; lens: string; brief: string; unreviewed: boolean }> }
  searches?: ReadonlyArray<SearchTrace>
}

export type RecallInput =
  | { op: "find"; q: string }
  | { op: "neighbors"; key: string }
  | { op: "stats" }
  | { op: "gaps" }
  | { op: "barren" }
  | { op: "unread" }
  | { op: "board" }

export interface RecallReturn {
  op: RecallInput["op"]
  rows: Array<Record<string, unknown>>
  poolLeftUsd: number
}

/** Most rows any recall answers with. Compact rows, not a dump. */
const MAX_ROWS = 40

/** A why shorter than this is a thin reason — "adjacent player" is worth nothing. */
const THIN_WHY = 40

/** A term is barren only after this many searches produced no verified company. */
const BARREN_AFTER = 2

const nodeRow = (n: MapNode) => ({
  key: n.key,
  name: n.name,
  kind: n.kind,
  relation: n.relation,
  tier: n.tier,
  sources: new Set(n.evidence.map((e) => e.url)).size,
})

/**
 * FREE. Questions over the map, the board, the search history and the store.
 * Empty rows, never an error — an op with nothing to say says nothing.
 */
export function recallTool(ctx: RecallCtx, input: RecallInput): RecallReturn {
  const poolLeftUsd = ctx.ledger.spendable()
  const live = [...ctx.map.nodes.values()].filter((n) => !n.retracted)
  const rows: Array<Record<string, unknown>> = []

  switch (input.op) {
    case "find": {
      const q = input.q.trim().toLowerCase()
      if (!q) break
      for (const n of live) {
        const hay = `${n.key} ${n.name} ${n.domain} ${n.what} ${n.why}`.toLowerCase()
        if (hay.includes(q)) rows.push(nodeRow(n))
        if (rows.length >= MAX_ROWS) break
      }
      break
    }
    case "neighbors": {
      const key = nodeKey("company", input.key, input.key) || input.key.trim().toLowerCase()
      for (const e of ctx.map.edges) {
        if (e.retracted) continue
        if (e.from !== key && e.to !== key) continue
        const otherKey = e.from === key ? e.to : e.from
        const other = ctx.map.nodes.get(otherKey)
        rows.push({
          from: e.from,
          to: e.to,
          relation: e.relation,
          confidence: e.confidence,
          why: e.why,
          ...(other ? { other: { key: other.key, name: other.name, kind: other.kind } } : {}),
        })
        if (rows.length >= MAX_ROWS) break
      }
      break
    }
    case "stats": {
      const count = (xs: string[]) =>
        xs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})
      rows.push({
        nodes: live.length,
        edges: ctx.map.edges.filter((e) => !e.retracted).length,
        retracted: ctx.map.retractions.length,
        byKind: count(live.map((n) => n.kind)),
        byRelation: count(live.map((n) => n.relation)),
        byTier: count(live.map((n) => n.tier)),
        fetched: ctx.evidence.size(),
        boardQueued: ctx.board ? ctx.board.residue().length : 0,
      })
      break
    }
    case "gaps": {
      for (const n of live) {
        const sources = new Set(n.evidence.map((e) => e.url)).size
        const thin = n.why.trim().length < THIN_WHY
        if (sources >= 2 && !thin) continue
        rows.push({ ...nodeRow(n), thin, why: n.why })
        if (rows.length >= MAX_ROWS) break
      }
      break
    }
    case "barren": {
      const verified = new Set(
        live.filter((n) => n.kind === "company" || n.kind === "product").map((n) => n.key),
      )
      const byTerm = new Map<string, { searches: number; hosts: Set<string> }>()
      for (const s of ctx.searches ?? []) {
        const t = byTerm.get(s.query) ?? { searches: 0, hosts: new Set<string>() }
        t.searches += 1
        for (const u of s.urls) {
          const h = originKey(u)
          if (h) t.hosts.add(h)
        }
        byTerm.set(s.query, t)
      }
      for (const [term, t] of byTerm) {
        if (t.searches < BARREN_AFTER) continue
        if ([...t.hosts].some((h) => verified.has(h))) continue
        rows.push({ term, searches: t.searches, hostsSeen: t.hosts.size })
        if (rows.length >= MAX_ROWS) break
      }
      break
    }
    case "unread": {
      for (const u of ctx.evidence.unread()) {
        rows.push(u)
        if (rows.length >= MAX_ROWS) break
      }
      break
    }
    case "board": {
      for (const r of ctx.board?.residue() ?? []) {
        rows.push({ priority: r.priority, tier: r.tier, lens: r.lens, brief: r.brief, unreviewed: r.unreviewed })
        if (rows.length >= MAX_ROWS) break
      }
      break
    }
  }

  return { op: input.op, rows, poolLeftUsd }
}

// ── remember ─────────────────────────────────────────────────────────────────

export interface EvidenceRef {
  url: string
  quote: string
}

export interface RememberNodeInput {
  name: string
  domain: string
  kind: string
  what: string
  relation: string
  why: string
  evidence: EvidenceRef[]
}

export interface RememberEdgeInput {
  from: string
  to: string
  relation: string
  why: string
  confidence?: "measured" | "inferred"
  evidence?: EvidenceRef[]
}

export interface RetractInput {
  /** Retract a node by its domain (or name for domainless kinds)… */
  node?: string
  /** …or an edge by its endpoints, optionally narrowed to one relation. */
  edge?: { from: string; to: string; relation?: string }
  why: string
}

export interface RememberInput {
  nodes?: RememberNodeInput[]
  edges?: RememberEdgeInput[]
  retract?: RetractInput[]
  why: string
}

export interface RememberReturn {
  added: { nodes: number; edges: number; retractions: number }
  merged: { nodes: number; edges: number }
  rejected: Array<{ item: string; reason: string }>
  poolLeftUsd: number
}

export interface RememberCtx {
  map: MapState
  evidence: RunEvidence
  ledger: Ledger
  /** Distinct outbound hosts before a company-shaped page reads as a directory.
   *  Null (the calibrated default) disables the rule rather than guessing. */
  aggregatorThreshold?: number | null
}

const KINDS = new Set<string>(SWARM_NODE_KINDS)
const RELS = new Set<string>(SWARM_RELATIONS)

const kindSentence = `use one of ${SWARM_NODE_KINDS.join(", ")}`
const relSentence = `use one of ${SWARM_RELATIONS.join(", ")}`

/** Mint every ref or explain the first failure — the mint's sentence, verbatim. */
function mintAll(
  evidence: RunEvidence,
  refs: EvidenceRef[],
): { ok: true; evidence: Evidence[] } | { ok: false; reason: string } {
  const out: Evidence[] = []
  for (const r of refs) {
    const c = evidence.cite(r.url, r.quote)
    if (!c.ok) return { ok: false, reason: c.reason }
    out.push(c.evidence)
  }
  return { ok: true, evidence: out }
}

/** own-page beats page beats snippet, computed from where each quote's bytes came from. */
function tierOf(key: string, evidence: Evidence[]): ProvenanceTier {
  let best: ProvenanceTier = "snippet"
  for (const ev of evidence) {
    const t: ProvenanceTier = ev.tier === "snippet" ? "snippet" : originKey(ev.url) === key ? "own-page" : "page"
    best = strongerTier(best, t)
  }
  return best
}

function dedupeEvidence(existing: Evidence[], incoming: Evidence[]): Evidence[] {
  const seen = new Set(existing.map((e) => `${e.url}\u0000${e.quote}`))
  const out = [...existing]
  for (const e of incoming) {
    const k = `${e.url}\u0000${e.quote}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

/**
 * FREE, and the only writer. Every claim is proven against stored bytes by
 * the kernel's mint, keyed by registrable host so concurrent writers merge
 * instead of duplicating, gated by admit() so a commercial stance nothing
 * supports lands downgraded to `unknown` wearing its refusal — never deleted.
 * Every rejection is a sentence the model can act on, in-band, next to the
 * siblings that landed.
 */
export function rememberTool(ctx: RememberCtx, input: RememberInput): RememberReturn {
  const rejected: Array<{ item: string; reason: string }> = []
  const added = { nodes: 0, edges: 0, retractions: 0 }
  const merged = { nodes: 0, edges: 0 }

  // ── nodes ──
  for (const n of input.nodes ?? []) {
    const item = `node "${n.name || n.domain}"`
    if (!KINDS.has(n.kind)) {
      rejected.push({ item, reason: `"${n.kind}" is not a kind this map holds; ${kindSentence}` })
      continue
    }
    if (!RELS.has(n.relation)) {
      rejected.push({ item, reason: `"${n.relation}" is not a relation this map draws; ${relSentence}` })
      continue
    }
    const key = nodeKey(n.kind, n.name, n.domain)
    if (!key) {
      rejected.push({
        item,
        reason:
          n.kind === "company" || n.kind === "product"
            ? `a ${n.kind} is its domain; say which host this is`
            : "a node needs a name or a domain to be anything at all",
      })
      continue
    }
    if (key === ctx.map.anchor && (n.kind === "company" || n.kind === "product")) {
      rejected.push({ item, reason: "that is the anchor — the map exists to explain it; it is already here" })
      continue
    }
    if (n.evidence.length === 0) {
      rejected.push({
        item,
        reason: "a claim needs at least one quote from a URL this run fetched; search hits count, at the snippet tier",
      })
      continue
    }
    const minted = mintAll(ctx.evidence, n.evidence)
    if (!minted.ok) {
      rejected.push({ item, reason: minted.reason })
      continue
    }

    const tier = tierOf(key, minted.evidence)

    // The kernel's gate: the model still says what a host is; this refuses
    // claims whose evidence does not support them. A refusal downgrades, it
    // never deletes.
    let kind = n.kind
    let relation = n.relation
    let because: string | undefined
    {
      const own = ctx.evidence.ownPage(key)
      const page = own
        ? { url: own.url, readable: true, outboundHosts: outboundHosts(own.raw ?? own.text, own.url) }
        : null
      const threshold = ctx.aggregatorThreshold ?? null
      const verdict = admit(
        { host: key, kind, relation },
        page,
        { anchor: ctx.map.anchor, aggregatorThreshold: threshold ?? Number.POSITIVE_INFINITY },
      )
      if (!verdict.ok) {
        kind = verdict.kind
        relation = verdict.relation
        because = verdict.because
      }
    }

    const existing = ctx.map.nodes.get(key)
    if (!existing || existing.retracted) {
      ctx.map.nodes.set(key, {
        key,
        name: n.name || n.domain,
        domain: n.domain,
        kind,
        what: n.what,
        relation,
        why: n.why,
        ...(because ? { because } : {}),
        tier,
        evidence: minted.evidence,
        also: [],
      })
      added.nodes += 1
      continue
    }

    // Merge, commutative on key: the same two accounts land as one node with
    // both sets of evidence whichever order they arrive in. The account with
    // the stronger provenance owns the scalar fields; the other survives in
    // `also` — its what, and its name when it had its own — rather than being
    // discarded.
    existing.evidence = dedupeEvidence(existing.evidence, minted.evidence)
    const incomingStronger = strongerTier(tier, existing.tier) === tier && tier !== existing.tier
    if (incomingStronger) {
      const survivorName = n.name || existing.name
      if (existing.what && existing.what !== n.what && !existing.also.some((a) => a.what === existing.what)) {
        existing.also.push({
          ...(existing.name && existing.name !== survivorName ? { name: existing.name } : {}),
          what: existing.what,
        })
      }
      existing.name = survivorName
      existing.what = n.what
      existing.why = n.why
      // An unknown never outranks a supported claim, even arriving stronger:
      // a downgraded account contributes its evidence and its tier, but the
      // standing supported kind/relation hold and the refusal is dropped —
      // the mirror of the recovery rule below, so the merge commutes across
      // the downgrade/recovery seam whichever order the two accounts arrive.
      const downgradeIntoSupported = !!because && relation === "unknown" && existing.relation !== "unknown"
      if (!downgradeIntoSupported) {
        existing.kind = kind
        existing.relation = relation
        if (because) existing.because = because
        else delete existing.because
      }
      existing.tier = tier
    } else {
      if (n.what && n.what !== existing.what && !existing.also.some((a) => a.what === n.what)) {
        existing.also.push({
          ...(n.name && n.name !== existing.name ? { name: n.name } : {}),
          what: n.what,
        })
      }
      // An unknown never outranks a supported claim: if the standing relation
      // was the downgrade and this account was admitted, the node recovers.
      if (existing.relation === "unknown" && relation !== "unknown" && !because) {
        existing.relation = relation
        existing.kind = kind
        delete existing.because
      }
      existing.tier = strongerTier(existing.tier, tier)
    }
    merged.nodes += 1
  }

  // ── edges ──
  // Endpoints resolve against nodes already on the map, including ones landed
  // in this very call — that is how a model writes a finding: the nodes and
  // the relation together, nodes first.
  const endpointOf = (raw: string): string | null => {
    const key = nodeKey("company", raw, raw)
    if (key && ctx.map.endpointOnMap(key) && !ctx.map.nodes.get(key)?.retracted) return key
    const named = [...ctx.map.nodes.values()].find(
      (n) => !n.retracted && n.name.trim().toLowerCase() === raw.trim().toLowerCase(),
    )
    return named ? named.key : null
  }

  for (const e of input.edges ?? []) {
    const item = `edge ${e.from}->${e.to}`
    if (!RELS.has(e.relation)) {
      rejected.push({ item, reason: `"${e.relation}" is not a relation this map draws; ${relSentence}` })
      continue
    }
    const refs = e.evidence ?? []
    const confidence = e.confidence ?? (refs.length ? "measured" : "inferred")
    if (confidence === "measured" && refs.length === 0) {
      rejected.push({
        item,
        reason: "a measured edge cites a page; give a quote from a URL this run fetched, or call it inferred",
      })
      continue
    }
    const minted = mintAll(ctx.evidence, refs)
    if (!minted.ok) {
      rejected.push({ item, reason: minted.reason })
      continue
    }
    const from = endpointOf(e.from)
    const to = endpointOf(e.to)
    if (!from || !to) {
      const missing = [!from ? e.from : null, !to ? e.to : null].filter((x): x is string => x !== null)
      rejected.push({
        item,
        reason: `${missing.map((m) => `"${m}"`).join(" and ")} ${missing.length > 1 ? "are" : "is"} not on this map; record it as a node first — the same call is fine, nodes land before edges`,
      })
      continue
    }
    if (from === to) {
      rejected.push({ item, reason: "an edge needs two different ends; this one joins a node to itself" })
      continue
    }
    const existing = ctx.map.edges.find((x) => !x.retracted && x.from === from && x.to === to && x.relation === e.relation)
    if (existing) {
      existing.evidence = dedupeEvidence(existing.evidence, minted.evidence)
      if (confidence === "measured") existing.confidence = "measured"
      merged.edges += 1
      continue
    }
    ctx.map.edges.push({ from, to, relation: e.relation, why: e.why, confidence, evidence: minted.evidence })
    added.edges += 1
  }

  // ── retractions: claims like any other, each carrying its why ──
  for (const r of input.retract ?? []) {
    if (r.node !== undefined) {
      const item = `retract "${r.node}"`
      const key = nodeKey("company", r.node, r.node)
      const node =
        (key ? ctx.map.nodes.get(key) : undefined) ??
        [...ctx.map.nodes.values()].find((n) => n.name.trim().toLowerCase() === r.node!.trim().toLowerCase())
      if (!node || node.retracted) {
        rejected.push({ item, reason: `nothing named "${r.node}" is on this map; there is nothing to retract` })
        continue
      }
      node.retracted = { why: r.why }
      ctx.map.retractions.push({ target: node.key, why: r.why })
      added.retractions += 1
      continue
    }
    if (r.edge !== undefined) {
      const item = `retract ${r.edge.from}->${r.edge.to}`
      const from = endpointOf(r.edge.from)
      const to = endpointOf(r.edge.to)
      const hits = ctx.map.edges.filter(
        (x) =>
          !x.retracted &&
          x.from === (from ?? r.edge!.from) &&
          x.to === (to ?? r.edge!.to) &&
          (r.edge!.relation === undefined || x.relation === r.edge!.relation),
      )
      if (hits.length === 0) {
        rejected.push({ item, reason: `no live edge joins "${r.edge.from}" to "${r.edge.to}"; there is nothing to retract` })
        continue
      }
      for (const h of hits) h.retracted = { why: r.why }
      ctx.map.retractions.push({ target: `${r.edge.from}->${r.edge.to}`, why: r.why })
      added.retractions += 1
      continue
    }
    rejected.push({ item: "retract", reason: "say what to retract: a node's domain, or an edge's two ends" })
  }

  return { added, merged, rejected, poolLeftUsd: ctx.ledger.spendable() }
}
