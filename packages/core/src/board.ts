/**
 * The board holds the run's open questions. Missions ARE the questions: the lead
 * writes them, investigators propose them, and the orchestrator's whole scheduling
 * job is arithmetic over this structure — argmax, set membership, nothing else.
 */

/** The cost words. `harvest` is the bulk tier: one mission whose investigator
 *  may hand up to HARVEST_HOST_CAP hosts to the judge kernel in a single call
 *  — sized per host in the ledger, settled per host as judgements stream. */
export type MissionTier = "peek" | "read" | "dig" | "harvest"

export interface Mission {
  /** The angle the question is asked from ("rivals", "suppliers", "the category's own words"). */
  lens: string
  /** The question itself, written to the investigator who will pick it up. */
  brief: string
  /** Why this question is worth money, in the author's words. Ships in residue. */
  why: string
  /** Lead band 61-100; proposal band 1-60. Enforced at push. */
  priority: number
  /** A cost word, never a model id. The ledger converts it into money. */
  tier: MissionTier
  /** Exact-string identity of the question. Dedupe is exact, never fuzzy — a similarity threshold silently deletes the model's ideas. */
  dedupeKey: string
  /** URLs the author already believes answer it. */
  seeds?: string[]
}

/**
 * A mission as the board holds it. `unreviewed` marks a proposal no whole-map
 * context has ranked yet; the lead's `promote` clears it.
 */
export interface BoardRow extends Mission {
  unreviewed: boolean
}

export type BoardOutcome = { ok: true } | { ok: false; reason: string }

interface Held extends BoardRow {
  /** Insertion sequence — the deterministic tie-break at equal priority. Survives release. */
  seq: number
}

/**
 * Priority queue + claim set. Run-local, ships empty, no persistence.
 *
 * Two bands, one queue: everything above 60 was ranked by one context that had
 * seen the whole map; proposals sit strictly below so six investigators scoring
 * their own discoveries can never scramble the lead's ordering. `popAffordable`
 * is the single sanctioned departure from that ordering, and it only ever scans
 * downward — it never reorders within a priority and never promotes.
 */
export class Board {
  #queued = new Map<string, Held>()
  #claimed = new Map<string, Held>()
  #seq = 0

  /**
   * Queue a mission. The band comes from who is pushing: the lead ranks 61-100,
   * an investigator proposes 1-60 and its item is marked unreviewed. A rejection
   * is a sentence the pusher can act on, never a throw.
   */
  push(mission: Mission, from: "lead" | "investigator"): BoardOutcome {
    const p = mission.priority
    if (from === "lead" && !(p >= 61 && p <= 100)) {
      return { ok: false, reason: `the lead ranks 61-100; priority ${p} belongs in the proposal band` }
    }
    if (from === "investigator" && !(p >= 1 && p <= 60)) {
      return { ok: false, reason: `a proposal ranks 1-60; priority ${p} is the lead's band` }
    }
    const key = mission.dedupeKey
    if (this.#queued.has(key)) {
      return { ok: false, reason: `"${key}" is already queued; the board holds one copy of a question` }
    }
    if (this.#claimed.has(key)) {
      return { ok: false, reason: `"${key}" is already claimed; that question is being worked right now` }
    }
    this.#queued.set(key, { ...mission, unreviewed: from === "investigator", seq: this.#seq++ })
    return { ok: true }
  }

  /**
   * argmax(priority) over the queue, subject to the tier allowance fitting inside
   * `spendableUsd`. Scans DOWN only: an unaffordable expensive item is passed
   * over for a cheaper, lower-priority one, and every passed-over item is
   * returned in `skipped` so the caller can say so on screen — the one place the
   * harness departs from the stated ordering, made honest by being narrated.
   * The returned mission is claimed; `release` puts it back if the lane refuses it.
   */
  popAffordable(
    spendableUsd: number,
    allowances: Record<MissionTier, number>,
  ): { mission?: BoardRow; skipped: BoardRow[] } {
    const skipped: BoardRow[] = []
    for (const held of this.#ranked(this.#queued.values())) {
      if (allowances[held.tier] <= spendableUsd) {
        this.#queued.delete(held.dedupeKey)
        this.#claimed.set(held.dedupeKey, held)
        return { mission: this.#row(held), skipped }
      }
      skipped.push(this.#row(held))
    }
    return { mission: undefined, skipped }
  }

  /** Mark a queued mission as being worked. Its key keeps rejecting duplicates. */
  claim(dedupeKey: string): BoardOutcome {
    if (this.#claimed.has(dedupeKey)) {
      return { ok: false, reason: `"${dedupeKey}" is already claimed; it cannot be claimed twice` }
    }
    const held = this.#queued.get(dedupeKey)
    if (!held) return { ok: false, reason: `"${dedupeKey}" is not queued; nothing to claim` }
    this.#queued.delete(dedupeKey)
    this.#claimed.set(dedupeKey, held)
    return { ok: true }
  }

  /**
   * Return a claimed mission to the queue — a lane refused it or its reservation
   * failed. Its original insertion order survives, so the tie-break stays stable.
   * A landed mission is never released: it stays claimed so its key keeps
   * rejecting duplicates for the rest of the run.
   */
  release(dedupeKey: string): BoardOutcome {
    const held = this.#claimed.get(dedupeKey)
    if (!held) return { ok: false, reason: `"${dedupeKey}" is not claimed; nothing to release` }
    this.#claimed.delete(dedupeKey)
    this.#queued.set(dedupeKey, held)
    return { ok: true }
  }

  /**
   * Lead review of a proposal: re-rank it with whole-map context. Clears the
   * unreviewed flag whatever the new number — reviewed is about who ranked it,
   * not where it landed.
   */
  promote(dedupeKey: string, newPriority: number): BoardOutcome {
    if (!(newPriority >= 1 && newPriority <= 100)) {
      return { ok: false, reason: `priority ${newPriority} is outside 1-100; nothing ranks there` }
    }
    if (this.#claimed.has(dedupeKey)) {
      return { ok: false, reason: `"${dedupeKey}" is already claimed; a running mission cannot be re-ranked` }
    }
    const held = this.#queued.get(dedupeKey)
    if (!held) return { ok: false, reason: `"${dedupeKey}" is not queued; nothing to promote` }
    held.priority = newPriority
    held.unreviewed = false
    return { ok: true }
  }

  /**
   * Lead review of a proposal: drop it, with a stated reason. The key leaves the
   * dedupe universe — exact dedupe guards queued and claimed items only, so a
   * better-phrased version of a killed question may be pushed later.
   */
  kill(dedupeKey: string, reason: string): BoardOutcome {
    void reason // recorded by the caller's progress feed; the board only forgets the item
    if (this.#claimed.has(dedupeKey)) {
      return { ok: false, reason: `"${dedupeKey}" is already claimed; kill the lane, not the board item` }
    }
    if (!this.#queued.delete(dedupeKey)) {
      return { ok: false, reason: `"${dedupeKey}" is not queued; nothing to kill` }
    }
    return { ok: true }
  }

  /**
   * Every unclaimed item, ranked — the lead's own priorities and reasons. Ships
   * on every run ending, converting "we ran out" into "here is precisely what we
   * would have done next".
   */
  residue(): BoardRow[] {
    return this.#ranked(this.#queued.values()).map((h) => this.#row(h))
  }

  /** Priority descending, then insertion order — the one, deterministic ordering. */
  #ranked(items: Iterable<Held>): Held[] {
    return [...items].sort((a, b) => b.priority - a.priority || a.seq - b.seq)
  }

  #row(held: Held): BoardRow {
    const { seq: _seq, ...row } = held
    return row
  }
}
