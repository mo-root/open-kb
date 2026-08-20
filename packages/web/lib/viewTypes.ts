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
  // The channel relations, so a facet chip or edge wearing one can explain
  // itself the same way the commercial ones do.
  lists: "a venue that lists this market's players",
  covers: "a venue that writes about this market",
  discusses: "a venue where this market gets discussed",
  none: "the classifier saw it and would not place it",
  unknown: "claimed but not confirmed by the available evidence",
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

/**
 * The provenance ladder, glossed for a reader. `tier` is where an entity's
 * best evidence came from (swarm runs): its own page, some retrieved page
 * that names it, or only a search-result snippet. Lives here for the same
 * reason as `RELATION_BLURB` — every consumer is a client component, and the
 * badge must mean the same thing on every surface that wears it.
 */
export const TIER_BLURB: Record<string, string> = {
  "own-page": "judged from this entity's own page — the strongest evidence a run collects",
  page: "judged from a retrieved page that names it",
  snippet: "seen only in search-result snippets — the lightest evidence this map accepts",
}

/**
 * What `descGrounded` / `groundingMean` measure, in words that do not
 * overclaim. The number is the fraction of a description's content terms the
 * page the model read actually contains — a drift meter for embellished
 * wording inside correctly-placed entities, established as RELATIVE: useful
 * for comparing runs and spotting outliers, never a defect rate. A mean of
 * 0.68 does not mean 68% of the descriptions are true, and no surface may
 * imply it does.
 */
export const GROUNDING_MEAN_BLURB =
  "Mean fraction of each description's content terms found on the page the model read. " +
  "A relative drift meter for comparing runs and spotting embellished wording — " +
  "not a defect rate: 0.68 does not mean 68% of the descriptions are true."

export const GROUNDING_ENTITY_BLURB =
  "The fraction of this description's content terms found on the page the model read. " +
  "Low flags wording worth checking against the page — it is not the share of the description that is true."

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
  /**
   * The whole-run query ceiling the deployment sized this run to, and the clock
   * it was derived from.
   *
   * Present only on runs a host was timing — the web path, which must finish
   * inside a function limit. A terminal run has neither, and their absence is
   * the honest statement that nothing capped it. The pair matters to a reader
   * because the same engine on the same anchor produces 2,551 entities from a
   * terminal and a few hundred from a four-minute lambda: without these two
   * numbers the second reads as the engine being weak.
   */
  queryCeiling?: number
  clockSeconds?: number
  /** Hosts the run found and never judged, because the clock ran out on the
   *  rank pool. 0 when everything found was judged. */
  unjudged?: number
  /** The kernel's grounding meter (sweep runs, report.kernel.groundingMean):
   *  mean `descGrounded` across model-judged entities. See
   *  `GROUNDING_MEAN_BLURB` for what it does and does not claim. */
  groundingMean?: number
  [key: string]: unknown
}

/* ----------------------------------------------------------------- scorecard */

/** core's `Fraction`, re-declared for the reader: a ratio that ships its own
 *  arithmetic. `value` is `num / den`, or null when `den` is 0 — a fraction
 *  that measured nothing, which renders as a dash, never as 0. */
export interface ScoreFraction {
  num: number
  den: number
  value: number | null
}

/** One planned question, as the swarm's family ledger recorded its life. */
export interface ScorecardFamilyView {
  lens: string
  status: string
  nodesAdded: number
  /** Nodes this family backed with page-or-better evidence — what "this
   *  question got a real answer" means on the scorecard. */
  pageTierNodes: number
  /** The lead's own reason, recorded at the kill. Present on killed rows. */
  because?: string
}

/** The finish gate's record. The objection sentences are fact-sentences the
 *  instrument wrote to be read, so they travel verbatim, never summarized. */
export interface ScorecardGateView {
  refusals: number
  /** As the refusal delivered them — or, with no refusal, the sentences
   *  standing at the accepted finish. */
  objections: string[]
  /** Still-standing objections the accepted finish's unresolved[] omitted. */
  carriedObjections: string[]
  /** The refused finish's own words, so a run that never reached a second
   *  finish still ships the conclusion it would have ended on. */
  refusedFinish: { reason: string; summary: string; unresolved: string[] } | null
  /** What the gate was charging when it refused: pages the lead had gained
   *  plus missions THE LEAD COMMISSIONED that had landed, as the last refusal
   *  read them. Null when no refusal happened, and on runs stored before the
   *  gate counted work. */
  workAtRefusal: number | null
  /** How much that counter moved before the finish the gate accepted. A
   *  non-zero `refusals` beside 0 here is the run saying the lead was asked
   *  for a page or a landing and answered in words. */
  workAnswered: number
  /** And which work that was — `page:<url>(<chars>c)` or
   *  `mission:<dedupeKey>(<status>,+<nodes>)`, one per
   *  unit counted in `workAnswered`. Empty when nothing was answered, and on
   *  runs stored before the gate kept the receipt: "the lead paid" and "the
   *  lead paid with THIS" are different claims, and only the second can be
   *  argued with. */
  answeredBy: string[]
  /** Why the accepted finish was not refused: "clean", "work", or the name of
   *  the hatch that let it through ("disarmed", "turn-cap", "budget-floor",
   *  "refusals-spent"). Empty on runs stored before the gate recorded it —
   *  the reader never invents a reason it was not told. */
  stood: string
}

/** The instrument reading a swarm run serialized at its ending
 *  (report.scorecard). The reader carries the facts the Coverage card draws;
 *  fields the card does not render (yield, recall, config) stay in the raw
 *  report rather than riding here as furniture. */
export interface KbScorecard {
  families: ScorecardFamilyView[]
  /** Families with at least one page-tier node, over families planned. */
  familiesWithPageTier: ScoreFraction
  /** Nodes whose best evidence is page-or-better, over nodes kept. */
  pageTier: ScoreFraction
  /** Nodes resting on a single source, over nodes kept. */
  singleSourced: ScoreFraction
  /** Spendable dollars over the caller-set ceiling. */
  poolUnspent: ScoreFraction
  gate: ScorecardGateView
}

/* --------------------------------------------------------------------- notes */

/** Substantive entities per type. */
export type TypeCounts = Record<NodeType, number>

/**
 * One market segment, read straight off provenance. Every kept entity records
 * which market's queries surfaced it (`foundBy`, strongest first), so the
 * segmentation already exists in the run — this shape only renders it, it
 * infers nothing. An entity sits in the segment of its first recorded lane;
 * `straddlers` counts how many of them were also surfaced by another market.
 * The reserved name `"unattributed"` holds entities carrying no `foundBy` at
 * all (a blocked host the kernel refused, mostly) — an honest bucket rather
 * than a market nobody measured them into. A run recorded before `foundBy`
 * existed derives an empty array, and the segments row simply does not render.
 */
export interface KbSegment {
  name: string
  size: number
  straddlers: number
}

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
  /**
   * Sellers this map actually PLACES in the anchor's market.
   *
   * `counts.player + counts.product` is not this number, and the difference is
   * a claim rather than a rounding. `relation: "none"` is the classifier saying
   * the host sells into a DIFFERENT market — Temporal and Setapp in Figma's map,
   * dart.deloitte.com ("accounting research materials, not payments") in
   * Stripe's — and `place()` keeps those rows, because the run paid for them and
   * they are evidence. Counting them under a headline that reads "companies in
   * this market" asserts the opposite of what the run concluded.
   *
   * MEASURED over every stored run: 5,000 of 24,835 company-like rows, 20.1%,
   * and it is not evenly spread — figma 38.5%, supabase 39.1%, clerk 38.9%,
   * brightdata 3.1%. So a card cannot approximate it away.
   *
   * The engine drops these at write time now (`onMap` in @open-kb/sweep), which
   * fixes runs from today forward and no map already on disk. This field is what
   * makes the ~50 stored maps honest without rebuilding any of them.
   */
  companies: number
  /** Hosts the run paid for and the classifier threw away as `kind: "noise"`. */
  noise: number
  /**
   * How the placed entities stand to the anchor, folded to the four numbers a
   * card can carry: head-on rivals, the different-way substitutes, the
   * partners (integration + dependency), and the voices around the market
   * (press, directories, forums). Computed from the same placed rows as
   * `companies`, so the numbers cannot disagree with the headline above them.
   */
  relations: { competitors: number; substitutes: number; partners: number; voices: number }
  /**
   * Relations the run recorded BETWEEN two entities, MINUS the ones a withdrawn
   * name minted.
   *
   * It is the number that separates a map from a list: `notes` says how many
   * companies were found, this says how many of them the run could join to each
   * other. On the six committed demo maps it ranges from 487 to 4,080 against
   * comparable entity counts, which is the difference between a scatter of
   * hosts and a market with a shape.
   *
   * IT USED TO BE THE FILE'S OWN COUNT and this doc used to say so. It stopped
   * being that when `withoutStolenNames` landed: a row wearing the anchor's own
   * name collected every page in the run that mentioned the anchor, and those
   * edges were bought with a name the row never owned. Four of the six demo maps
   * carry them — vercel 6,283 → 4,080, supabase 2,351 → 1,969, stripe 3,017 →
   * 2,794, clerk 517 → 499, 2,826 in total — and on every other map on disk the
   * two counts are still the same number. A map written since the engine fix is
   * untouched by definition.
   *
   * NOT the edge count the canvas draws either, and that gap is separate.
   * `graphOf` adds the anchor's market edges and one home edge per entity, and
   * drops any relation whose two ends are not both on the map. So this is the
   * run's measurement with one class of false edge removed — say it that way on
   * any surface that shows it, rather than calling it the run's own number.
   */
  edges: number
  /** The market segments provenance already drew, largest first, unattributed
   *  last. Empty on a run recorded before `foundBy` existed. */
  segments: KbSegment[]
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
  /** The queries that surfaced this host, most-seen first, at most the three
   *  the sweep stored. `foundBy` names the markets and `families` the
   *  door-shapes; this is the text somebody typed, which is the one answer to
   *  "why is this on the map" that asks a reader to trust nothing. Undefined
   *  on the anchor (read from its own pages, never searched for) and on a run
   *  recorded before the sweep stored them. */
  roads?: string[]
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
  /** Where this entity's best evidence came from (swarm runs): own-page,
   *  page or snippet — see `TIER_BLURB`. Undefined on a run recorded before
   *  tiers existed; an unknown value survives rather than being dropped, and
   *  wears a neutral badge. */
  tier?: string
  /** The kernel's grounding measurement for this entity's description (sweep
   *  runs, model-judged only). See `GROUNDING_ENTITY_BLURB`. */
  descGrounded?: number
  /** The accounts a swarm merge folded into this node and kept (`also` on the
   *  run's entity row): each entry is the displaced one-liner, plus the
   *  displaced name when it had its own — a product folded into its host
   *  company. Riding the list ref (not only the full note) is what lets the
   *  entities filter find a host by the product name it absorbed. */
  also?: { name?: string; what: string }[]
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
  /**
   * Who the anchor says it works with, read off its own pages
   * (`report.discovery.integrations`).
   *
   * The same triple as `catalog` — a name, a line about what it does, and the
   * page that said so — and the same standing: not this map's judgement about
   * a third party but the company's own claim about itself, which is the one
   * part of a run nothing had to infer. Empty on a run recorded before the
   * understand stage kept them, and the section then does not render.
   */
  integrations: { with: string; does: string; foundAt?: string }[]
  /** The rivals the anchor names on its OWN comparison pages
   *  (`report.rivals.leads`): the free channel the sweep reads before it buys
   *  a single search, each lead carrying the url that named it. Empty on a
   *  company that publishes no comparison pages, which is a real answer and
   *  not a gap. */
  rivalLeads: { name: string; foundAt?: string }[]
  /** How many of those names a kept entity on this map matches
   *  (`report.rivals.reachedMap`). A name-match by any route, never proof that
   *  the comparison pages put the row there — the run's own honesty check on
   *  the names it was handed for free. Undefined when the run never measured
   *  it. */
  rivalsOnMap?: number
  /** The instrument reading a swarm run serialized at its ending. Undefined
   *  on sweep runs and on swarm runs recorded before T6 wrote it — absence
   *  means "never measured", and the Coverage card simply does not appear. */
  scorecard?: KbScorecard
  /** The market segments provenance already drew — same derivation as
   *  `KbSummary.segments`, riding the envelope so the overview's segments row
   *  needs no second request. Empty on a run recorded before `foundBy`
   *  existed, and the row does not render. */
  segments: KbSegment[]
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
  /** The queries that surfaced this entity — see the matching field on
   *  `NoteRef`. The panel's answer to "what did you type to find this?", which
   *  before this rode only in the run's trace. */
  roads?: string[]
  /** The verbatim quotes the kernel checked, in code, as literal substrings of
   *  the page the model read (`spans` on the run's entity row) — the receipts
   *  behind `what`, and behind the `descGrounded` number the panel already
   *  prints.
   *
   *  They ride the whole entity and not the list ref on purpose: the panel is
   *  the only surface that shows them, and putting a paragraph per row on
   *  `NoteRef` would send it to every list on this map to be rendered by none
   *  of them. Absent on the ~14% of rows the kernel verified no quote for —
   *  mostly hosts whose front page it could not read at all — and on runs
   *  recorded before the kernel kept them. */
  spans?: string[]
  /** the kernel's refusal, when this claim was downgraded — rendered so a
   *  reader sees why the map does not trust it. */
  because?: string
  /** Where this entity's best evidence came from (swarm runs) — see the
   *  matching field on `NoteRef`. */
  tier?: string
  /** The grounding measurement for this entity's description (sweep runs) —
   *  see the matching field on `NoteRef`. */
  descGrounded?: number
  /** The merged-away accounts a swarm collision kept — see `NoteRef.also`. */
  also?: { name?: string; what: string }[]
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
  /**
   * How prominent this entity is IN THE MARKET, from the search itself: the
   * run's own `seenIn` (how many distinct queries returned it) and `bestRank`
   * (its best SERP position), not a judgement. The graph's second size
   * encoding — `relevance` says how firmly the classifier placed the entity
   * against the anchor; this says how central the market's own searches found
   * it to be. Anchor and market nodes, which no search measures, carry the
   * same fixed value as their `relevance`.
   */
  prominence: number
}

export interface GraphEdge {
  source: string
  target: string
  /** The relation this edge asserts (competitor, integration, …). v1's edges
   *  were untyped wikilinks and had nothing to say; ours are the whole point,
   *  so the label rides along and the canvas's link tooltip reads it. */
  label: string
  /** measured = a retrieved page named both ends; inferred = the model
   *  reasoned it. 73–88% of a map's edges are inferred, and until this field
   *  the canvas drew them identically.
   *
   *  It does NOT say whether the run measured the edge at all: the straddle
   *  lanes are provenance and wear `inferred` for the dashed style. Read
   *  `provenance` first, then this. */
  confidence?: "measured" | "inferred"
  /** True on an edge this reader DREW rather than one the run measured: the
   *  anchor to its markets, an entity to the market whose queries surfaced it,
   *  the straddle lanes. It means "a query in this market returned this host",
   *  which is not a claim that two things are related, and it is set on nearly
   *  every entity — which is why a map can look fully wired and have measured
   *  almost no relations. Absent means the run measured this edge between two
   *  hosts and cited a page for it (`confidence` then says which kind). */
  provenance?: true
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
  /** v1: notes unreachable from company.md. Ours: entities on the map that no
   *  edge of any kind touches — unreachable in the literal sense.
   *
   *  It counts provenance edges, so it is a reachability number and not a
   *  linking one: 210 of 38,209 nodes corpus-wide, 0.5%, on a corpus where 57%
   *  of nodes have no measured neighbour at all. Read it as "nothing on the
   *  canvas points at this", never as "the map is wired". `unlinked` is the
   *  number for that, and the two are meant to be read together. */
  orphans: string[]
  /** Entities on the map that no MEASURED edge touches: the run found them and
   *  never related them to another host. The linking meter — 43.3% to 88.7% of
   *  entities per gallery map, 4,472 of 8,563 — and the one number here that
   *  can report a linking failure, which `orphans` structurally cannot. */
  unlinked: number
}
