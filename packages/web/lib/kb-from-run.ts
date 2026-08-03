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
 * THE READING LAYER: a completed run, read as a knowledge base.
 *
 * WHAT THIS REPLACES. v1 had `lib/kb-read.ts`, which listed a blob store of
 * markdown notes and built its graph from the `[[wikilinks]]` inside them. That
 * store is not part of this rewrite. A "KB" here is a COMPLETED RUN and a
 * "note" is one classified entity, so this file is the whole translation: run
 * in, the shapes in lib/viewTypes.ts out. Nothing above it knows there was ever
 * a note store, and nothing in `packages/` knows there is a browser.
 *
 * It is a pure function of a `SweepResult`. No fetch, no disk (lib/runs.ts owns
 * that), no caching — a run is a fixed object once it is finished, so a reader
 * that re-derives is a reader that cannot go stale.
 */

/* ---------------------------------------------------------------- the mapping */

/**
 * ENTITY KIND -> NODE TYPE, and why.
 *
 * The canvas keys colour off `NodeType`, and those four colours come from the
 * `--type-*` tokens in globals.css, which brand law fixes across both themes.
 * A fifth type would need a fifth token, so six kinds have to land on four
 * colours and the collapse has to be defensible:
 *
 *   company    -> player     a vendor in this market. v1's pink is the "rival"
 *                            hue and a company on this map is here because it
 *                            plays in the same market, whatever its relation.
 *   product    -> product    same word, same meaning, same blue.
 *   community  -> community  same word, same meaning, same lavender.
 *   publisher  -> community  a blog, a newsletter, a news site.
 *   directory  -> community  G2, Capterra, an "awesome-x" list.
 *
 * Publisher and directory are the judgement call. They are NOT players: G2 does
 * not compete with Resend and colouring it rival-pink would assert that it
 * does. They are not products either. What they ARE is third-party venues where
 * this market talks about itself and lists itself — which is precisely what v1's
 * `community` bucket held (subreddits, forums, conferences, NEWSLETTERS). So
 * they take the lavender.
 *
 * The collapse is lossy, so the loss is never hidden: every node, note ref and
 * detail card carries the classifier's own `kind` alongside its colour, and the
 * graph legend's footnote says the lavender covers three kinds.
 *
 * `noise` maps to nothing — see `graphOf`'s `dangling`.
 */
const KIND_GROUP: Record<string, string> = {
  company: "players",
  product: "products",
  community: "communities",
  publisher: "communities",
  directory: "communities",
}

/**
 * PLACEMENT WEIGHT — what fills v1's `relevance` slot, and what it is not.
 *
 * v1 scored every note 0-100 during its build and the canvas reads that number
 * for node radius, the top-N labels, the prov-rail and every sort. This engine
 * measures no such thing: `SweepResult.entities` carries a name, a domain, a
 * kind, a relation and two sentences. The one signal that WOULD be a
 * measurement — how many distinct queries surfaced a host — is computed inside
 * the sweep and not returned, and `packages/sweep/src` is not ours to change.
 *
 * So this is a RANK, derived from the only ordering the run actually asserts:
 * how firmly the classifier placed the entity against the anchor. It is an
 * honest ordering and a dishonest measurement, which is why every label that
 * shows it to a reader says "placement" and not "relevance" — the FIELD keeps
 * v1's name because it is the component contract, the WORDS do not.
 *
 * If the sweep ever returns `seenIn`, this map should be deleted, not tuned.
 */
const RELATION_WEIGHT: Record<string, number> = {
  competitor: 95,
  substitute: 85,
  dependency: 70,
  integration: 65,
  shaper: 55,
  buyer: 45,
  target: 40,
  // The channel relations. Ranked under every commercial one — a competitor
  // matters more to a reader than a blog that covered it — but far above `none`,
  // because a publication that covers this market is placed, not unplaced.
  lists: 38,
  covers: 35,
  discusses: 32,
  none: 15,
}

const ANCHOR_PATH = "company.md"

/* ------------------------------------------------------------------ utilities */

/** `postmarkapp.com` -> `players/postmarkapp.com.md`.
 *
 *  The path SHAPE is load-bearing: `nodeTypeOf`, `groupLabel`,
 *  `glyphForNotePath` and `NotesTab`'s grouping are all written against
 *  "<group>/<file>.md", and keeping the shape is what let all four come across
 *  from v1 without an edit.
 *
 *  It is an ID, never a filesystem path — nothing here opens a file. The
 *  slashes and dots are what those four functions read, and the `.md` is
 *  vestigial: it is kept only so a v1-shaped id still means what it meant. */
function pathFor(group: string, e: Entity): string {
  const base = (e.domain || e.name || "unknown").trim().toLowerCase().replace(/^www\./, "")
  const safe = base.replace(/[/\\?#]/g, "-") || "unknown"
  return `${group}/${safe}.md`
}

/** One entity per host. The classifier runs in batches and the same host can
 *  come back twice; the first placement wins, except that a real relation
 *  always beats `none` — a second look that PLACED something is better
 *  evidence than a first look that shrugged. */
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
   * The anchor is already `company.md`. It must not also be a player.
   *
   * The sweep's own domain turns up in its own search results — which is
   * correct, it IS in this market — so the classifier dutifully classifies it,
   * and every surface then counted the map's subject as one of its own findings.
   * Measured on two live maps: brightdata.com was drawn twice and joined to
   * itself by a `shaper` edge, a self-loop presented as a real relation; on the
   * resend.com map the duplicate came back `none`, which made the anchor the
   * entire content of the "1 unplaced" badge — a gap indicator whose only member
   * was the company the map is of.
   *
   * Dropped rather than merged: `company.md` is built from the decomposition,
   * which is a whole page read from the company itself, and a one-line
   * classification of a search result has nothing to add to it.
   */
  const anchorHost = (result.anchor || "").trim().toLowerCase().replace(/^www\./, "")

  for (const e of dedupe(result.entities)) {
    const host = (e.domain || e.name || "").trim().toLowerCase().replace(/^www\./, "")
    if (anchorHost && host === anchorHost) continue

    const group = KIND_GROUP[e.kind]
    // `noise` is the classifier saying "this is not in this market at all".
    // It gets no node — it becomes a dangling link instead, which is the
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
 *  is core-typed and carries the top placement — nothing on the map is more
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
    // absent key — so it is left absent on purpose.
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
 * A STAR, HONESTLY. The sweep classifies each host against the ANCHOR and
 * nothing else — it never asks whether two competitors integrate with each
 * other — so the only edges it can substantiate run anchor -> entity. Drawing
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
  // no edge to draw, so none is drawn — the node sits unconnected and is
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
