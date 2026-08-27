import { describe, it, expect } from "vitest"
import { JUDGED_KINDS } from "@open-kb/core"
import { SWARM_KIND_OF } from "../src/tools-paid.js"
import { SWARM_NODE_KINDS } from "../src/map.js"

/**
 * The sibling of `the-judge-and-the-map-teach-one-vocabulary.test.ts`, for
 * kinds instead of relations.
 *
 * `harvestTool`'s `landOne` (tools-paid.ts) folds a judged host's kind
 * through `SWARM_KIND_OF` before handing it to `rememberTool`:
 * `kind: SWARM_KIND_OF[e.kind] ?? "company"`. `e.kind` comes straight off
 * `makeHarvestClassify`'s answer schema (agent.ts:1261,
 * `kind: z.enum(JUDGED_KINDS)`), so `SWARM_KIND_OF` is a translation table
 * from core's judge vocabulary to the map's — but unlike `SWARM_RELATIONS`,
 * which `rememberTool` checks the harvest's relation against directly and
 * rejects a miss (the sibling test above), a kind `SWARM_KIND_OF` has no
 * entry for silently falls through to `"company"` instead of failing. A kind
 * added to `JUDGED_KINDS` without a matching entry here would misclassify
 * every host the judge gives that verdict to, and nothing would say so:
 * `rememberTool`'s own `KINDS.has(n.kind)` check (tools-free.ts:490) only
 * ever sees the already-translated, always-valid `"company"` fallback.
 * `git grep -n SWARM_KIND_OF -- '*.test.ts'` before this file returned zero
 * hits.
 *
 * `SWARM_KIND_OF`'s own comment says the map has no publisher/directory/
 * unknown KIND, so this checks it covers `JUDGED_KINDS` minus `noise` —
 * `landOne` returns before the translation for a `noise` verdict
 * (tools-paid.ts, "judged noise" branch), so that word never reaches
 * `SWARM_KIND_OF` and is rightly absent from its keys. Verified today: six
 * keys, exactly `JUDGED_KINDS`'s seven words minus `noise`, each value one
 * of `SWARM_NODE_KINDS` — so this pins that agreement rather than reporting
 * a break.
 */
describe("core's judged-map kind vocabulary and the harvest's SWARM_KIND_OF translation", () => {
  const judgedMinusNoise = new Set<string>(JUDGED_KINDS.filter((k) => k !== "noise"))
  const translated = new Set<string>(Object.keys(SWARM_KIND_OF))
  const swarmKinds = new Set<string>(SWARM_NODE_KINDS)

  it("every kind the judge may answer, bar `noise`, has an entry in SWARM_KIND_OF", () => {
    // Named rather than counted: a failure has to say WHICH word so the fix
    // is obvious — add it to tools-paid.ts's SWARM_KIND_OF.
    expect([...judgedMinusNoise].filter((k) => !translated.has(k))).toEqual([])
  })

  it("and SWARM_KIND_OF has no entry for a word outside the judge's vocabulary (or for `noise` itself)", () => {
    expect([...translated].filter((k) => !judgedMinusNoise.has(k))).toEqual([])
  })

  it("every value SWARM_KIND_OF translates to is a kind the map's own KINDS gate accepts", () => {
    expect(Object.values(SWARM_KIND_OF).filter((k) => !swarmKinds.has(k))).toEqual([])
  })
})
