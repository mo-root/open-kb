import { registrableHost, type Evidence, type UnreadableReason } from "@open-kb/core"
import { type ProvenanceTier } from "./run-evidence.js"

/**
 * The map a swarm run accumulates: nodes and edges in the sweep's own field
 * vocabulary, so a finished run serializes into the run-JSON shape
 * `packages/web/lib/kb-from-run.ts` already renders — name/domain/kind/what/
 * relation/why/because on entities, from/to/relation/why/confidence on edges.
 * The swarm's own additions (identity key, computed provenance tier, minted
 * evidence, retraction) ride alongside and serialize harmlessly.
 *
 * Identity: a company or product IS its registrable host — `docs.apify.com`
 * and `apify.com` are one node, keyed `apify.com`. Kinds without a domain
 * (capability, buyer, community without a home) key on `kind:name-slug`.
 * Merge keys on that identity, so two writers landing the same company from
 * different angles converge on one node whichever arrives first.
 */

/** The kinds the skill teaches. `remember` refuses anything else with a sentence. */
export const SWARM_NODE_KINDS = ["company", "product", "capability", "buyer", "community"] as const

/** The relations the skill teaches, stated from the anchor outward. */
export const SWARM_RELATIONS = [
  "competitor",
  "substitute",
  "shaper",
  "dependency",
  "integration",
  "buyer",
  "target",
  "covers",
  "lists",
  "discusses",
  "unknown",
] as const

/** One writer's stamp on a node: who landed a claim here, and at what
 *  provenance tier THAT claim proved out — the mission dedupeKey for an
 *  investigator's remembers, "lead" for the lead's own. */
export interface Contribution {
  writer: string
  tier: ProvenanceTier
}

export interface MapNode {
  /** Identity: registrableHost(domain) for company/product; `kind:slug` otherwise. */
  key: string
  name: string
  domain: string
  kind: string
  what: string
  relation: string
  why: string
  /** Present when the kernel downgraded the claim; the node wears its refusal. */
  because?: string
  /** Harvested unknowns only: WHY the front page could not be read, as the
   *  sniffer's stable code — the sentence in `because` is for the reader,
   *  this is for arithmetic. Stamped by the judge kernel, landed through
   *  remember's passthrough; never claimable by a model (the tool schema
   *  does not offer it). */
  unreadableReason?: UnreadableReason
  /** Harvested nodes only: HOW the judge settled this host — predicate
   *  arithmetic ($0) or a model call. Metadata about the judging, not a
   *  claim about the market; same passthrough rule as above. */
  settledBy?: "predicate" | "model"
  /** How much of the standing `what`'s vocabulary its verified material — the
   *  claim's minted quotes plus the host's own stored page — actually says,
   *  2 decimals, measured when that what landed. The swarm's half of
   *  span-bound descriptions: MEASUREMENT ONLY, recorded by `remember`; the
   *  gate lives in the sweep kernel. */
  descGrounded?: number
  /** Computed from the evidence, never asserted: own-page > page > snippet. */
  tier: ProvenanceTier
  evidence: Evidence[]
  /** Competing accounts kept on merge — a collision between two writers is
   *  usually two true descriptions of one company, not a duplicate. Each entry
   *  keeps the displaced `what`, and the displaced `name` when it had its own —
   *  a product folded into its host node stays recoverable by name. */
  also: Array<{ name?: string; what: string }>
  /** Run-local writer attribution: every remember that adds or merges into
   *  this node appends its stamp, identical {writer, tier} pairs deduped.
   *  Semantically a SET — concurrent lanes make arrival order meaningless, so
   *  readers must not depend on it. Never serialized: entities() omits it and
   *  the run-JSON shape is unchanged; the scorecard reads the live MapState. */
  contributions: Contribution[]
  retracted?: { why: string }
}

export interface MapEdge {
  /** Node keys, not display names. */
  from: string
  to: string
  relation: string
  why: string
  confidence: "measured" | "inferred"
  evidence: Evidence[]
  retracted?: { why: string }
}

/** A sweep-shaped entity row, exactly what run-JSON `entities` carries. */
export interface EntityRow {
  name: string
  domain: string
  kind: string
  what: string
  relation: string
  why: string
  because?: string
  /** Harvested unknowns only: the sniffer's stable code beside the because —
   *  the same field the sweep's entities persist, so a stored swarm map can
   *  say "3 bot-walled, 2 JS-only" instead of "5 unknown". */
  unreadableReason?: UnreadableReason
  /** Harvested nodes only: HOW the judge settled the host — predicate
   *  arithmetic or a model call — exactly as judgeHosts stamped it. */
  settledBy?: "predicate" | "model"
  /** `MapNode.descGrounded`, carried into the run JSON under the same name the
   *  sweep's entities already use — the reader's view model picks it up with
   *  no new vocabulary. */
  descGrounded?: number
  tier: ProvenanceTier
  /** The merged-away accounts, when a collision kept them (`MapNode.also`).
   *  Present only when non-empty, so a node that never merged keeps the exact
   *  row shape it always had. Without this the "a product folded into its host
   *  node stays recoverable by name" promise was true only in memory — the
   *  run JSON dropped the fold and no reader could ever show it. */
  also?: Array<{ name?: string; what: string }>
}

/** A sweep-shaped edge row, exactly what run-JSON `edges` carries. */
export interface EntityEdgeRow {
  from: string
  to: string
  relation: string
  why: string
  confidence: "measured" | "inferred"
}

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-")

/** The one place a node key is minted. "" when the item cannot be keyed. */
export function nodeKey(kind: string, name: string, domain: string): string {
  const host = domain.trim() ? registrableHost(domain.trim().replace(/^https?:\/\//, "").split("/")[0] ?? "") : ""
  if (kind === "company" || kind === "product") return host
  if (host) return host
  return name.trim() ? `${kind}:${slug(name)}` : ""
}

export class MapState {
  /** The anchor's registrable host. On the map by construction; edges may name it. */
  readonly anchor: string
  readonly nodes = new Map<string, MapNode>()
  readonly edges: MapEdge[] = []
  /** Every retraction that landed, in order — retraction is a claim with a why. */
  readonly retractions: Array<{ target: string; why: string }> = []

  constructor(anchorDomain: string) {
    this.anchor = registrableHost(anchorDomain)
  }

  /** Live nodes in the sweep's entity shape. A retracted node is off the map. */
  entities(): EntityRow[] {
    const out: EntityRow[] = []
    for (const n of this.nodes.values()) {
      if (n.retracted) continue
      out.push({
        name: n.name,
        domain: n.domain,
        kind: n.kind,
        what: n.what,
        relation: n.relation,
        why: n.why,
        ...(n.because ? { because: n.because } : {}),
        ...(n.unreadableReason ? { unreadableReason: n.unreadableReason } : {}),
        ...(n.settledBy ? { settledBy: n.settledBy } : {}),
        ...(n.descGrounded !== undefined ? { descGrounded: n.descGrounded } : {}),
        tier: n.tier,
        ...(n.also.length ? { also: n.also.map((a) => ({ ...a })) } : {}),
      })
    }
    return out
  }

  /** Live edges in the sweep's edge shape, domains at the endpoints. An edge
   *  whose end was retracted goes with it — a dangling edge is worse than a
   *  missing one. */
  entityEdges(): EntityEdgeRow[] {
    const live = (key: string) => key === this.anchor || !this.nodes.get(key)?.retracted
    const domainOf = (key: string) => this.nodes.get(key)?.domain || key
    return this.edges
      .filter((e) => !e.retracted && this.endpointOnMap(e.from) && this.endpointOnMap(e.to) && live(e.from) && live(e.to))
      .map((e) => ({
        from: domainOf(e.from),
        to: domainOf(e.to),
        relation: e.relation,
        why: e.why,
        confidence: e.confidence,
      }))
  }

  endpointOnMap(key: string): boolean {
    return key === this.anchor || this.nodes.has(key)
  }
}

/**
 * The scorecard's per-family question, as one query: for each writer, how many
 * LIVE nodes did that writer land page-or-better evidence on? "Page-or-better"
 * is a claim whose own quotes came from a fetched page (page or own-page) —
 * snippet stamps do not count. Retracted nodes do not count either: the
 * scorecard grades the map a reader gets, though the contribution record
 * itself survives retraction for the audit trail. A writer with no qualifying
 * node is absent from the result — read with `?? 0`.
 */
export function pageTierByWriter(map: MapState): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of map.nodes.values()) {
    if (n.retracted) continue
    const writers = new Set(
      n.contributions.filter((c) => c.tier === "page" || c.tier === "own-page").map((c) => c.writer),
    )
    for (const w of writers) out.set(w, (out.get(w) ?? 0) + 1)
  }
  return out
}
