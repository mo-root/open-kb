import { entityKey } from "./drift.js"
import { fraction, type Fraction } from "./scorecard.js"

/**
 * The audit, as an instrument instead of a workflow.
 *
 * The wrong-rates that gate this project (3.3%, 0%) came from a one-off agent
 * ritual with a known one-directional bias: every "wrong" verdict got an
 * adversarial second reviewer instructed to refute it, and no "right" verdict
 * got the same treatment — a correction that can only lower the rate, and did,
 * once. This module makes the audit repeatable and makes the asymmetry either
 * impossible or worn on the sleeve: the sample is deterministic per run, the
 * packet declares its review process, the scorer refuses verdicts that were
 * not filled symmetrically, and the rate never prints without the confidence
 * interval the sample size actually entitles it to.
 *
 * Sampling is seeded by the run id so a re-audit of the same run hits the
 * same entities — two audit rounds are comparable only when they judged the
 * same rows, and a fresh random draw each time would let a rate move because
 * the sample moved. The rank is a hash of (run id, entity key), never file
 * position, so a rewrite that reorders rows cannot reshuffle the sample; and
 * the per-stratum award is house-monotone (Sainte-Laguë), so growing N — the
 * honest first move when the CI is wide — only APPENDS rows: verdicts already
 * filled at N=30 are the first thirty rows of the N=50 packet, never wasted.
 *
 * Everything here is pure: rows in, packet or score out. Files, argv and the
 * console live in scripts/audit.ts, the same split diff-runs made.
 */

/** One map row, reduced to what an auditor judges. Structural on purpose:
 *  sweep, swarm and kernel rows all assign without conversion. */
export interface AuditEntityRow {
  name: string
  domain?: string
  kind: string
  relation?: string
  what?: string
  why?: string
  tier?: string
  /** Present only on downgraded claims: the run's own refusal sentence. */
  because?: string
  /** The span ledger, when the run kept one. */
  descSpans?: { verified: number; claimed: number }
  /** The verified page quotes, when the run carries receipts. */
  spans?: string[]
}

export type AuditVerdict = "right" | "wrong"
export type SecondReview = "both" | "wrong-only" | "none"

/** The error taxonomy the original audit defined. `errorKind` is free text so
 *  a new failure class can be named the day it is found; these three are the
 *  known ones a split will usually land in. */
export const AUDIT_ERROR_KINDS = ["aggregator-as-competitor", "wrong-relation", "invented-capability"] as const

/** One sampled entity plus the fields an auditor fills. Empty string means
 *  unfilled — a packet is a form, and the scorer refuses a half-filled one. */
export interface AuditPacketRow {
  /** The row's identity (registrable host, or kind:name) — what the seed ranked. */
  key: string
  entity: AuditEntityRow
  verdict: "" | AuditVerdict
  /** Required on every "wrong": one of AUDIT_ERROR_KINDS, or a new named kind. */
  errorKind: string
  /** Required on every "wrong": the URL or quote the verdict rests on. */
  evidence: string
  /** Required on EVERY verdict, right or wrong. A reviewer field only on
   *  wrongs is the exact asymmetry this instrument exists to remove. */
  reviewer: string
  /** Optional: the hand-labelled gold verdict, when a gold set exists. */
  goldVerdict?: AuditVerdict
}

export interface AuditPacket {
  runFile: string
  /** The sample's seed. Same run id, same N, same relations — same sample. */
  runId: string
  /** Requested N; `rows.length` is what the pool could actually supply. */
  sampleSize: number
  relations: string[]
  /** Declared by the auditors, not the builder: which verdicts got an
   *  adversarial second read. Prints as a bias caveat on the scored output. */
  secondReview: "" | SecondReview
  instructions: string
  rows: AuditPacketRow[]
}

const INSTRUCTIONS =
  'Fill every row: verdict "right" or "wrong" against the entity as the run stated it; ' +
  "reviewer on EVERY verdict (agent id or human name); errorKind and evidence on every wrong. " +
  'Declare secondReview: "both" | "wrong-only" | "none" — which verdicts got an adversarial second read. ' +
  "Optional goldVerdict per row when a hand-labelled gold set exists. " +
  "Score with: pnpm run audit --score <this file>."

/** FNV-1a, 32-bit — a stable arbitrary order needs no cryptography. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

interface RankedRow {
  key: string
  entity: AuditEntityRow
  score: number
}

/**
 * Build the packet: a deterministic stratified sample over the requested
 * relations, verdict fields empty. Strata are the relations in the order
 * given; within a stratum rows rank by hash(runId, key); N is awarded across
 * strata by Sainte-Laguë, so the split tracks each relation's share of the
 * pool and never jumps when N grows. Duplicate keys fold to their first row,
 * the map's own identity rule. Packet row order is the seeded rank across
 * strata — deliberately not alphabetical and not grouped by relation, so a
 * reader's position bias cannot line up with either.
 */
export function buildAuditPacket(
  run: { entities: AuditEntityRow[] },
  opts: { runFile: string; runId: string; n: number; relations: string[] },
): AuditPacket {
  const strata = new Map<string, RankedRow[]>(opts.relations.map((r) => [r, []]))
  const seen = new Set<string>()
  for (const entity of run.entities) {
    const stratum = entity.relation !== undefined ? strata.get(entity.relation) : undefined
    if (!stratum) continue
    const key = entityKey(entity)
    if (seen.has(key)) continue
    seen.add(key)
    stratum.push({ key, entity, score: fnv1a(`${opts.runId}\u0000${key}`) })
  }
  for (const rows of strata.values()) rows.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : 1))

  // Sainte-Laguë: award each of the N slots to the stratum with the highest
  // size/(2*taken+1) that still has rows left. House-monotone by construction.
  const taken = new Map<string, number>(opts.relations.map((r) => [r, 0]))
  const pool = [...strata.values()].reduce((sum, rows) => sum + rows.length, 0)
  const slots = Math.min(opts.n, pool)
  for (let slot = 0; slot < slots; slot++) {
    let best: string | null = null
    let bestPriority = -1
    for (const relation of opts.relations) {
      const size = strata.get(relation)!.length
      const had = taken.get(relation)!
      if (had >= size) continue
      const priority = size / (2 * had + 1)
      if (priority > bestPriority) {
        bestPriority = priority
        best = relation
      }
    }
    if (best === null) break
    taken.set(best, taken.get(best)! + 1)
  }

  const picked: RankedRow[] = []
  for (const relation of opts.relations) picked.push(...strata.get(relation)!.slice(0, taken.get(relation)!))
  picked.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : 1))

  return {
    runFile: opts.runFile,
    runId: opts.runId,
    sampleSize: opts.n,
    relations: opts.relations,
    secondReview: "",
    instructions: INSTRUCTIONS,
    rows: picked.map(({ key, entity }) => ({ key, entity, verdict: "", errorKind: "", evidence: "", reviewer: "" })),
  }
}

export interface WilsonInterval {
  rate: Fraction
  /** 95% bounds, clamped to [0, 1]; null when the sample is empty — never NaN. */
  low: number | null
  high: number | null
}

/**
 * Wilson score interval. The reason it is here at all: n=30 with 1 wrong is
 * "3.3%", and the interval that sample actually supports runs 0.6%-16.7%.
 * A rate printed without its interval claims a precision the sample never
 * paid for, so the scorer prints them together, always.
 */
export function wilson(wrong: number, n: number, z = 1.96): WilsonInterval {
  const rate = fraction(wrong, n)
  if (rate.value === null) return { rate, low: null, high: null }
  const p = rate.value
  const z2 = z * z
  const den = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    rate,
    low: Math.max(0, (center - half) / den),
    high: Math.min(1, (center + half) / den),
  }
}

/**
 * Cohen's κ over paired binary verdicts — agreement corrected for chance.
 * Null when there are no pairs or when chance agreement is 1 (both readers
 * constant): 0/0 is not a measurement, and κ=1 for two rubber stamps would
 * flatter exactly the failure κ exists to catch.
 */
export function cohenKappa(pairs: Array<{ a: AuditVerdict; b: AuditVerdict }>): number | null {
  const n = pairs.length
  if (n === 0) return null
  const agree = pairs.filter((p) => p.a === p.b).length
  const aWrong = pairs.filter((p) => p.a === "wrong").length / n
  const bWrong = pairs.filter((p) => p.b === "wrong").length / n
  const po = agree / n
  const pe = aWrong * bWrong + (1 - aWrong) * (1 - bWrong)
  if (pe === 1) return null
  return (po - pe) / (1 - pe)
}

export interface AuditRefusal {
  scored: false
  refusals: string[]
}

export interface AuditScore {
  scored: true
  wrongRate: Fraction
  ci: { low: number; high: number }
  byErrorKind: Record<string, number>
  secondReview: SecondReview
  /** Null when no row carries a goldVerdict; `value` null when κ is undefined. */
  kappa: { value: number | null; goldN: number } | null
  sentences: string[]
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`

/**
 * Score a filled packet, or refuse it whole. Every refusal is collected — a
 * packet fixed line by line against a one-at-a-time scolder never converges.
 * The symmetric rule is the point: every verdict needs a reviewer, right ones
 * included, because a review process that only re-reads wrongs can only move
 * the rate down.
 */
export function scoreAuditPacket(packet: AuditPacket): AuditScore | AuditRefusal {
  const refusals: string[] = []
  if (packet.rows.length === 0) refusals.push("empty packet — nothing to score")
  if (packet.secondReview !== "both" && packet.secondReview !== "wrong-only" && packet.secondReview !== "none")
    refusals.push('secondReview undeclared — say which verdicts got a second read: "both" | "wrong-only" | "none"')
  for (const row of packet.rows) {
    if (row.verdict !== "right" && row.verdict !== "wrong") {
      refusals.push(`${row.key}: verdict unfilled — every sampled row gets judged or the packet is not an audit`)
      continue
    }
    if (row.reviewer.trim() === "")
      refusals.push(`${row.key}: ${row.verdict} verdict carries no reviewer — every verdict needs one, right ones included`)
    if (row.verdict === "wrong" && row.errorKind.trim() === "")
      refusals.push(`${row.key}: wrong verdict names no errorKind — an unnamed error cannot be split or fixed`)
    if (row.verdict === "wrong" && row.evidence.trim() === "")
      refusals.push(`${row.key}: wrong verdict carries no evidence — the auditor holds the same receipt rule as the map`)
  }
  if (refusals.length > 0) return { scored: false, refusals }

  const secondReview = packet.secondReview as SecondReview
  const wrongs = packet.rows.filter((r) => r.verdict === "wrong")
  const interval = wilson(wrongs.length, packet.rows.length)
  const byErrorKind: Record<string, number> = {}
  for (const row of wrongs) byErrorKind[row.errorKind] = (byErrorKind[row.errorKind] ?? 0) + 1

  const goldRows = packet.rows.filter((r) => r.goldVerdict === "right" || r.goldVerdict === "wrong")
  const kappa =
    goldRows.length === 0
      ? null
      : { value: cohenKappa(goldRows.map((r) => ({ a: r.verdict as AuditVerdict, b: r.goldVerdict! }))), goldN: goldRows.length }

  const sentences: string[] = []
  sentences.push(
    `wrong ${interval.rate.num} of ${interval.rate.den} — ${pct(interval.rate.value!)} (95% CI ${pct(interval.low!)}-${pct(interval.high!)}, Wilson)`,
  )
  for (const [kind, count] of Object.entries(byErrorKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
    sentences.push(`  ${kind}: ${count}`)
  if (secondReview === "wrong-only")
    sentences.push("second review: wrong-only — rate is a lower bound: the re-review could only lower it")
  else if (secondReview === "none") sentences.push("second review: none — single-reader verdicts, unchecked in either direction")
  else sentences.push("second review: both — right and wrong verdicts faced the same adversarial re-read")
  if (kappa === null) sentences.push("no gold set — κ unavailable")
  else if (kappa.value === null) sentences.push(`gold set of ${kappa.goldN} rows, but κ is undefined — both readers were constant`)
  else {
    sentences.push(`κ vs gold = ${kappa.value.toFixed(2)} over ${kappa.goldN} gold rows`)
    if (kappa.goldN < 50) sentences.push("sample too small for κ to mean much; grow N first")
  }

  return { scored: true, wrongRate: interval.rate, ci: { low: interval.low!, high: interval.high! }, byErrorKind, secondReview, kappa, sentences }
}
