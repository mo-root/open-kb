import { describe, it, expect } from "vitest"
import { JUDGED_RELATIONS } from "@open-kb/core"
import { RELATIONS } from "../src/sweep.js"

/**
 * The check `packages/core/src/tools.ts`'s own doc comment says exists, for a
 * pairing it does not cover.
 *
 * That comment names three copies of the relation vocabulary doctrine teaches:
 * core's `JUDGED_RELATIONS` (judge.ts), the swarm's `SWARM_RELATIONS`
 * (map.ts), and tools.ts's own `RELATIONS`. A fourth copy sits in this
 * package — `RELATIONS` here (sweep.ts) is what `z.enum(RELATIONS)` binds
 * classify's answer schema to, at all three of its call sites (sweep.ts:922,
 * 5425, 6057). `packages/swarm/tests/the-judge-and-the-map-teach-one-
 * vocabulary.test.ts` already pins core against the swarm's copy, following
 * the exact drift it names: `SWARM_RELATIONS`'s own comment claimed it was
 * "checked for the next relation too" when nothing checked it. Grepping
 * every `*.test.ts` for `JUDGED_RELATIONS` before this file turned up that
 * swarm test plus two web ones (`RELATION_ORDER`/`RELATION_COLOR`,
 * `RELATION_BLURB`) — core's copy against sweep's was never one of them.
 *
 * Both are transitively tied to the same doctrine file today —
 * `packages/core/tests/prompts.test.ts` checks tools.ts's `RELATIONS`
 * against `prompts/doctrine/02-relations.md`, and this package's own
 * `prompts.test.ts` checks sweep's `RELATIONS` against the same file — but
 * transitivity through a shared doctrine document is not a test that fires
 * when the two enums themselves diverge; it only fires when one of them
 * drifts from the prose. A relation added to one enum and not the other
 * would pass every existing check and still leave sweep's classify unable to
 * accept a verdict core's own judged-map vocabulary calls valid, or vice
 * versa. Confirmed the two agree today, 13 members each including `none`
 * (unlike `SWARM_RELATIONS`/tools.ts's `RELATIONS`, which both exclude it —
 * sweep's classify, like core's judge, may answer `none`), so this pins that
 * agreement rather than reporting a break.
 */
describe("core's judged-map vocabulary and the sweep's classify vocabulary", () => {
  const judged = new Set<string>(JUDGED_RELATIONS)
  const sweep = new Set<string>(RELATIONS)

  it("every relation the judge's vocabulary carries, the sweep's classify schema also accepts", () => {
    // Named rather than counted: a failure has to say WHICH word so the fix
    // is obvious — add it to sweep.ts's RELATIONS.
    expect([...judged].filter((r) => !sweep.has(r))).toEqual([])
  })

  it("and nothing the sweep's classify schema accepts is a word outside the judge's vocabulary", () => {
    expect([...sweep].filter((r) => !judged.has(r))).toEqual([])
  })

  it("both may answer `none`, unlike the map-writing copies (SWARM_RELATIONS, tools.ts's RELATIONS)", () => {
    expect(judged.has("none")).toBe(true)
    expect(sweep.has("none")).toBe(true)
  })
})
