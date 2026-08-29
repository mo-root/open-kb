import { describe, it, expect } from "vitest"
import { RELATIONS, PEER_RELATIONS } from "../src/sweep.js"

/**
 * `PEER_RELATIONS` (sweep.ts) is the vocabulary the pair-link (`EntityEdge`)
 * and orphan-stand (`OrphanStand`) schemas bind their `relation` field to —
 * how two found entities stand to EACH OTHER, as opposed to `RELATIONS`,
 * which is how an entity stands to the anchor. Its own doc comment calls it
 * "same words as the anchor vocabulary" and a deliberate eight-of-thirteen
 * subset (dropping `adjacent`/`shaper`/`buyer`/`target`, which only make
 * sense pointed at the anchor, and `none`, which the peer schemas never ask
 * for). But it is a hand-written literal array, not `RELATIONS.filter(...)`,
 * so nothing actually enforces that subset relationship — a word renamed or
 * dropped from `RELATIONS` would leave `PEER_RELATIONS` still offering it,
 * with `z.enum(PEER_RELATIONS)` silently defining a schema keyed on a word
 * that no longer exists anywhere else. `RELATIONS` itself is already pinned
 * against `JUDGED_RELATIONS` and against `prompts/doctrine/02-relations.md`
 * (this package's own `prompts.test.ts` and
 * `the-judge-and-the-sweep-teach-one-vocabulary.test.ts`) — grepping every
 * `*.test.ts` for `PEER_RELATIONS` before this file turned up nothing, so
 * this is the first time its coupling to `RELATIONS` is checked rather than
 * merely commented on.
 *
 * D-scope, self-discovered (A, B and C are all done or BLOCKED; docs/
 * overnight-backlog.md itself is gone from this checkout, untracked by
 * 481fa6d — section D scope recovered from `git show 481fa6d^:docs/
 * overnight-backlog.md`, the same recovery prior SELF-<n> commits used).
 */
describe("PEER_RELATIONS stays inside RELATIONS", () => {
  const relations = new Set<string>(RELATIONS)
  const peer = new Set<string>(PEER_RELATIONS)

  it("every peer-relation word is also a RELATIONS word", () => {
    // Named rather than counted: a failure has to say WHICH word so the fix
    // is obvious — either add it back to RELATIONS, or drop it from PEER_RELATIONS.
    expect([...peer].filter((r) => !relations.has(r))).toEqual([])
  })

  it("stays the documented eight, not the full thirteen", () => {
    expect(peer.size).toBe(8)
    expect(relations.size).toBe(13)
  })

  it("excludes the anchor-only relations on purpose: adjacent, shaper, buyer, target, none", () => {
    for (const anchorOnly of ["adjacent", "shaper", "buyer", "target", "none"]) {
      expect(peer.has(anchorOnly)).toBe(false)
    }
  })
})
