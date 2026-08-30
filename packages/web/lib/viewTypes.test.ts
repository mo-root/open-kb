import { describe, expect, it } from "vitest"
import type { QueryFamily, ScorecardNode } from "@open-kb/core"
import {
  FAMILY_TONE,
  RELATION_BLURB,
  TIER_BLURB,
  GROUNDING_MEAN_BLURB,
  GROUNDING_ENTITY_BLURB,
} from "./viewTypes"
import { JUDGED_RELATIONS } from "@open-kb/core"

/**
 * `FAMILY_TONE` was missing `rival`, the fourth member of `QueryFamily`
 * (`"plain" | "debranded" | "branded" | "rival"` — `@open-kb/core/families`).
 * `rivalHand()` genuinely emits `family: "rival"` queries (the
 * `${name} alternatives` and `${a} vs ${b}` shapes), and `scripts/
 * query-yield.ts`'s own header comment measures them at length, but both
 * consumers (`SearchesPanel.tsx`, `NoteView.tsx`) key off `FAMILY_TONE[family]
 * ?? <generic fallback>` — so every rival-family chip rendered identically to
 * one with no family at all. Same shape of gap as B3's missing `adjacent` in
 * `KbOverview.tsx`'s `RELATION_ORDER`. Coverage gap found sweeping
 * `packages/web/lib` (D-scope: "areas nobody has swept").
 *
 * Pinned against the real union rather than a hand-copied literal list, so a
 * fifth family added to `QueryFamily` and forgotten here fails this test
 * instead of silently landing in the fallback tone again.
 */
describe("FAMILY_TONE covers every QueryFamily", () => {
  const FAMILIES: readonly QueryFamily[] = ["plain", "debranded", "branded", "rival"]

  it("has a distinct tone for each family, not the fallback", () => {
    for (const f of FAMILIES) expect(FAMILY_TONE[f]).toBeDefined()
  })

  it("gives no two families the same tone string", () => {
    const tones = FAMILIES.map((f) => FAMILY_TONE[f])
    expect(new Set(tones).size).toBe(tones.length)
  })
})

/**
 * `RELATION_BLURB` already covers every `JUDGED_RELATIONS` member (verified
 * while investigating the `FAMILY_TONE` gap above, to check whether its sibling
 * map had the same shape of hole — it does not), pinned here so it stays true.
 */
describe("RELATION_BLURB covers every judged relation", () => {
  it("has a blurb for each relation `judgeHosts` can produce", () => {
    for (const r of JUDGED_RELATIONS) expect(RELATION_BLURB[r]).toBeDefined()
  })
})

/**
 * `TIER_BLURB` had zero test references anywhere in the repo — found sweeping
 * `packages/web/lib` for exported constants no test file names (same sweep
 * that found the GROUNDING_*_BLURB gap below). Unlike `FAMILY_TONE` and
 * `RELATION_BLURB` above it is typed `Record<string, string>`, not
 * `Record<Tier, string>`, so a tier this map forgot would not even be a
 * compile error — `judgeHosts` has no exported tier union to key off (the
 * ladder lives as `ScorecardNode["tier"]` in core and as swarm's own
 * `ProvenanceTier`, which `packages/web` does not depend on), so it is pinned
 * here against the three literal values `own-page > page > snippet` share
 * across `core/src/drift.ts`, `core/src/export-kb.ts` and
 * `core/src/scorecard.ts`.
 */
describe("TIER_BLURB covers every provenance tier", () => {
  const TIERS: readonly ScorecardNode["tier"][] = ["own-page", "page", "snippet"]

  it("has a distinct blurb for each tier, not the fallback", () => {
    for (const t of TIERS) expect(TIER_BLURB[t]).toBeDefined()
  })

  it("gives no two tiers the same blurb", () => {
    const blurbs = TIERS.map((t) => TIER_BLURB[t])
    expect(new Set(blurbs).size).toBe(blurbs.length)
  })
})

/**
 * `GROUNDING_MEAN_BLURB` and `GROUNDING_ENTITY_BLURB` also had zero test
 * references. Their own doc comment in `viewTypes.ts` is explicit that this is
 * not ordinary UI copy: "not a defect rate: 0.68 does not mean 68% of the
 * descriptions are true" / "not the share of the description that is true" —
 * a caveat that exists because the plain reading of a percentage badge is
 * exactly the overclaim it forbids. Nothing pinned that wording, so a future
 * rewording for brevity could drop the caveat and nothing would fail. Same
 * shape of guard as `NODE_KIND_GUIDE`'s test in `packages/core/tests/
 * tools.test.ts` (a regression to shorter-but-wrong text, not to empty).
 */
describe("GROUNDING_*_BLURB keep their not-a-defect-rate caveat", () => {
  it("GROUNDING_MEAN_BLURB says the mean is relative, not a defect rate", () => {
    expect(GROUNDING_MEAN_BLURB).toContain("not a defect rate")
    expect(GROUNDING_MEAN_BLURB).toContain("0.68 does not mean 68%")
  })

  it("GROUNDING_ENTITY_BLURB says the fraction is not a truth score", () => {
    expect(GROUNDING_ENTITY_BLURB).toContain("not the share of the description that is true")
  })
})
