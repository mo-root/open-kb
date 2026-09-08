import { registrableHost } from "./url.js"

/**
 * Map drift: what changed between two runs of the same anchor.
 *
 * Re-running an anchor produces a fresh map every time, and until now nothing
 * compared them — two files sat side by side in `runs/` and the difference
 * between an 8-node map and a 12-node map of the same company was a reader's
 * eyeball job. The night of the three swarm runs made the gap concrete: run 2
 * and run 3 of one anchor, ninety minutes apart, share a file format and not a
 * single comparison. This module is that comparison, pure and offline: rows
 * in, drift out, no clock, no network, no vendor.
 *
 * Identity is the same rule the map itself keys on: a row carrying a domain is
 * its registrable host (company and product rows always do — `docs.apify.com`
 * and `www.apify.com` are one entity, not three), and a row with no domain is
 * `kind:name`, case-folded, because a name is all it has. Display names never
 * key: two runs spelling one company differently is not two companies.
 *
 * Shape variance is handled by refusing to invent readings. The watched
 * fields are `kind`, `relation` and `tier`; a field absent (or blank) on
 * EITHER side never counts as changed — kernel-shaped runs mint no `tier` at
 * all, swarm rows carry `because` only when a claim was downgraded, and "run
 * A did not say" is not a move from anything. Only what both runs actually
 * wrote can drift. Fields this module does not watch (`why`, `what`,
 * `because`, `foundBy`) are wording, not position, and never count either.
 *
 * When one run spells the same key twice (two subdomains folding to one
 * host), the first row speaks for the key — the order the run wrote is the
 * order the run meant.
 */

/** One map row, reduced to what drift watches. Structural on purpose: sweep,
 *  swarm and kernel rows all assign without either package importing the other. */
export interface DriftEntityRow {
  name: string
  domain?: string
  kind: string
  relation?: string
  tier?: string
}

export interface DriftEdgeRow {
  from: string
  to: string
  relation: string
}

/** Two runs' shared shape: entities always, edges when the run drew any. */
export interface DriftMap {
  entities: DriftEntityRow[]
  edges?: DriftEdgeRow[]
}

export type DriftField = "kind" | "relation" | "tier"

/** One watched field of one shared key, read on both sides. */
export interface FieldChange {
  key: string
  field: DriftField
  from: string
  to: string
}

export interface MapDrift {
  /** Keys present only in the second map, sorted. */
  entered: string[]
  /** Keys present only in the first, sorted. */
  left: string[]
  /** Watched-field moves on shared keys, sorted by key then kind/relation/tier. */
  changed: FieldChange[]
  /** Shared keys with no watched-field move. */
  unchangedCount: number
  edgesEntered: string[]
  edgesLeft: string[]
}

const blank = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/**
 * The one identity rule, exported so a caller can cross-check the diff's
 * arithmetic.
 *
 * `registrableHost("")` is `""`, and so is `registrableHost` of anything that
 * reduces to nothing after its own www-strip and trailing-dot trim — "www.",
 * ".", "WWW." all measure empty (packages/core/src/url.ts, confirmed by
 * direct evaluation). A bare `if (domain !== "") return registrableHost(domain)`
 * treats "domain present" as "key present", but the two can split: a domain
 * that IS present and non-blank can still collapse to `""` once
 * `registrableHost` runs. That `""` is not a safe key — it is the SAME key a
 * second, unrelated degenerate-domain row would also collapse to, so two
 * different companies fold onto one drift entry and `buildAuditPacket`
 * (audit.ts) silently drops the second one as a "duplicate" of the first.
 * Falling through to this function's own no-domain branch instead — the
 * identical `kind:name` key a row with no domain at all already gets — costs
 * nothing (a name is still what a domain-less row is identified by) and
 * removes the collision. `edgeEndpointKey` below folds a raw endpoint through
 * `registrableHost` the same bare way and shares the same exposure; left for
 * a future fire since it has no direct unit test to pin it against today
 * (only reachable through diffMaps' edge sets).
 */
export function entityKey(e: DriftEntityRow): string {
  const domain = blank(e.domain)
  const host = domain !== "" ? registrableHost(domain) : ""
  if (host !== "") return host
  return `${blank(e.kind)}:${blank(e.name).toLowerCase()}`
}

const WATCHED: readonly DriftField[] = ["kind", "relation", "tier"]

function indexByKey(rows: DriftEntityRow[]): Map<string, DriftEntityRow> {
  const index = new Map<string, DriftEntityRow>()
  for (const row of rows) {
    const key = entityKey(row)
    if (!index.has(key)) index.set(key, row)
  }
  return index
}

/**
 * An edge endpoint, folded the way `entityKey`'s domain branch folds one — but
 * `e.from`/`e.to` are not always domains. `MapState.entityEdges()` (packages/
 * swarm/src/map.ts, `domainOf`) falls a domain-less entity's endpoint back to
 * its own internal node key, `${kind}:${slug(name)}` (`nodeKey`, same file) —
 * the identical shape `entityKey`'s own no-domain branch mints for that same
 * entity, four lines up. `registrableHost` was built for domains and does not
 * know that shape: fed "community:community.cloudflare.com" (a real one — see
 * from-sweep.ts's own GAP_CLUSTER comment, which cites this exact host as a
 * domain-less community entry) it treats the colon-joined string as a
 * three-label host and keeps only its last two labels. Confirmed by direct
 * evaluation: registrableHost("community:community.cloudflare.com") ===
 * registrableHost("cloudflare.com") === "cloudflare.com" — a domain-less
 * community page and the unrelated company it happens to be named after fold
 * onto the same edge key, so an edge that actually moved from one to the
 * other reads as unchanged. A bare domain never contains ":" — no
 * `e.domain`/`e.anchor` value read anywhere in this codebase does — so that
 * character is the one reliable signal nodeKey's own fallback already gives:
 * a key carrying it is opaque and passes through case-folded only, exactly as
 * entityKey's no-domain branch leaves the entity it names.
 */
const edgeEndpointKey = (raw: string): string => (raw.includes(":") ? raw.trim().toLowerCase() : registrableHost(raw))

/** An edge's identity: hosts folded the same way entity keys are, relation included —
 *  the same pair related two ways is two claims, and each drifts on its own. */
function edgeKeys(edges: DriftEdgeRow[]): Set<string> {
  return new Set(edges.map((e) => `${edgeEndpointKey(e.from)} -${e.relation}-> ${edgeEndpointKey(e.to)}`))
}

export function diffMaps(a: DriftMap, b: DriftMap): MapDrift {
  const ia = indexByKey(a.entities)
  const ib = indexByKey(b.entities)

  const left = [...ia.keys()].filter((k) => !ib.has(k)).sort()
  const entered = [...ib.keys()].filter((k) => !ia.has(k)).sort()

  const changed: FieldChange[] = []
  let unchangedCount = 0
  for (const key of [...ia.keys()].filter((k) => ib.has(k)).sort()) {
    const rowA = ia.get(key)!
    const rowB = ib.get(key)!
    const before = changed.length
    for (const field of WATCHED) {
      const from = blank(rowA[field])
      const to = blank(rowB[field])
      if (from !== "" && to !== "" && from !== to) changed.push({ key, field, from, to })
    }
    if (changed.length === before) unchangedCount++
  }

  const ea = edgeKeys(a.edges ?? [])
  const eb = edgeKeys(b.edges ?? [])
  return {
    entered,
    left,
    changed,
    unchangedCount,
    edgesEntered: [...eb].filter((k) => !ea.has(k)).sort(),
    edgesLeft: [...ea].filter((k) => !eb.has(k)).sort(),
  }
}

/** The provenance ladder, scorecard's ordering: own-page > page > snippet.
 *  A tier outside it gets its move stated without a direction word. */
const TIER_RANK: Record<string, number> = { snippet: 0, page: 1, "own-page": 2 }

function tierDirection(from: string, to: string): "stronger" | "weaker" | null {
  const a = TIER_RANK[from]
  const b = TIER_RANK[to]
  if (a === undefined || b === undefined || a === b) return null
  return b > a ? "stronger" : "weaker"
}

const entities = (n: number) => (n === 1 ? "entity" : "entities")

/** One sentence per moved key: "oxylabs.io stayed; its relation moved
 *  competitor -> substitute at a stronger tier: page -> own-page". */
function changedSentence(key: string, moves: FieldChange[]): string {
  const byField = new Map(moves.map((m) => [m.field, m]))
  const clauses: string[] = []
  const kind = byField.get("kind")
  if (kind) clauses.push(`its kind moved ${kind.from} -> ${kind.to}`)
  const relation = byField.get("relation")
  const tier = byField.get("tier")
  if (relation && tier) {
    const direction = tierDirection(tier.from, tier.to)
    const wearing = direction === null ? "a different" : `a ${direction}`
    clauses.push(`its relation moved ${relation.from} -> ${relation.to} at ${wearing} tier: ${tier.from} -> ${tier.to}`)
  } else if (relation) {
    clauses.push(`its relation moved ${relation.from} -> ${relation.to}`)
  } else if (tier) {
    const direction = tierDirection(tier.from, tier.to)
    clauses.push(
      direction === null
        ? `its tier moved ${tier.from} -> ${tier.to}`
        : `its tier moved to a ${direction} rung: ${tier.from} -> ${tier.to}`,
    )
  }
  return `${key} stayed; ${clauses.join("; ")}`
}

/**
 * The drift as fact sentences, the scorecard's discipline: every line a
 * checkable count or a named move, no judgement vocabulary — "churn",
 * "unstable", "better map" are the reader's words to reach or refuse.
 */
export function driftSentences(diff: MapDrift): string[] {
  const lines: string[] = []

  const byKey = new Map<string, FieldChange[]>()
  for (const move of diff.changed) {
    const held = byKey.get(move.key)
    if (held) held.push(move)
    else byKey.set(move.key, [move])
  }
  for (const [key, moves] of byKey) lines.push(changedSentence(key, moves))

  lines.push(
    diff.left.length === 0 && diff.entered.length === 0
      ? "no entities entered or left the map"
      : `${diff.left.length} ${entities(diff.left.length)} left the map; ${diff.entered.length} entered`,
  )
  lines.push(
    diff.unchangedCount === 0
      ? "no entities stayed unchanged"
      : `${diff.unchangedCount} ${entities(diff.unchangedCount)} stayed unchanged`,
  )
  lines.push(
    diff.edgesLeft.length === 0 && diff.edgesEntered.length === 0
      ? "no edges entered or left the map"
      : `${diff.edgesLeft.length} ${diff.edgesLeft.length === 1 ? "edge" : "edges"} left the map; ${diff.edgesEntered.length} entered`,
  )
  return lines
}
