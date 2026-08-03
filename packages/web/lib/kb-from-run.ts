import type { Entity, SweepResult } from "@open-kb/sweep"
import { nodeTypeOf, type NodeType } from "./nodeTypes"
import type {
  GraphEdge,
  GraphView,
  GraphViewNode,
  KbManifest,
  KbSummary,
  KbView,
  NoteRef,
  NoteView,
  TypeCounts,
} from "./viewTypes"
import type { StoredRun } from "./runs"

/**
 * THE reading layer: a completed run, read as a knowledge base.
 *
 * what this replaces. v1 had `lib/kb-read.ts`, which listed a blob store of
 * markdown notes and built its graph from the `[[wikilinks]]` inside them. That
 * store is not part of this rewrite. A "KB" here is a completed RUN and a
 * "note" is one classified entity, so this file is the whole translation: run
 * in, the shapes in lib/viewTypes.ts out. Nothing above it knows there was ever
 * a note store, and nothing in `packages/` knows there is a browser.
 *
 * It is a pure function of a `SweepResult`. No fetch, no disk (lib/runs.ts owns
 * that), no caching, a run is a fixed object once it is finished, so a reader
 * that re-derives is a reader that cannot go stale.
 */

/* ---------------------------------------------------------------- the mapping */

/**
 * Entity kind to node type.
 *
 * The canvas colours off `NodeType`, and its four colours come from the
 * `--type-*` tokens in globals.css. Six kinds land on four colours:
 *
 *   company    -> player      a vendor in this market
 *   product    -> product
 *   community  -> community
 *   publisher  -> community   a blog, newsletter or news site
 *   directory  -> community   G2, Capterra, an "awesome-x" list
 *
 * Publisher and directory take lavender rather than rival-pink: G2 does not
 * compete with Resend, and pink would claim it does. They are third-party
 * venues where the market lists and discusses itself, which is what v1's
 * community bucket held.
 *
 * The collapse loses information, so every node and card also shows the
 * classifier's own `kind`. `noise` maps to nothing; see `graphOf`'s `dangling`.
 */
const KIND_GROUP: Record<string, string> = {
  company: "players",
  product: "products",
  community: "communities",
  publisher: "communities",
  directory: "communities",
}

/**
 * Placement weight: what fills v1's `relevance` slot.
 *
 * v1 scored every note 0-100 during its build. This engine measures nothing
 * like it, so this is a rank derived from the only ordering a run asserts: how
 * firmly the classifier placed the entity. Labels say "placement" rather than
 * "relevance"; the field keeps v1's name because components read it.
 *
 * Delete this map if the sweep ever returns `seenIn`. Do not tune it.
 */
const RELATION_WEIGHT: Record<string, number> = {
  competitor: 95,
  substitute: 85,
  dependency: 70,
  integration: 65,
  shaper: 55,
  buyer: 45,
  target: 40,
  // Channel relations: below every commercial one, well above `none`.
  lists: 38,
  covers: 35,
  discusses: 32,
  none: 15,
}

const ANCHOR_PATH = "company.md"

/* ------------------------------------------------------------------ utilities */

/** `postmarkapp.com` -> `players/postmarkapp.com.md`.
 *
 *  An ID, not a filesystem path. `nodeTypeOf`, `groupLabel`, `glyphForNotePath`
 *  and `NotesTab` all parse "<group>/<file>.md", which is what let them come
 *  across from v1 unedited. The `.md` is vestigial. */
function pathFor(group: string, e: Entity): string {
  const base = (e.domain || e.name || "unknown").trim().toLowerCase().replace(/^www\./, "")
  const safe = base.replace(/[/\\?#]/g, "-") || "unknown"
  return `${group}/${safe}.md`
}

/** One entity per host. The classifier batches, so a host can come back twice.
 *  First placement wins, except that any real relation beats `none`. */
function dedupe(entities: readonly Entity[]): Entity[] {
  const by = new Map<string, Entity>()
  for (const e of entities) {
    const key = (e.domain || e.name || "").trim().toLowerCase().replace(/^www\./, "")
    if (!key) continue
    const prev = by.get(key)
    if (!prev) by.set(key, e)
    else if (prev.relation === "none" && e.relation !== "none") by.set(key, e)
  }
  return [...by.values()]
}

const tally = (xs: string[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})

function emptyCounts(): TypeCounts {
  return { core: 0, product: 0, player: 0, community: 0 }
}

/* -------------------------------------------------------------------- the map */

/** Everything the four surfaces need, derived once. */
interface Placed {
  entity: Entity
  path: string
  group: string
  type: NodeType
  relevance: number
}

function place(result: SweepResult): { kept: Placed[]; noise: Entity[] } {
  const kept: Placed[] = []
  const noise: Entity[] = []

  /**
   * The anchor is `company.md`. Drop it if it also comes back as a player.
   *
   * A company appears in its own search results, so the classifier classifies
   * it. On two live maps that drew the anchor twice: one joined to itself by a
   * `shaper` edge, the other filling the "1 unplaced" badge with the company
   * the map is of.
   *
   * Dropped, not merged: `company.md` comes from a full page read.
   */
  const anchorHost = (result.anchor || "").trim().toLowerCase().replace(/^www\./, "")

  for (const e of dedupe(result.entities)) {
    const host = (e.domain || e.name || "").trim().toLowerCase().replace(/^www\./, "")
    if (anchorHost && host === anchorHost) continue

    const group = KIND_GROUP[e.kind]
    // `noise` is the classifier saying "this is not in this market at all".
    // It gets no node, it becomes a dangling link instead, which is the
    // truthful shape: the run paid for the host and put nothing on the map.
    if (!group) {
      noise.push(e)
      continue
    }
    kept.push({
      entity: e,
      path: pathFor(group, e),
      group,
      type: nodeTypeOf(group),
      relevance: RELATION_WEIGHT[e.relation] ?? RELATION_WEIGHT.none,
    })
  }
  return { kept, noise }
}

/** The anchor itself, as a node. It is the hub the whole map hangs off, so it
 *  is core-typed and carries the top placement, nothing on the map is more
 *  firmly placed than the company the map is OF. */
function anchorRef(result: SweepResult): NoteRef {
  return {
    path: ANCHOR_PATH,
    title: result.anchor,
    relevance: 100,
    type: "core",
    kind: "anchor",
    relation: "anchor",
    domain: result.anchor,
    what: result.decomposition.sells,
    why: result.decomposition.buyer,
  }
}

export function manifestOf(run: StoredRun): KbManifest {
  const r = run.result
  const report = (r.report ?? {}) as Record<string, unknown>
  const { kept } = place(r)
  return {
    slug: run.id,
    input: r.anchor,
    brand: r.anchor,
    root: r.anchor,
    builtAt: new Date(run.endedAt ?? run.startedAt).toISOString(),
    notes: kept.length + 1,
    queries: r.stats.queries,
    // v1's "violations" was a failed quality check per note. This engine runs
    // no such check, and reporting 0 would claim one passed. The KB surfaces
    // read `violations` through `manifestNum`, which returns undefined for an
    // absent key, so it is left absent on purpose.
    usd: r.stats.usd,
    seconds: r.stats.seconds,
    results: r.stats.results,
    hosts: r.stats.hosts,
    sells: r.decomposition.sells,
    buyer: r.decomposition.buyer,
    products: r.decomposition.products.length,
    stopReason: run.status === "complete" ? "swept" : run.status,
    cost: report.cost,
  }
}

export function summaryOf(run: StoredRun): KbSummary {
  const { kept, noise } = place(run.result)
  const counts = emptyCounts()
  counts.core = 1 // the anchor
  for (const p of kept) counts[p.type] += 1
  return {
    slug: run.id,
    manifest: manifestOf(run),
    counts,
    notes: kept.length + 1,
    unplaced: kept.filter((p) => p.entity.relation === "none").length,
    noise: noise.length,
  }
}

export function viewOf(run: StoredRun): KbView {
  const { kept } = place(run.result)
  const counts = emptyCounts()
  counts.core = 1
  for (const p of kept) counts[p.type] += 1

  const notes: NoteRef[] = [
    anchorRef(run.result),
    ...kept.map(
      (p): NoteRef => ({
        path: p.path,
        title: p.entity.name || p.entity.domain,
        relevance: p.relevance,
        type: p.type,
        kind: p.entity.kind,
        relation: p.entity.relation,
        domain: p.entity.domain,
        what: p.entity.what,
        why: p.entity.why,
      }),
    ),
  ].sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path))

  return {
    slug: run.id,
    manifest: manifestOf(run),
    counts,
    notes,
    kinds: tally(kept.map((p) => p.entity.kind)),
    relations: tally(kept.map((p) => p.entity.relation)),
  }
}

export function noteOf(run: StoredRun, path: string): NoteView | null {
  const r = run.result
  if (path === ANCHOR_PATH) {
    const d = r.decomposition
    return {
      path: ANCHOR_PATH,
      title: r.anchor,
      relevance: 100,
      evidence: d.buyer,
      sources: [{ url: `https://${r.anchor}` }],
      what: d.sells,
      type: "core",
      kind: "anchor",
      relation: "anchor",
      domain: r.anchor,
    }
  }
  const hit = place(r).kept.find((p) => p.path === path)
  if (!hit) return null
  return {
    path: hit.path,
    title: hit.entity.name || hit.entity.domain,
    relevance: hit.relevance,
    evidence: hit.entity.why,
    // An entity's one source is the host itself: the run saw it in a search
    // result and read its title and description. There is no retrieval
    // timestamp per entity, so none is claimed.
    sources: hit.entity.domain ? [{ url: `https://${hit.entity.domain}` }] : [],
    what: hit.entity.what,
    type: hit.type,
    kind: hit.entity.kind,
    relation: hit.entity.relation,
    domain: hit.entity.domain,
  }
}

/**
 * The map, as the canvas eats it.
 *
 * A star, honestly. The sweep classifies each host against the anchor and
 * nothing else, it never asks whether two competitors integrate with each
 * other, so the only edges it can substantiate run anchor -> entity. Drawing
 * cross-links would be drawing relationships nobody measured, so the topology
 * stays a star and the canvas's hub-heavy banner (which exists to explain
 * exactly this shape) is left to say so.
 */
export function graphOf(run: StoredRun): GraphView {
  const r = run.result
  const { kept, noise } = place(r)

  const nodes: GraphViewNode[] = [
    {
      id: ANCHOR_PATH,
      type: "core",
      relevance: 100,
      title: r.anchor,
      group: "overview",
      kind: "anchor",
      relation: "anchor",
      what: r.decomposition.sells,
      why: r.decomposition.buyer,
      domain: r.anchor,
    },
    ...kept.map(
      (p): GraphViewNode => ({
        id: p.path,
        type: p.type,
        relevance: p.relevance,
        title: p.entity.name || p.entity.domain,
        group: p.group,
        kind: p.entity.kind,
        relation: p.entity.relation,
        what: p.entity.what,
        why: p.entity.why,
        domain: p.entity.domain,
      }),
    ),
  ]

  // `relation: none` is the classifier declining to place something. There is
  // no edge to draw, so none is drawn, the node sits unconnected and is
  // reported as an orphan rather than wired to the hub with a made-up label.
  const edges: GraphEdge[] = kept
    .filter((p) => p.entity.relation !== "none")
    .map((p) => ({
      source: ANCHOR_PATH,
      target: p.path,
      label: p.entity.relation,
    }))

  return {
    slug: run.id,
    nodes,
    edges,
    dangling: noise.map((e) => ({
      from: ANCHOR_PATH,
      target: e.domain || e.name,
    })),
    orphans: kept.filter((p) => p.entity.relation === "none").map((p) => p.path),
  }
}
