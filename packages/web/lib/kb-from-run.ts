import { onMap } from "@open-kb/sweep"
import type { Entity, SweepResult } from "@open-kb/sweep"
import { COMPANY_TYPES, nodeTypeOf, type NodeType } from "./nodeTypes"
import type {
  GraphEdge,
  GraphView,
  GraphViewNode,
  KbManifest,
  KbScorecard,
  KbSegment,
  KbSummary,
  KbView,
  NoteRef,
  NoteView,
  ScorecardFamilyView,
  ScoreFraction,
  TypeCounts,
} from "./viewTypes"
import type { CompletedRun } from "./runs"

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
 *
 * `CompletedRun`, not `StoredRun`, and the distinction is load bearing rather
 * than decorative. A failed run is now a readable run — it has a status, an
 * ending and a sentence — but it has no map, and every function here reads
 * `run.result` on its first line. Taking the narrowed type means a caller has
 * to say `isCompleted` out loud before it gets in, instead of this file
 * inventing an empty `SweepResult` so that a crash can render as a market with
 * nothing in it.
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
 *
 * `unknown` is different from `noise`: it is the kernel declining to settle a
 * host rather than the classifier ruling it out. Dropping it silently would
 * make the map look more confident than the run was, so it gets a node too —
 * in its own group, `unplaced`, rather than folded into a colour that claims
 * a kind was decided.
 */
const KIND_GROUP: Record<string, string> = {
  company: "players",
  product: "products",
  community: "communities",
  publisher: "communities",
  directory: "communities",
  unknown: "unplaced",
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

/** One entity per host. Each host is judged once from its own page now, but
 *  this fold stays as the guard against a duplicate row from any source.
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

/** The evidence tier a swarm run stamped on this entity, when one is there.
 *  `Entity` is the sweep's type and the swarm writes the same row shape plus
 *  `tier`, so the read goes through the same escape hatch `because` already
 *  uses. Any non-empty string survives — a tier this reader has never heard of
 *  is still a fact the run asserted, and the badge falls back to neutral. */
function tierOf(e: Entity): string | undefined {
  const t = (e as { tier?: unknown }).tier
  return typeof t === "string" && t.trim() ? t : undefined
}

/** The kernel's grounding measurement, when this entity was model-judged.
 *  Never coerced: a run that wrote `"0.72"` wrote a bug worth seeing. */
function descGroundedOf(e: Entity): number | undefined {
  const v = (e as { descGrounded?: unknown }).descGrounded
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** The merged-away accounts a swarm collision kept on this row (`also`), read
 *  through the same escape hatch as `tier`. Only well-formed entries survive —
 *  each needs its displaced `what`, and `name` rides when it was a string —
 *  and an empty or absent array reads as undefined, so a row that never
 *  merged carries no field rather than empty furniture. */
function alsoOf(e: Entity): { name?: string; what: string }[] | undefined {
  const raw = (e as { also?: unknown }).also
  if (!Array.isArray(raw)) return undefined
  const entries = raw.flatMap((a): { name?: string; what: string }[] => {
    if (!a || typeof a !== "object") return []
    const r = a as Record<string, unknown>
    if (typeof r.what !== "string" || !r.what.trim()) return []
    return [{ ...(typeof r.name === "string" && r.name.trim() ? { name: r.name } : {}), what: r.what }]
  })
  return entries.length ? entries : undefined
}

/** A `Fraction` as core serialized it, or null when the shape is not one.
 *  `value` may honestly be null (den 0, "never NaN"); num and den may not. */
function fractionOf(v: unknown): ScoreFraction | null {
  if (!v || typeof v !== "object") return null
  const f = v as Record<string, unknown>
  if (typeof f.num !== "number" || typeof f.den !== "number") return null
  return { num: f.num, den: f.den, value: typeof f.value === "number" ? f.value : null }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/**
 * report.scorecard, read as the view's `KbScorecard` — or undefined when the
 * run never wrote one (every sweep run, and swarm runs before T6) or wrote
 * something that is not a scorecard. All four fractions must parse: a Coverage
 * card missing half its instrument would render confidence the run never
 * measured, so a malformed reading yields no card rather than a partial one.
 */
function scorecardOf(report: Record<string, unknown>): KbScorecard | undefined {
  const raw = report.scorecard
  if (!raw || typeof raw !== "object") return undefined
  const s = raw as Record<string, unknown>

  const familiesWithPageTier = fractionOf(s.familiesWithPageTier)
  const pageTier = fractionOf(s.pageTier)
  const singleSourced = fractionOf(s.singleSourced)
  const poolUnspent = fractionOf(s.poolUnspent)
  if (!familiesWithPageTier || !pageTier || !singleSourced || !poolUnspent) return undefined

  const families: ScorecardFamilyView[] = (Array.isArray(s.families) ? s.families : []).flatMap(
    (f): ScorecardFamilyView[] => {
      if (!f || typeof f !== "object") return []
      const r = f as Record<string, unknown>
      if (typeof r.lens !== "string") return []
      return [
        {
          lens: r.lens,
          status: typeof r.status === "string" ? r.status : "unknown",
          nodesAdded: typeof r.nodesAdded === "number" ? r.nodesAdded : 0,
          pageTierNodes: typeof r.pageTierNodes === "number" ? r.pageTierNodes : 0,
          because: typeof r.because === "string" ? r.because : undefined,
        },
      ]
    },
  )

  // The gate record, defaulting to the zero record exactly as the serializer
  // does ("a run whose finishes never met a scorecard thunk serializes the
  // zero record rather than a hole").
  const g = (s.gate && typeof s.gate === "object" ? s.gate : {}) as Record<string, unknown>
  const rf = g.refusedFinish
  const refusedFinish =
    rf && typeof rf === "object"
      ? {
          reason: typeof (rf as { reason?: unknown }).reason === "string" ? (rf as { reason: string }).reason : "",
          summary: typeof (rf as { summary?: unknown }).summary === "string" ? (rf as { summary: string }).summary : "",
          unresolved: strings((rf as { unresolved?: unknown }).unresolved),
        }
      : null

  return {
    families,
    familiesWithPageTier,
    pageTier,
    singleSourced,
    poolUnspent,
    gate: {
      refusals: typeof g.refusals === "number" ? g.refusals : 0,
      objections: strings(g.objections),
      carriedObjections: strings(g.carriedObjections),
      refusedFinish,
      // What the refusal charged and what it was paid, plus the rule that let
      // the finish through. Runs stored before the gate counted work carry
      // none of the three: null / 0 / "" say "not recorded", which is not the
      // same claim as "the lead did nothing" and must not render as one.
      workAtRefusal: typeof g.workAtRefusal === "number" ? g.workAtRefusal : null,
      workAnswered: typeof g.workAnswered === "number" ? g.workAnswered : 0,
      answeredBy: strings(g.answeredBy),
      stood: typeof g.stood === "string" ? g.stood : "",
    },
  }
}

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

/** An entity's provenance lanes: its `foundBy` entries trimmed, blanks
 *  dropped, and repeated spellings folded onto one case-insensitive key,
 *  order kept — the run wrote them strongest first. */
function lanesOf(e: Entity): { key: string; label: string }[] {
  const seen = new Set<string>()
  const lanes: { key: string; label: string }[] = []
  for (const raw of e.foundBy ?? []) {
    if (typeof raw !== "string") continue
    const label = raw.trim()
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    lanes.push({ key, label })
  }
  return lanes
}

/**
 * The segmentation provenance already drew (see `KbSegment` in viewTypes.ts):
 * render `foundBy`, infer nothing. Each kept entity sits in the segment of its
 * first recorded lane — the strongest attribution the run made — and counts as
 * a straddler there when another market's queries surfaced it too. A lane the
 * planner invented mid-run is still provenance and keeps its own segment; an
 * entity with no `foundBy` at all lands in `unattributed` rather than in a
 * market nobody measured it into. When NO entity carries `foundBy` the run
 * predates the field, and the honest answer is no segmentation at all — an
 * empty array — not one all-"unattributed" bucket dressed up as a finding.
 */
function segmentsOf(result: SweepResult, kept: Placed[]): KbSegment[] {
  const bySeg = new Map<string, { label: string; size: number; straddlers: number }>()
  let unattributed = 0
  for (const p of kept) {
    const lanes = lanesOf(p.entity)
    if (lanes.length === 0) {
      unattributed += 1
      continue
    }
    const first = lanes[0]!
    const seg = bySeg.get(first.key) ?? { label: first.label, size: 0, straddlers: 0 }
    seg.size += 1
    if (lanes.length > 1) seg.straddlers += 1
    bySeg.set(first.key, seg)
  }
  if (bySeg.size === 0) return []

  // The market names come free from the decomposition: a lane that matches a
  // planned market wears the decomposition's own spelling, not the (possibly
  // case-drifted) spelling some entity happened to record first.
  for (const c of result.decomposition?.capabilities ?? []) {
    const seg = bySeg.get(c.name.trim().toLowerCase())
    if (seg) seg.label = c.name.trim()
  }

  const segments: KbSegment[] = [...bySeg.values()]
    .map((s) => ({ name: s.label, size: s.size, straddlers: s.straddlers }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
  // Unattributed always closes the list: it is the run's honest remainder, not
  // a market, and sorting it into the middle would dress it up as one.
  if (unattributed > 0) segments.push({ name: "unattributed", size: unattributed, straddlers: 0 })
  return segments
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

export function manifestOf(run: CompletedRun): KbManifest {
  const r = run.result
  const report = (r.report ?? {}) as Record<string, unknown>
  const kernel = report.kernel && typeof report.kernel === "object" ? (report.kernel as Record<string, unknown>) : null
  const groundingMean =
    typeof kernel?.groundingMean === "number" && Number.isFinite(kernel.groundingMean)
      ? kernel.groundingMean
      : undefined
  const { kept } = place(r)
  // What the clock did to this run, when something was clocking it. Absent on
  // every terminal run and on every run recorded before the web path was
  // time-boxed — `manifestNum` returns undefined for a missing key, so a map
  // that was never sized says nothing about size, which is the truth.
  const budget =
    report.budget && typeof report.budget === "object" ? (report.budget as Record<string, unknown>) : null
  const budgetNum = (k: string): number | undefined =>
    typeof budget?.[k] === "number" && Number.isFinite(budget[k]) ? (budget[k] as number) : undefined
  return {
    slug: run.id,
    input: r.anchor,
    brand: r.anchor,
    root: r.anchor,
    /** The whole-run query ceiling this deployment could finish, and the clock
     *  it came from. The pair is what lets a stored map say "this is a size,
     *  not a limit of the engine". */
    queryCeiling: budgetNum("maxQueries"),
    clockSeconds: budgetNum("clockSeconds"),
    /** Hosts the run found and never judged, because the clock ran out on the
     *  rank pool. 0 on a run that judged everything it found. */
    unjudged: budgetNum("unjudged"),
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
    // The kernel's grounding meter (sweep runs). Absent when never measured —
    // `manifestNum` returns undefined for a missing key, so the telemetry
    // line simply does not render rather than claiming a zero.
    groundingMean,
    sells: r.decomposition.sells,
    buyer: r.decomposition.buyer,
    products: r.decomposition.products.length,
    stopReason: run.status === "complete" ? "swept" : run.status,
    cost: report.cost,
  }
}

export function summaryOf(run: CompletedRun): KbSummary {
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
    // `onMap` is imported from the engine rather than restated here, so the
    // writer and the reader cannot drift about what is on a map. It is the same
    // predicate that keeps these rows out of runs written from now on.
    companies: kept.filter((p) => COMPANY_TYPES.includes(p.type) && onMap(p.entity)).length,
    noise: noise.length,
    // The run's own count, not the canvas's — see `KbSummary.edges` for why the
    // two differ and why this one is the one a card reports. `edges` is
    // optional on `SweepResult`, and a run recorded before it existed measured
    // no relations rather than zero of them; both read as 0 here, which is the
    // one place the distinction does not change what a reader is told.
    edges: run.result.edges?.length ?? 0,
    segments: segmentsOf(run.result, kept),
  }
}

export function viewOf(run: CompletedRun): KbView {
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
        foundBy: p.entity.foundBy,
        families: p.entity.families,
        tier: tierOf(p.entity),
        descGrounded: descGroundedOf(p.entity),
        also: alsoOf(p.entity),
      }),
    ),
  ].sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path))

  return {
    slug: run.id,
    manifest: manifestOf(run),
    brand: run.result.decomposition?.brand || undefined,
    catalog: (run.result.decomposition?.products ?? []).map((p) => ({
      name: p.name,
      does: p.does,
      foundAt: p.foundAt || undefined,
    })),
    markets: (run.result.decomposition?.capabilities ?? []).map((c) => ({
      name: c.name,
      does: c.does,
      centrality: (c as { centrality?: string }).centrality,
      covers: c.covers ?? [],
    })),
    counts,
    notes,
    kinds: tally(kept.map((p) => p.entity.kind)),
    relations: tally(kept.map((p) => p.entity.relation)),
    readPages: (run.result.report?.readPages as string[] | undefined) ?? [],
    strips:
      (run.result.report?.strips as
        | { product: string; terms: string[]; generic: boolean; foundAt: string }[]
        | undefined) ?? [],
    scorecard: scorecardOf((run.result.report ?? {}) as Record<string, unknown>),
    segments: segmentsOf(run.result, kept),
  }
}

export function noteOf(run: CompletedRun, path: string): NoteView | null {
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
    families: hit.entity.families,
    because: (hit.entity as { because?: string }).because,
    tier: tierOf(hit.entity),
    descGrounded: descGroundedOf(hit.entity),
    also: alsoOf(hit.entity),
  }
}

/**
 * The map, as the canvas eats it.
 *
 * Two rings, not a star. The anchor sells into a handful of markets, and each
 * entity was surfaced by SOME market's queries — that attribution rides on the
 * entity as `foundBy`, so an entity hangs off the market that found it, not
 * off the anchor. Search for the unlocker's job, find Apify, and Apify sits in
 * the unlocker's cluster: v1's shape, the one that read as a map.
 *
 * The star survives only as the fallback: a run written before `foundBy`
 * existed, or an entity whose market the planner invented mid-run and the
 * decomposition never named, still attaches to the anchor rather than being
 * dropped.
 */
export function graphOf(run: CompletedRun): GraphView {
  const r = run.result
  const { kept, noise } = place(r)

  const caps = r.decomposition?.capabilities ?? []
  const marketKey = (s: string) => s.trim().toLowerCase()
  const marketPath = (name: string) =>
    `markets/${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`
  const marketIds = new Map(caps.map((c) => [marketKey(c.name), marketPath(c.name)]))

  const nodes: GraphViewNode[] = [
    // The anchor's markets, one node each. Typed `product` deliberately: the
    // four canvas colours are fixed by brand law, and a market node is the
    // product side of the anchor, not a rival and not a community.
    ...caps.map(
      (c): GraphViewNode => ({
        id: marketPath(c.name),
        type: "product",
        relevance: 92,
        title: c.name,
        group: "products",
        kind: "market",
        relation: "sells",
        what: c.does,
        why: c.covers?.length ? `covers ${c.covers.join(", ")}` : "",
        domain: "",
      }),
    ),
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

  // The anchor sells into its markets.
  const edges: GraphEdge[] = caps.map((c) => ({
    source: ANCHOR_PATH,
    target: marketPath(c.name),
    label: "sells",
  }))

  // Each entity hangs off the market whose queries surfaced it. `foundBy` is
  // strongest-first, so the first name that resolves to a real market is home;
  // a market the planner invented mid-run resolves to nothing and the entity
  // falls back to the anchor, exactly as every entity did before this existed.
  //
  // `relation: none` with a known market still gets an edge, labelled `found`:
  // the classifier declining to place something against the anchor does not
  // un-happen the retrieval that surfaced it.
  //
  // The REMAINING resolvable lanes are the straddle — several markets' queries
  // surfaced the same host, which is the run measuring that the host sits
  // between segments. Each draws as a `found` edge (the vocabulary the home
  // edge already uses for pure retrieval; the home edge carries the relation)
  // wearing confidence `inferred`, so the canvas's existing dashed-for-inferred
  // style keeps them visibly subordinate to the home lane. No new rendering:
  // the straddle is pure data.
  for (const p of kept) {
    const lanes = [
      ...new Set((p.entity.foundBy ?? []).map((m) => marketIds.get(marketKey(m))).filter((id): id is string => Boolean(id))),
    ]
    const home = lanes[0]
    if (home) {
      edges.push({ source: home, target: p.path, label: p.entity.relation === "none" ? "found" : p.entity.relation })
      for (const lane of lanes.slice(1)) {
        edges.push({ source: lane, target: p.path, label: "found", confidence: "inferred" })
      }
    } else if (p.entity.relation !== "none") {
      edges.push({ source: ANCHOR_PATH, target: p.path, label: p.entity.relation })
    }
  }

  // Edges between two entities, which is what makes this a map rather than a
  // star. Both ends must be on the map: an end the run never recorded is the
  // model naming something it remembers, and a dangling edge is worse than a
  // missing one. Deduplicated in both directions, since a pair can be reported
  // twice by two batches that saw it from opposite sides.
  const byDomain = new Map(kept.map((p) => [p.entity.domain.toLowerCase().replace(/^www\./, ""), p.path]))
  const seen = new Set<string>()
  for (const e of run.result.edges ?? []) {
    const from = byDomain.get(e.from.toLowerCase().replace(/^www\./, ""))
    const to = byDomain.get(e.to.toLowerCase().replace(/^www\./, ""))
    if (!from || !to || from === to) continue
    const key = [from, to].sort().join("|") + e.relation
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ source: from, target: to, label: e.relation, confidence: (e as { confidence?: "measured" | "inferred" }).confidence })
  }

  return {
    slug: run.id,
    nodes,
    edges,
    dangling: noise.map((e) => ({
      from: ANCHOR_PATH,
      target: e.domain || e.name,
    })),
    // Unplaced means no edge at all, not "no relation to the anchor". An entity
    // the classifier declined to place against the anchor but that a link edge
    // joins to another player is on the map, and calling it unplaced would
    // report a gap that is not there.
    orphans: kept
      .filter((p) => !edges.some((e) => e.source === p.path || e.target === p.path))
      .map((p) => p.path),
  }
}
