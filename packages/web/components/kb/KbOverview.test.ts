import { afterEach, describe, expect, it, vi } from "vitest"
import { JUDGED_RELATIONS } from "@open-kb/core"
import { meanRelevance, pct, RELATION_COLOR, RELATION_ORDER, timeAgo } from "./KbOverview"
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

/**
 * `timeAgo` (KbOverview.tsx, formerly unexported) had zero test coverage
 * anywhere: `@vitest/coverage-v8` run against this file measured 27.7% lines
 * / 36.4% branches / 17.6% functions covered — `meanRelevance` and the two
 * relation maps above are the only three of its seventeen functions this
 * file's tests ever reached. `timeAgo` has its own call site (line ~917,
 * `built {timeAgo(built)}`, `built` from `builtAtOf(manifest)` — the run
 * manifest's `built_at`/`builtAt` field) but is otherwise exactly the kind of
 * pure, deterministic-once-`Date.now()`-is-pinned helper this suite's
 * fake-timer-free style can cover directly, same shape as `meanRelevance`
 * needing an export before SELF-99 could reach it.
 *
 * D-scope, self-discovered; git log names SELF-430 as the last used, so this
 * is SELF-431.
 */
describe("timeAgo formats a build timestamp relative to now", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const at = (ts: string, now: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    return timeAgo(ts)
  }

  it("reports whole seconds under the 60s boundary", () => {
    expect(at("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z")).toBe("0s ago")
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:59.000Z")).toBe("59s ago")
  })

  it("rolls seconds into minutes exactly at the 60s boundary", () => {
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z")).toBe("1m ago")
  })

  it("reports whole minutes under the 60m boundary", () => {
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T00:59:00.000Z")).toBe("59m ago")
  })

  it("rolls minutes into hours exactly at the 60m boundary", () => {
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z")).toBe("1h ago")
  })

  it("reports whole hours under the 24h boundary", () => {
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T23:00:00.000Z")).toBe("23h ago")
  })

  it("rolls hours into days exactly at the 24h boundary", () => {
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe("1d ago")
  })

  it("reports multi-day gaps", () => {
    expect(at("2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z")).toBe("7d ago")
  })

  it("clamps a build timestamp that reads as being in the future to 0s, not a negative count", () => {
    expect(at("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("0s ago")
  })

  it("returns a timestamp Date.parse cannot read unchanged, rather than 'NaNs ago'", () => {
    expect(at("not-a-real-timestamp", "2026-01-01T00:00:00.000Z")).toBe("not-a-real-timestamp")
  })
})

/**
 * `pct` (formerly unexported) had never run under test: `@vitest/coverage-v8`
 * run against this file's own suite in isolation measured 8.32% lines / 100%
 * branch / 12.5% funcs before this commit, with line 147 (the function body)
 * inside the uncovered range. After: 8.46% lines / 100% branch / 18.75%
 * funcs — one more of the file's sixteen functions, the rest unmoved.
 *
 * It has four call sites, all in this file: `PlacementPanel`'s `coverage`
 * (line 259, the second Gauge and its `>= 60` colour threshold), the header
 * rail's `--rel` CSS custom property (line 887), and two `StatTile` hints
 * (lines 949, 955). The last three sit inside `KbOverview` itself, which
 * fetches its data with `useEffect` the same way `NoteView.tsx`'s `hostOf`
 * comment and this file's own `timeAgo` already found for their call sites:
 * `renderToStaticMarkup` never runs an effect, so `KbOverview` never leaves
 * its loading skeleton under this suite's harness and none of those three are
 * reachable without a jsdom/RTL fixture this repo does not have. `pct` itself
 * is the one thing every call site shares regardless of which renders, so it
 * is what gets pinned directly — same shape as `meanRelevance` above.
 *
 * The guard matters for a real state, not a hypothetical one: `total` is 0
 * on a knowledge base with zero entities (`totalTyped` and `PlacementPanel`'s
 * own `total` both come from `entities.length` or a filtered count of it),
 * and `0 / 0` is `NaN` in JavaScript — a `NaN%` hint or gauge value is exactly
 * the empty-map case this dashboard's other panels (`CompositionPanel`'s own
 * `total === 0` branch, `PlacementPanel`'s `profile.length > 1` branch) each
 * special-case rather than let through.
 *
 * D-scope, self-discovered (docs/overnight-backlog.md is gone from this
 * checkout, untracked by 481fa6d); git log names SELF-433 as the last used,
 * so this is SELF-434.
 */
describe("pct guards the empty-total case every real call site can reach", () => {
  it("returns 0 rather than NaN when total is 0, whatever v is", () => {
    expect(pct(0, 0)).toBe(0)
    expect(pct(5, 0)).toBe(0)
  })

  it("returns 0 for a zero numerator over a real total", () => {
    expect(pct(0, 10)).toBe(0)
  })

  it("returns 100 when v equals total", () => {
    expect(pct(10, 10)).toBe(100)
  })

  it("rounds to the nearest whole percent, half up", () => {
    expect(pct(1, 8)).toBe(13) // 12.5 -> 13, not truncated to 12
    expect(pct(1, 3)).toBe(33)
    expect(pct(2, 3)).toBe(67)
  })
})
