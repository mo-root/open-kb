import { registrableHost, type Evidence } from "@open-kb/core"
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
  /** Computed from the evidence, never asserted: own-page > page > snippet. */
  tier: ProvenanceTier
  evidence: Evidence[]
  /** Competing accounts kept on merge — a collision between two writers is
   *  usually two true descriptions of one company, not a duplicate. Each entry
   *  keeps the displaced `what`, and the displaced `name` when it had its own —
   *  a product folded into its host node stays recoverable by name. */
  also: Array<{ name?: string; what: string }>
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
  tier: ProvenanceTier
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
        tier: n.tier,
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
