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

/** The relations the skill teaches, stated from the anchor outward. Mirrors
 *  core's JUDGED_RELATIONS — the harvest-classify path (packages/swarm/src/
 *  agent.ts) binds its schema to JUDGED_RELATIONS, so a value that vocabulary
 *  accepts but this one does not is money already spent on a verdict this
 *  map cannot record. "adjacent" landed in JUDGED_RELATIONS without landing
 *  here first; kept in sync now, and checked for the next relation too. */
export const SWARM_RELATIONS = [
  "competitor",
  "substitute",
  "adjacent",
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
   *  the run-JSON shape is unchanged; the scorecard, the family floor and the
   *  landing digest (`landedBy`) all read the live MapState. Three readers now
   *  rest on this stamp landing on EVERY write, merges included — it is the
   *  only record of who wrote what, and the digest that steers the lead is
   *  computed from nothing else. */
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
  // The scheme strip has to be case-insensitive: registrableHost lowercases
  // its input, but only AFTER this line runs. A domain arriving as
  // "HTTPS://Example.com" (a model echoing a URL it just read, capitals and
  // all) missed the old `/^https?:\/\//` match, so `.split("/")[0]` kept
  // "HTTPS:" as the host and every such node minted the same garbage key —
  // silently merging unrelated companies that all happened to arrive
  // uppercase.
  const host = domain.trim() ? registrableHost(domain.trim().replace(/^https?:\/\//i, "").split("/")[0] ?? "") : ""
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

  /** The keys a reader would see right now. A writer takes this snapshot before
   *  it starts so `landedBy` can tell what it FOUND from what was already here;
   *  live-only on both ends, so a node retracted before the writer began and
   *  re-created by it counts as the find it was. */
  liveKeys(): Set<string> {
    const out = new Set<string>()
    for (const [key, n] of this.nodes) if (!n.retracted) out.add(key)
    return out
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

/**
 * The landing digest's question: what did ONE writer's own claims do to this
 * map? `added` are the live nodes carrying its stamp that were not on the map
 * when it started; `merged` are the ones that already were.
 *
 * Why it is not a map-size delta. Up to six investigator lanes write to one
 * MapState, so a size delta over a mission's lifetime is its neighbours' work
 * as much as its own — and the lead steers by that number. Measured on the
 * runs: the seven missions of `runs/swarm-grundfos-com-202608060814.json`
 * report 20 nodes and 16 edges added between them, while the whole run's span
 * stream holds three remember calls claiming 13 nodes and 4 edges — more was
 * reported than was ever claimed by anyone. `runs/swarm-brightdata-com-
 * 202608060833.json` reports 93 nodes across 16 missions against a 28-node
 * map, with `verify:scrapfly.io` and `verify:decodo.com` landing 0.3s apart
 * each claiming the same 7 nodes and 7 edges. The stamps already record who
 * wrote what (`MapNode.contributions`, tools-free.ts:603/617); this reads them.
 *
 * BOTH HALVES ARE INVARIANT TO THE NEIGHBOURS, which is the property the delta
 * lacked: the only inputs are this writer's own stamps and a snapshot taken
 * before any neighbour could move. Two things the stamps deliberately do not
 * buy:
 *
 *  - Co-discovery. `contributions` is a SET — arrival order is meaningless
 *    under concurrency and readers are told not to depend on it — so when two
 *    lanes land the same host inside one lifetime, neither the map nor this
 *    function can say who was first and BOTH count it as added. That is a
 *    bounded double-count on one shared host, against a delta inflated by
 *    every neighbour's every write. A `firstWriter` field would settle it and
 *    is not worth a second attribution mechanism on the map.
 *  - Retracted nodes, which count for nobody, the same rule pageTierByWriter
 *    keeps: the lead steers by the map a reader gets. A neighbour's retraction
 *    can still move this number, in the honest direction — the node is gone.
 *
 * Whether a merge deserves credit is answered by REPORTING BOTH, never by
 * folding them: two lanes proving one host is real work, and a mission that
 * only confirmed must not read to the lead as a mission that found nothing.
 */
export function landedBy(
  map: MapState,
  writer: string,
  liveBefore: ReadonlySet<string>,
): { added: MapNode[]; merged: MapNode[] } {
  const added: MapNode[] = []
  const merged: MapNode[] = []
  for (const n of map.nodes.values()) {
    if (n.retracted) continue
    if (!n.contributions.some((c) => c.writer === writer)) continue
    ;(liveBefore.has(n.key) ? merged : added).push(n)
  }
  return { added, merged }
}
