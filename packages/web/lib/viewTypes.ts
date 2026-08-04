/* The shapes the /api/kb/** routes return, the contract between the reading
   layer (lib/kb-from-run.ts) and anything that renders a KB.

   Kept apart from the ENGINE's own model on purpose. `@open-kb/sweep`'s
   `SweepResult` is what a run PRODUCES; this is what a reader CONSUMES, and it
   carries fields the engine has no business knowing about (a display title
   derived from a domain, a graph group, a per-type tally for a card). Same
   knowledge, two audiences — and nothing in `packages/` has to change for a
   surface to want a new field.

   PORT NOTE. v1's lib/viewTypes.ts described a KB of markdown NOTES read off a
   blob store: `NoteView` carried a `body` full of `[[wikilinks]]`, and the graph
   was built from those links. There is no note store here and there are no
   wikilinks — a "KB" in this world is a COMPLETED RUN and a "note" is one
   classified entity. The shapes below are v1's, with `body` replaced by the
   four things an entity actually knows (`what`, `why`, `kind`, `relation`) and
   `sources` reduced to the one source an entity has: its own domain.

   `GraphNode` / `GraphEdge` / `DanglingLink` / `GraphView` are reproduced from
   v1's lib/kb/graph.ts + lib/viewTypes.ts exactly as GraphCanvas consumes them,
   plus one field the star topology needs (`GraphEdge.label`, the relation). */

import type { NodeType } from "./nodeTypes"

/* ------------------------------------------------------------------ relations */

/**
 * What each relation means, in a reader's words.
 *
 * It lives here, next to the shapes, rather than in lib/kb-from-run.ts, because
 * every consumer is a client component: the graph's edge tooltip, the entity
 * page's chips, the ecosystem panel. lib/kb-from-run.ts imports lib/runs.ts,
 * which imports `node:fs`, pulling that into a `"use client"` module is how a
 * browser bundle ends up trying to read a directory.
 */
export const RELATION_BLURB: Record<string, string> = {
  competitor: "sells against the anchor for the same buyer",
  substitute: "solves the same problem a different way",
  dependency: "the anchor is built on top of it",
  integration: "plugs into the anchor, or the anchor into it",
  shaper: "sets the terms this market is played under",
  buyer: "buys in this market",
  target: "the anchor is trying to sell to it",
  none: "the classifier saw it and would not place it",
  anchor: "the company this map is of",
}

/**
 * Chip tone per query family, the plain/debranded/branded triad the planner
 * asks in. Lives here, next to `RELATION_BLURB`, for the same reason: the
 * searches panel and an entity's own page both need the identical mapping,
 * and a chip that drifted color between the two surfaces would read as two
 * different facts about the same query. Unknown values (a run recorded
 * before families existed) fall through to the caller's own neutral tone.
 */
export const FAMILY_TONE: Record<string, string> = {
  plain: "text-sky-300 border-sky-500/40 bg-sky-500/10",
  debranded: "text-violet-300 border-violet-400/40 bg-violet-400/10",
  branded: "text-amber-300 border-amber-500/40 bg-amber-500/10",
}

/* ------------------------------------------------------------------ manifest */

/** Whatever a completed run recorded about itself.
 *
 *  Every field is optional and unknown keys survive: a run recorded before a
 *  field existed is a real run, and a listing that threw on it would hide
 *  knowledge that is sitting right there. The reader treats a missing manifest
 *  (`null`) as normal, never as an error. */
export interface KbManifest {
  slug?: string
  input?: string
  brand?: string
  /** ISO timestamp. `built_at` is accepted as a synonym, v1's reference engine
   *  wrote snake_case and this one writes camelCase; both are the same fact. */
  builtAt?: string
  built_at?: string
  notes?: number
  queries?: number
  violations?: number
  usd?: number
  [key: string]: unknown
}

/* --------------------------------------------------------------------- notes */

/** Substantive entities per type. */
export type TypeCounts = Record<NodeType, number>

export interface KbSummary {
  slug: string
  manifest: KbManifest | null
  counts: TypeCounts
  /** Substantive entities, the anchor and everything the classifier kept. */
  notes: number
  /** On the map but connected to nothing: `relation: "none"`. v1's card badged
   *  "violations" here, a quality check this engine does not run, so the slot
   *  carries the number that IS measured instead. */
  unplaced: number
  /** Hosts the run paid for and the classifier threw away as `kind: "noise"`. */
  noise: number
}

/** An entity as it appears in a list: enough to sort, group and label it
 *  without paying to load every body. */
export interface NoteRef {
  /** The anchor's markets whose queries surfaced this, strongest first. The
   *  products tab groups by it, so a reader sees which market each finding
   *  belongs to rather than one undifferentiated grid. */
  foundBy?: string[]
  /** Which of the plain/debranded/branded query families surfaced this host,
   *  strongest-first, same shape as `foundBy`. A host can carry more than one:
   *  a debranded search and a branded one both turning up the same domain is
   *  itself a fact worth showing, not a collision to resolve. */
  families?: string[]
  /** The node id, shaped like a v1 note path, "players/postmarkapp.com.md".
   *  Keeping the path shape is what lets `nodeTypeOf`, `groupLabel`,
   *  `glyphForNotePath` and the canvas's domain reconstruction all carry over
   *  from v1 untouched. */
  path: string
  title: string
  /** placement, not a measurement, see lib/kb-from-run.ts's RELATION_WEIGHT.
   *  The field keeps v1's name because it is the component contract (node
   *  radius, the prov-rail, the sort); every label that shows it to a reader
   *  says "placement". */
  relevance: number
  type: NodeType
  /** The classifier's own word for this host: company · product · community ·
   *  publisher · directory. Six kinds collapse onto four colours (see
   *  lib/kb-from-run.ts), so the uncollapsed fact travels alongside. */
  kind: string
  /** The relation the classifier placed it in against the anchor, `none` when
   *  it would not place it at all. */
  relation: string
  domain: string
  /** What it is, one line. v1 recovered the equivalent tagline by regexing a
   *  bullet list out of `products/_catalog.md`; it rides in the list here, so
   *  the products grid needs no second request and cannot mis-parse. */
  what: string
  /** Why it belongs on this map, stated against the anchor. */
  why: string
}

export interface KbView {
  slug: string
  manifest: KbManifest | null
  /** The company's own name for itself, from the understand stage
   *  (`decomposition.brand`) — e.g. "Resend", not "resend.com". Undefined on
   *  a run recorded before the understand stage wrote it; callers fall back
   *  to their own wording ("this company") rather than the raw domain, which
   *  `manifest.brand`/`slug` already cover elsewhere. */
  brand?: string
  counts: TypeCounts
  /** Strongest placement first, ties broken by path so the order is stable. */
  notes: NoteRef[]
  /** Entity kinds and relations tallied by the reader. v1 recovered the same
   *  tallies by re-parsing a markdown table out of `ecosystem.md`; here they
   *  are counted straight off the run, so there is nothing to mis-parse. */
  kinds: Record<string, number>
  relations: Record<string, number>
  /**
   * The anchor's OWN products, read from its own pages.
   *
   * This was extracted on every run and never shown. The products tab filtered
   * entities of kind `product` instead, which are other companies' products
   * found out in the market, and headed them "Catalog" — so a map of Bright
   * Data listed Honeygain's SDK and Apify's docs as Bright Data products.
   */
  catalog: { name: string; does: string; foundAt?: string }[]
  /** Those products grouped into the markets they sit in, which is the unit the
   *  search budget was actually divided across. */
  markets: { name: string; does: string; centrality?: string; covers: string[] }[]
  /** The pages the understand stage actually read to write the catalog above,
   *  in the order it read them. The citation behind "What <brand> sells": a
   *  reader can follow the same links the model did rather than take the
   *  summary on faith. Empty on a run recorded before this was tracked. */
  readPages: string[]
  /** The strip artifact (spec section "Strip"): per product, the terms a buyer
   *  would actually type, ordered closest-first. Persisted by the sweep and
   *  extracted every run, but never surfaced until now — this is the audit
   *  trail behind the plain-family templates and the widening loop's reserve
   *  draws. Empty on a run recorded before this was tracked. */
  strips: { product: string; terms: string[]; generic: boolean; foundAt: string }[]
}

/** One entity, whole. v1's equivalent carried a markdown `body`; an entity has
 *  two sentences and a domain instead, so those are the fields. */
export interface NoteView {
  path: string
  title: string
  relevance: number
  /** The classifier's reason this entity belongs on the map, stated against
   *  the anchor. Rendered where v1 put a note's `evidence`. */
  evidence: string
  sources: { url: string; retrievedAt?: string }[]
  /** What it is, one line, from what the search results said. */
  what: string
  type: NodeType
  kind: string
  relation: string
  domain: string
  /** Which query families surfaced this entity, strongest-first. Undefined on
   *  the anchor (read from its own pages, not searched for) and on a run
   *  recorded before families existed. */
  families?: string[]
}

/* --------------------------------------------------------------------- graph */

/* port NOTE, TWO OF v1's fields ARE NOT here.
   `GraphNode.isIndex` ("this is a table of contents") and
   `GraphEdge.structural` ("this list merely mentions that note") existed
   because v1's map was markdown wired by wikilinks. This engine writes no
   notes, so both would be `false` on every node and every edge for ever. A
   field that can only hold one value is not a fact, it is furniture — and the
   canvas machinery they drove is re-pointed at `relation: "none"`, which is a
   fact this engine does measure. See the FNode note in GraphCanvas.tsx. */

export interface GraphNode {
  id: string
  type: NodeType
  relevance: number
}

export interface GraphEdge {
  source: string
  target: string
  /** The relation this edge asserts (competitor, integration, …). v1's edges
   *  were untyped wikilinks and had nothing to say; ours are the whole point,
   *  so the label rides along and the canvas's link tooltip reads it. */
  label: string
}

export interface DanglingLink {
  from: string
  target: string
}

/** The engine's graph node plus the three things a reader needs and the engine
 *  does not: a human title, the group to colour/cluster by, and the classifier's
 *  own words for the detail card. */
export interface GraphViewNode extends GraphNode {
  title: string
  /** Top-level group, or "overview" for the anchor. */
  group: string
  kind: string
  relation: string
  what: string
  why: string
  domain: string
}

export interface GraphView {
  slug: string
  nodes: GraphViewNode[]
  edges: GraphEdge[]
  /** v1: "Wikilinks that resolve to nothing: a gap named, not a failure."
   *  Ours: hosts the run paid for and the classifier threw away as noise. The
   *  run saw them and there is no node on the map for them, which is exactly a
   *  dead link, and hiding them would make every map look like it found only
   *  signal. */
  dangling: DanglingLink[]
  /** v1: notes unreachable from company.md. Ours: entities the classifier
   *  placed on the map but would not connect to the anchor, `relation: none`.
   *  They have no edge, so they are unreachable in the literal sense, and the
   *  count is the most honest number on the page. */
  orphans: string[]
}
