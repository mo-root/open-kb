import { describe, it, expect } from "vitest"
import { JUDGED_KINDS } from "@open-kb/core"
import { ENTITY_KINDS, CLASSIFY_KINDS } from "../src/sweep.js"

/**
 * The sibling of `the-judge-and-the-sweep-teach-one-vocabulary.test.ts`, for
 * kinds instead of relations.
 *
 * `packages/core/src/judge.ts`'s own doc comment on `JUDGED_KINDS` says "the
 * sweep's reader-facing schema (sweep.ts ENTITY_KINDS / RELATIONS) carries
 * the same sets at its own call site" — but nothing checked that half of the
 * claim. `git grep -n JUDGED_KINDS -- '*.test.ts' '*.test.tsx'` before this
 * file turned up only two web tests (`KIND_COLOR`/`KIND_TONES`, already
 * pinned in ui.test.tsx and ResultPanel.test.tsx); neither imports sweep's
 * `ENTITY_KINDS` or `CLASSIFY_KINDS`. A kind added to `JUDGED_KINDS` without
 * a matching addition to `ENTITY_KINDS` would pass every existing check and
 * leave sweep's classify schema — `z.enum(CLASSIFY_KINDS)` at sweep.ts:920,
 * 5421, 6057 — unable to accept a verdict core's own judge vocabulary
 * allows, or vice versa: the same failure shape the relations test was
 * written to catch.
 *
 * `CLASSIFY_KINDS` is `ENTITY_KINDS` minus `product` by design (sweep.ts's
 * own comment above the definition explains why the model is no longer
 * asked to choose it), so that's pinned as a relationship, not equality.
 */
describe("core's judged-map kind vocabulary and the sweep's classify kind vocabulary", () => {
  const judged = new Set<string>(JUDGED_KINDS)
  const entity = new Set<string>(ENTITY_KINDS)

  it("every kind the judge's vocabulary carries, the sweep's ENTITY_KINDS also carries", () => {
    // Named rather than counted: a failure has to say WHICH word so the fix
    // is obvious — add it to sweep.ts's ENTITY_KINDS.
    expect([...judged].filter((k) => !entity.has(k))).toEqual([])
  })

  it("and nothing ENTITY_KINDS carries is a word outside the judge's vocabulary", () => {
    expect([...entity].filter((k) => !judged.has(k))).toEqual([])
  })

  it("CLASSIFY_KINDS is exactly ENTITY_KINDS minus `product`, the one kind the model is no longer asked to choose", () => {
    expect(new Set(CLASSIFY_KINDS)).toEqual(
      new Set([...entity].filter((k) => k !== "product")),
    )
  })
})
