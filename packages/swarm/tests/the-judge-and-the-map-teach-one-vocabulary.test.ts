import { describe, it, expect } from "vitest"
import { JUDGED_RELATIONS } from "@open-kb/core"
import { SWARM_RELATIONS } from "../src/map.js"

/**
 * The check `SWARM_RELATIONS`' own comment says was made, and was not.
 *
 * Two vocabularies meet on the harvest path and nothing held them together:
 * `makeHarvestClassify` binds the answer schema to core's `JUDGED_RELATIONS`
 * (agent.ts, `relation: z.enum(JUDGED_RELATIONS)`), and every host that
 * survives that verdict is handed to `rememberTool`, which refuses any
 * relation outside `SWARM_RELATIONS` (tools-free.ts's `RELS`). A word the
 * judge may answer and the map will not accept is a fetch and a model call
 * already paid for, thrown away at the last step.
 *
 * That is not hypothetical: `map.ts` records `adjacent` landing in
 * `JUDGED_RELATIONS` without landing here first, and closes with "kept in
 * sync now, and checked for the next relation too". Nothing checked it —
 * `git grep SWARM_RELATIONS` over every `*.test.ts` in the repo returned
 * zero hits before this file. The two lists agree today (12 words against
 * 13, differing only by `none`, confirmed by reading both), so this pins
 * that agreement rather than reporting a break.
 */
describe("the judge's vocabulary and the map's", () => {
  const judged = new Set<string>(JUDGED_RELATIONS)
  const swarm = new Set<string>(SWARM_RELATIONS)

  it("every relation the harvest schema may answer, bar `none`, is one the map will record", () => {
    // Named rather than counted: a failure here has to say WHICH word the
    // next relation was, because the fix is to add that word to SWARM_RELATIONS.
    expect([...judged].filter((r) => r !== "none" && !swarm.has(r))).toEqual([])
  })

  it("and nothing in the map's vocabulary is a word no judge can produce", () => {
    expect([...swarm].filter((r) => !judged.has(r))).toEqual([])
  })

  it("`none` is the one deliberate exclusion — the judge may say it, the map may not carry it", () => {
    // Both halves pinned, because the asymmetry is load-bearing in a third
    // file: `harvestTool` returns early on a `none` verdict with a row saying
    // so (tools-paid.ts). Drop `none` from JUDGED_RELATIONS and that branch is
    // dead; add it to SWARM_RELATIONS and it becomes an edge with no meaning.
    expect(judged.has("none")).toBe(true)
    expect(swarm.has("none")).toBe(false)
  })
})
