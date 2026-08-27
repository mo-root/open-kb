import { describe, expect, it } from "vitest"
import type { QueryFamily } from "@open-kb/core"
import { FAMILY_TONE, RELATION_BLURB } from "./viewTypes"
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
