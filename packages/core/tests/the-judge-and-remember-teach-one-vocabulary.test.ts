import { describe, it, expect } from "vitest"
import { JUDGED_RELATIONS } from "../src/judge.js"
import { RELATIONS } from "../src/tools.js"

/**
 * The check `tools.ts`'s own doc comment says exists, for a pairing it does not cover.
 *
 * That comment names three copies of the relation vocabulary doctrine teaches: core's
 * `JUDGED_RELATIONS` (judge.ts), the swarm's `SWARM_RELATIONS` (map.ts), and tools.ts's own
 * `RELATIONS` — what `remember`'s edge schema binds to (tools.ts:535,
 * `relation: z.enum(RELATIONS)`). Two of the three pairings are already pinned directly:
 * `packages/swarm/tests/the-judge-and-the-map-teach-one-vocabulary.test.ts` checks
 * `JUDGED_RELATIONS` against `SWARM_RELATIONS`, and
 * `packages/sweep/tests/the-judge-and-the-sweep-teach-one-vocabulary.test.ts` checks it against
 * sweep's own copy. Grepping every `*.test.ts` for `JUDGED_RELATIONS` before this file turned up
 * those two plus two web ones (`RELATION_ORDER`/`RELATION_COLOR`, `RELATION_BLURB`) — tools.ts's
 * own `RELATIONS` against `JUDGED_RELATIONS` was never one of them, the same gap 0257cd1 found
 * and fixed for sweep's copy.
 *
 * Both are transitively tied to the same doctrine file today — `prompts.test.ts` checks
 * tools.ts's `RELATIONS` against `prompts/doctrine/02-relations.md`, and judge.ts's own comment
 * says it mirrors sweep's copy of that same doctrine — but transitivity through a shared prose
 * file is not a test that fires when the two enums themselves diverge; it only fires when one of
 * them drifts from the doctrine. A relation added to `JUDGED_RELATIONS` (the harvest and sweep
 * classify path) and not to `RELATIONS` (the investigator's `remember` path) would pass every
 * existing check and still leave `remember` refusing an edge the doctrine taught the investigator
 * to write — exactly tools.ts's own comment: "an edge in any of the seven missing words failed
 * the tool call outright". Confirmed the two agree today, 12 members each once `none` is
 * excluded from `JUDGED_RELATIONS`'s 13 (matching `SWARM_RELATIONS`'s shape, not sweep's, which
 * accepts `none`), so this pins that agreement rather than reporting a break.
 */
describe("core's judged-map vocabulary and remember's edge schema", () => {
  const judged = new Set<string>(JUDGED_RELATIONS)
  const remembered = new Set<string>(RELATIONS)

  it("every relation the judge's vocabulary carries, bar `none`, `remember` also accepts", () => {
    // Named rather than counted: a failure has to say WHICH word, so the fix is obvious — add
    // it to tools.ts's RELATIONS.
    expect([...judged].filter((r) => r !== "none" && !remembered.has(r))).toEqual([])
  })

  it("and nothing `remember` accepts is a word outside the judge's vocabulary", () => {
    expect([...remembered].filter((r) => !judged.has(r))).toEqual([])
  })

  it("`none` is the one deliberate exclusion — the judge may say it, `remember` may not carry it", () => {
    // Same asymmetry as SWARM_RELATIONS: `none` means "write no edge", not a value an edge
    // object carries, so `remember`'s schema is only ever consulted for an edge someone
    // decided to write.
    expect(judged.has("none")).toBe(true)
    expect(remembered.has("none")).toBe(false)
  })
})
