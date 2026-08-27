import { describe, expect, it } from "vitest"
import { JUDGED_RELATIONS } from "@open-kb/core"
import { meanRelevance, RELATION_COLOR, RELATION_ORDER } from "./KbOverview"
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

/**
 * `RELATION_ORDER` and `RELATION_COLOR` were missing four of `JUDGED_RELATIONS`'
 * thirteen members: `lists`, `covers`, `discusses` and `unknown`. Unlike the
 * KIND maps elsewhere (ui.tsx's `KIND_TONES`, ResultPanel.tsx's `KIND_COLOR`),
 * nothing filters `EcosystemPanel`'s input by relation — `place()`
 * (lib/kb-from-run.ts) only drops entities by `kind` — so all thirteen reach
 * `relations` (`viewOf`'s `tally(kept.map(p => p.entity.relation))`)
 * unfiltered, and `summaryOf`'s own `voices` stat counts three of the four
 * missing ones (`covers`, `lists`, `discusses`) separately, proving they are
 * real, not theoretical. Every entity carrying one of the four fell through
 * `EcosystemPanel`'s `ordered` catch-all straight to the fallback colour.
 * Same shape as SELF-105 through SELF-107 and this map's own earlier
 * `adjacent` gap (B3).
 *
 * D-scope sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see
 * 48c1eaa's note on recovering section D's scope from git history).
 * Continuing the SELF-<n> numbering from SELF-107.
 */
describe("RELATION_ORDER and RELATION_COLOR cover every JUDGED_RELATIONS member", () => {
  it("orders every relation the classifier can assign, not just nine of thirteen", () => {
    for (const r of JUDGED_RELATIONS) expect(RELATION_ORDER).toContain(r)
    expect(RELATION_ORDER.length).toBe(JUDGED_RELATIONS.length)
  })

  it("colours every relation the classifier can assign, not just nine of thirteen", () => {
    for (const r of JUDGED_RELATIONS) expect(RELATION_COLOR[r]).toBeDefined()
  })

  it("does not leave the four channel/unknown relations wearing the same fallback colour", () => {
    const FALLBACK = "var(--type-core, #9DB2D6)"
    for (const r of ["lists", "covers", "discusses", "unknown"] as const) {
      expect(RELATION_COLOR[r]).not.toBe(FALLBACK)
    }
  })

  it("gives no two relations the same colour", () => {
    const colors = JUDGED_RELATIONS.map((r) => RELATION_COLOR[r])
    expect(new Set(colors).size).toBe(colors.length)
  })
})
