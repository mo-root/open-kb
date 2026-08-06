import type { RecallReport } from "./coverage.js"

/**
 * The coverage scorecard: an instrument, never a judge.
 *
 * Live run 2 ended `lead-finished` at 8 nodes with $3.55 of $5.00 unspent
 * under the sentence "Map completed within budget and time" — and nothing in
 * the loop put those numbers in front of the context writing that sentence at
 * the moment it wrote it. This module computes the numbers. It draws no
 * conclusion from them: every string it emits is a fact a reader can check
 * against the run record and disagree with, because the design
 * (docs/design/2026-08-02-orchestration.md, the non-shipped convergence
 * floor) reserves the "is this market mapped?" judgement for the model. The
 * harness measures; the lead concludes.
 *
 * Pure computation over plain inputs. No swarm imports, no clock, no money —
 * the orchestrator folds its live state into `ScorecardInput` and everything
 * here is arithmetic and sentences.
 */

/** The lifecycle of a planned family, as the orchestrator's ledger records it. */
export type FamilyStatus = "queued" | "claimed" | "landed" | "killed"

/**
 * One planned question — a lead-band mission, the seed included. The
 * orchestrator supplies these rows (T3's family ledger); the scorecard only
 * counts them. `pageTierNodes` is the number of nodes this family contributed
 * page-or-better evidence to (T2's contribution records), which is what
 * "this question got a real answer" means here.
 */
export interface FamilyRow {
  lens: string
  dedupeKey: string
  priority: number
  status: FamilyStatus
  /** The lead's own reason, recorded at the kill. Present on killed rows. */
  because?: string
  nodesAdded: number
  pageTierNodes: number
}

/**
 * One node of the map, reduced to what the scorecard counts: where its best
 * evidence came from (the provenance ladder: own-page > page > snippet) and
 * how many distinct sources back it. Structural on purpose — swarm's
 * `ProvenanceTier` assigns to `tier` without core importing swarm.
 */
export interface ScorecardNode {
  tier: "own-page" | "page" | "snippet"
  /** Distinct sources backing the node. `<= 1` counts as single-sourced. */
  sources: number
}

/**
 * A ratio that ships its own arithmetic. Serialized whole (T6) so a reader
 * recomputes `value` from `num`/`den` instead of trusting a percentage —
 * the same honesty rule as recall's probe list.
 */
export interface Fraction {
  num: number
  den: number
  /** `num / den`, or null when `den` is 0 — never NaN. A null fraction never arms the gate. */
  value: number | null
}

/** Build a Fraction; the single place the den-0 rule lives. */
export function fraction(num: number, den: number): Fraction {
  return { num, den, value: den === 0 ? null : num / den }
}

/** Everything the scorecard reads, folded from live run state by the caller. */
export interface ScorecardInput {
  families: FamilyRow[]
  entities: ScorecardNode[]
  /** What the pool would still let work touch, in dollars — the ledger's `spendable()`. */
  spendableUsd: number
  /** The caller-set ceiling. Every money figure is a fraction of this, never of a design constant. */
  ceilingUsd: number
  spentUsd: number
  elapsedMs: number
  wallMs: number
  /** New-node count per landing, in landing order. */
  yieldHistory: number[]
  /** Precomputed upstream (answerKeyRecall) — computed once, carried through. */
  recall: RecallReport
}

/**
 * The yield curve's two panes. `recent` is the new-node total of the last
 * `window` landings; `before` is the total of the `window` landings preceding
 * them, and null until a full second window exists — a six-landing pane
 * graded against a three-landing pane would be the instrument editorializing.
 */
export interface YieldWindow {
  window: number
  recent: number
  before: number | null
}

export interface Scorecard {
  /** The planned-question rows, carried so the renderer can name the empty ones. */
  families: FamilyRow[]
  /** Families with at least one page-tier node, over families planned. */
  familiesWithPageTier: Fraction
  /** Nodes whose best evidence is page-or-better, over nodes kept. */
  pageTier: Fraction
  /** Nodes resting on a single source, over nodes kept. */
  singleSourced: Fraction
  /** Spendable dollars over the caller-set ceiling. */
  poolUnspent: Fraction
  /** Elapsed ms over the wall budget. */
  wall: Fraction
  yield: YieldWindow
  recall: RecallReport
  /** This run's own spent-over-kept, or null with nothing kept. Never a config estimate. */
  costPerNodeUsd: number | null
  spentUsd: number
}

/**
 * Thresholds that arm the finish gate. Facts render regardless; a threshold
 * only decides which facts come back as an objection when the lead first
 * calls finish. Set a field to null and that objection never speaks; set all
 * three and the gate is silent — the escape hatch the design priced ("one
 * config flag rather than a redesign").
 *
 * Defaults are measured, not aspired to. Both citations are tonight's live
 * runs; the first anchor's file is starred because core's purity gate bars
 * vendor names from this package (runs/swarm-*-202608052348.json).
 */
export interface ScorecardConfig {
  /**
   * Arm while more than this fraction of the ceiling is still spendable.
   * Measured: run 2 (runs/swarm-*-202608052348.json) finished with $3.55 of
   * $5.00 in the pool (0.71); runs/swarm-resend-com-202608052353.json with
   * $2.27 of $3.00 (0.76). 0.5 lets a run keep half its ceiling without a
   * word. null silences.
   */
  maxPoolUnspentFraction: number | null
  /**
   * Arm while more than this fraction of kept nodes rest on one source.
   * Measured: run 2 (runs/swarm-*-202608052348.json) kept 8 nodes with 6 at
   * snippet tier, each minted from a single SERP page (0.75). null silences.
   */
  maxSingleSourcedFraction: number | null
  /**
   * Arm while any planned family has zero page-tier nodes. Measured: run 2
   * (runs/swarm-*-202608052348.json) planned 4 families and 3 landed nothing
   * page-or-better — two of its three reads ended `timeout`
   * (runs/swarm-resend-com-202608052353.json repeats the shape: both reads
   * timed out at 0 nodes). null (or false) silences.
   */
  requirePageTierPerFamily: boolean | null
}

export const SCORECARD_DEFAULTS: ScorecardConfig = {
  maxPoolUnspentFraction: 0.5,
  maxSingleSourcedFraction: 0.5,
  requirePageTierPerFamily: true,
}

/**
 * The design's curve sentence compares six-landing panes ("the last six
 * landings produced 2 new companies; the six before that produced 14");
 * shorter histories shrink the pane rather than padding it.
 */
const YIELD_WINDOW = 6

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

export function computeScorecard(input: ScorecardInput): Scorecard {
  const { families, entities, yieldHistory } = input
  const window = Math.min(YIELD_WINDOW, yieldHistory.length)
  const recent = sum(yieldHistory.slice(yieldHistory.length - window))
  const before =
    window > 0 && yieldHistory.length >= 2 * window
      ? sum(yieldHistory.slice(yieldHistory.length - 2 * window, yieldHistory.length - window))
      : null
  return {
    families,
    familiesWithPageTier: fraction(families.filter((f) => f.pageTierNodes > 0).length, families.length),
    pageTier: fraction(entities.filter((e) => e.tier !== "snippet").length, entities.length),
    singleSourced: fraction(entities.filter((e) => e.sources <= 1).length, entities.length),
    poolUnspent: fraction(input.spendableUsd, input.ceilingUsd),
    wall: fraction(input.elapsedMs, input.wallMs),
    yield: { window, recent, before },
    recall: input.recall,
    costPerNodeUsd: entities.length === 0 ? null : input.spentUsd / entities.length,
    spentUsd: input.spentUsd,
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`
const sec = (ms: number) => Math.round(ms / 1000)

/** "3 of 4 planned families have zero page-tier nodes (a, b, c)" — the empty ones named by dedupeKey, in board order. */
function familiesSentence(sc: Scorecard): string {
  const den = sc.familiesWithPageTier.den
  if (den === 0) return "the board holds no planned families"
  const empty = sc.families.filter((f) => f.pageTierNodes === 0)
  const named = empty.length ? ` (${empty.map((f) => f.dedupeKey).join(", ")})` : ""
  const has = empty.length === 1 ? "has" : "have"
  return `${empty.length} of ${den} planned ${den === 1 ? "family" : "families"} ${has} zero page-tier nodes${named}`
}

/** Shared by the block and the gate so an objection is byte-identical to its sentence by construction. */
function singleSourcedSentence(sc: Scorecard): string {
  const den = sc.singleSourced.den
  const nodes = den === 1 ? "node" : "nodes"
  return `${sc.singleSourced.num} of ${den} ${nodes} ${sc.singleSourced.num === 1 ? "rests" : "rest"} on a single source`
}

/** Shared for the same reason. */
function poolSentence(sc: Scorecard): string {
  return `the pool holds ${usd(sc.poolUnspent.num)} of ${usd(sc.poolUnspent.den)}`
}

function yieldSentence(y: YieldWindow): string {
  if (y.window === 0) return "no missions have landed"
  const opening =
    y.window === 1
      ? `the last landing added ${y.recent} ${y.recent === 1 ? "node" : "nodes"}`
      : `the last ${y.window} landings added ${y.recent} ${y.recent === 1 ? "node" : "nodes"}`
  return y.before === null ? opening : `${opening}; the ${y.window} before added ${y.before}`
}

function recallSentence(r: RecallReport): string {
  if (r.pooled === null) return "no fetched page qualified as an answer key"
  const n = r.probes.length
  return `recall across ${n} answer-key ${n === 1 ? "probe" : "probes"}: ${r.pooled.toFixed(2)}`
}

/**
 * The in-band block: at most eight lines, every one a checkable fact. No
 * judgement vocabulary — "insufficient", "too early", "should" are the
 * lead's words to use or refuse, never the instrument's (a test holds the
 * sentences to a forbidden-words list).
 */
export function scorecardSentences(sc: Scorecard): string[] {
  const lines: string[] = [familiesSentence(sc)]
  if (sc.pageTier.den === 0) {
    lines.push("the map holds no nodes")
  } else {
    const den = sc.pageTier.den
    const nodes = den === 1 ? "node" : "nodes"
    lines.push(`${sc.pageTier.num} of ${den} ${nodes} ${sc.pageTier.num === 1 ? "carries" : "carry"} page-tier evidence`)
    lines.push(singleSourcedSentence(sc))
  }
  lines.push(poolSentence(sc))
  lines.push(`${sec(sc.wall.num)}s of the ${sec(sc.wall.den)}s wall elapsed`)
  lines.push(yieldSentence(sc.yield))
  lines.push(recallSentence(sc.recall))
  if (sc.costPerNodeUsd !== null) {
    const kept = sc.pageTier.den
    lines.push(`the run has paid ${usd(sc.spentUsd)} for ${kept} ${kept === 1 ? "node" : "nodes"} (${usd(sc.costPerNodeUsd)} per node)`)
  }
  return lines
}

/**
 * The subset of the sentences whose configured threshold is armed — the text
 * the finish gate hands back, byte-identical to what the notes block already
 * showed. A fraction whose denominator is 0 never arms (value null means the
 * instrument has no reading, and silence on no reading is the audit's rule) —
 * the live precedent is runs/swarm-resend-com-202608052353.json, where zero
 * pages qualified as answer keys and recall's pooled number was null rather
 * than 0.
 */
export function scorecardObjections(sc: Scorecard, config: ScorecardConfig): string[] {
  const objections: string[] = []
  const empty = sc.familiesWithPageTier
  if (config.requirePageTierPerFamily === true && empty.value !== null && empty.den - empty.num > 0) {
    objections.push(familiesSentence(sc))
  }
  if (
    config.maxSingleSourcedFraction !== null &&
    sc.singleSourced.value !== null &&
    sc.singleSourced.value > config.maxSingleSourcedFraction
  ) {
    objections.push(singleSourcedSentence(sc))
  }
  if (
    config.maxPoolUnspentFraction !== null &&
    sc.poolUnspent.value !== null &&
    sc.poolUnspent.value > config.maxPoolUnspentFraction
  ) {
    objections.push(poolSentence(sc))
  }
  return objections
}
