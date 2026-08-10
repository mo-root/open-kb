import type { FamilyRow, FamilyStatus } from "@open-kb/core"
import { pageTierByWriter, type MapState } from "./map.js"

/**
 * The family ledger: the run's planned questions, one row per lead-band
 * mission, the seed included as family zero. Run-local and ORCHESTRATOR-side
 * by the audit's placement ruling — every lead-band push and kill already
 * flows through swarm code, and core board.kill's "the caller records"
 * contract stays intact: the board forgets the item, this ledger remembers it.
 *
 * A proposal (band 1-60) is not a family until the lead promotes it, so
 * events about keys never opened fall through in silence — an unreviewed
 * proposal that runs is board traffic, not a planned question. Killed rows
 * survive with the lead's own because: the scorecard's denominator counts
 * every question the run planned, including the ones it decided against.
 *
 * `pageTierNodes` is never stored. It is read from the map's writer stamps
 * (T2's contributions) when `rows()` is called, so a node another lane
 * upgrades after this family landed still counts — the number is the live
 * map's answer, not a landing-time snapshot.
 */

/** What tools-control tells the ledger: a lead-band open (spawn or promote)
 *  or a review kill with the lead's reason. Claim and landing transitions are
 *  the orchestrator's own observations and go through direct calls. */
export type FamilyEvent =
  | { kind: "opened"; lens: string; dedupeKey: string; priority: number }
  | { kind: "killed"; dedupeKey: string; because: string }

interface HeldRow {
  lens: string
  dedupeKey: string
  priority: number
  status: FamilyStatus
  because?: string
  nodesAdded: number
}

export class FamilyLedger {
  #rows = new Map<string, HeldRow>()

  /** A lead-band mission exists: spawn, the seed, or a promotion into the
   *  band. Re-opening a killed key is the question asked again — one live
   *  row, the old because gone (board.kill releases the dedupe key for
   *  exactly this). Re-opening a queued row is a re-rank: priority updates. */
  opened(lens: string, dedupeKey: string, priority: number): void {
    const existing = this.#rows.get(dedupeKey)
    if (existing) {
      existing.lens = lens
      existing.priority = priority
      existing.status = "queued"
      delete existing.because
      return
    }
    this.#rows.set(dedupeKey, { lens, dedupeKey, priority, status: "queued", nodesAdded: 0 })
  }

  /** popAffordable handed the mission to a lane. Unknown keys are proposals — not families, ignored. */
  claimed(dedupeKey: string): void {
    const row = this.#rows.get(dedupeKey)
    if (row) row.status = "claimed"
  }

  /** The mission landed; `nodesAdded` is the landing digest's own count. */
  landed(dedupeKey: string, nodesAdded: number): void {
    const row = this.#rows.get(dedupeKey)
    if (!row) return
    row.status = "landed"
    row.nodesAdded = nodesAdded
  }

  /** A review kill. The row survives wearing the lead's reason. */
  killed(dedupeKey: string, because: string): void {
    const row = this.#rows.get(dedupeKey)
    if (!row) return
    row.status = "killed"
    row.because = because
  }

  /** The tools-control seam, dispatched. */
  apply(event: FamilyEvent): void {
    if (event.kind === "opened") this.opened(event.lens, event.dedupeKey, event.priority)
    else this.killed(event.dedupeKey, event.because)
  }

  /** The scorecard's family rows, in open order (the seed first), with
   *  `pageTierNodes` computed lazily from the live map's writer stamps. */
  rows(map: MapState): FamilyRow[] {
    const byWriter = pageTierByWriter(map)
    return [...this.#rows.values()].map((row) => ({ ...row, pageTierNodes: byWriter.get(row.dedupeKey) ?? 0 }))
  }
}
