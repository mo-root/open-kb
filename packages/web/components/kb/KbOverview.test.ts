import { describe, expect, it } from "vitest"
import { meanRelevance } from "./KbOverview"
import type { NoteRef } from "@/lib/viewTypes"

/**
 * D-scope sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see 48c1eaa's
 * note on recovering section D's scope from git history). Continuing the
 * existing SELF-<n> numbering: git log a7bbc57..HEAD names SELF-98 as the last
 * used, so this is SELF-99.
 *
 * `meanRelevance` (packages/web/components/kb/KbOverview.tsx) feeds the
 * dashboard's headline "mean place" stat and the placement gauge (lines
 * 827-971) — the one number that tells a reader how confidently the classifier
 * placed what it found, and it had never run under test.
 *
 * `RELATION_WEIGHT` (packages/web/lib/kb-from-run.ts:92-107), the only writer
 * of `.relevance` today, keeps every weight in 0-100 (checked: 95 down to
 * `none`'s 15), so the `Math.max(0, Math.min(100, ...))` clamp here is
 * currently dead on real data — same defensive-branch situation SELF-98 found
 * in `NoteView.tsx`'s `hostOf`. It stays worth locking: `relevance` is a bare
 * `number` on `NoteRef`, not a branded 0-100 type, so nothing at the type level
 * stops a future writer from handing this a value outside that range.
 */
function note(relevance: number): NoteRef {
  return {
    path: "players/x.com.md",
    title: "x.com",
    relevance,
    type: "player",
    kind: "company",
    relation: "competitor",
    domain: "x.com",
    what: "",
    why: "",
  }
}

describe("meanRelevance averages placement across the entities actually on the map", () => {
  it("returns 0 for no entities, rather than dividing by zero", () => {
    expect(meanRelevance([])).toBe(0)
  })

  it("returns the one score unchanged for a single entity", () => {
    expect(meanRelevance([note(80)])).toBe(80)
  })

  it("averages several entities", () => {
    expect(meanRelevance([note(80), note(60)])).toBe(70)
  })

  it("rounds to the nearest whole point, half up", () => {
    expect(meanRelevance([note(1), note(2)])).toBe(2)
  })
})

describe("meanRelevance clamps to the 0-100 range the UI promises", () => {
  it("clamps a value above 100 down to 100", () => {
    expect(meanRelevance([note(150)])).toBe(100)
  })

  it("clamps a negative value up to 0", () => {
    expect(meanRelevance([note(-50)])).toBe(0)
  })
})

describe("meanRelevance treats a falsy or malformed relevance as 0, not NaN", () => {
  it("folds a NaN entry into the average as 0 rather than poisoning the sum", () => {
    expect(meanRelevance([note(NaN), note(100)])).toBe(50)
  })

  it("treats an explicit 0 the same as any other value", () => {
    expect(meanRelevance([note(0), note(100)])).toBe(50)
  })
})
