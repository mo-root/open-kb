import { describe, expect, it } from "vitest"
import {
  STAGES,
  advance,
  allDone,
  formatDuration,
  formatUsd,
  groupPlan,
  initialStates,
  readCost,
  readPlanned,
  readProgress,
  readResult,
  readRunCost,
  readTrace,
  readUnderstanding,
  shareOf,
  stageOf,
  type Stage,
} from "./types"

/**
 * types.ts is the run's own doc comment: "these are readers, not type
 * assertions" — but the stage machine (`stageOf`, `initialStates`, `advance`,
 * `allDone`) at the top of the file had never been imported by a test, D-scope
 * sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see 48c1eaa's
 * note on recovering section D's scope from git history).
 *
 * `stageOf`'s own comment says why it matters: "when it silently misses a
 * name the rail freezes on the stage before and the run looks hung while it
 * is in fact working." `advance`'s comment: forward-only, "re-activating [an
 * earlier stage] would make the rail jump backwards, which reads to a user as
 * the run restarting." Both are exactly the kind of silent regression that a
 * missing test would not catch — a typo in `AGENT_STAGE` or a flipped `<`
 * still type-checks and still runs.
 */

describe("stageOf: agent name -> UI stage", () => {
  it("maps every current agent name to its stage", () => {
    expect(stageOf("understand")).toBe("understand")
    expect(stageOf("plan")).toBe("plan")
    expect(stageOf("sweep")).toBe("sweep")
    expect(stageOf("rank")).toBe("rank")
    expect(stageOf("link")).toBe("link")
    expect(stageOf("write")).toBe("write")
  })

  it("maps every retired/alternate name to the same stage as its replacement", () => {
    expect(stageOf("read")).toBe("understand")
    expect(stageOf("discover")).toBe("understand")
    expect(stageOf("catalog")).toBe("plan")
    expect(stageOf("search")).toBe("sweep")
    expect(stageOf("classify")).toBe("rank")
    expect(stageOf("extract")).toBe("rank")
    expect(stageOf("complete")).toBe("write")
  })

  it("is case-insensitive and trims whitespace", () => {
    expect(stageOf("PLAN")).toBe("plan")
    expect(stageOf("  sweep  ")).toBe("sweep")
  })

  it("returns null for a name with no mapping, rather than guessing", () => {
    expect(stageOf("orphan")).toBeNull()
    expect(stageOf("")).toBeNull()
  })

  it("returns null for a non-string agent", () => {
    expect(stageOf(undefined)).toBeNull()
    expect(stageOf(null)).toBeNull()
  })
})

describe("initialStates: every stage starts pending", () => {
  it("returns pending for every stage", () => {
    const s = initialStates()
    for (const stage of STAGES) expect(s[stage]).toBe("pending")
  })

  it("returns a fresh object each call", () => {
    expect(initialStates()).not.toBe(initialStates())
  })
})

describe("advance: forward-only rail", () => {
  it("marks the given stage active and leaves later stages pending", () => {
    const s = advance(initialStates(), "understand")
    expect(s.understand).toBe("active")
    expect(s.plan).toBe("pending")
    expect(s.write).toBe("pending")
  })

  it("closes every stage before the given one and opens it", () => {
    const s = advance(initialStates(), "rank")
    expect(s.understand).toBe("done")
    expect(s.plan).toBe("done")
    expect(s.sweep).toBe("done")
    expect(s.rank).toBe("active")
    expect(s.link).toBe("pending")
    expect(s.write).toBe("pending")
  })

  it("progresses correctly across repeated calls", () => {
    let s = initialStates()
    s = advance(s, "understand")
    s = advance(s, "plan")
    expect(s.understand).toBe("done")
    expect(s.plan).toBe("active")
    expect(s.sweep).toBe("pending")
  })

  it("does not move the rail backwards for a straggler frame from an earlier stage", () => {
    const advanced = advance(initialStates(), "link")
    const straggler = advance(advanced, "plan")
    expect(straggler).toBe(advanced)
  })

  it("re-advancing to the current stage is idempotent", () => {
    const s = advance(initialStates(), "sweep")
    const again = advance(s, "sweep")
    expect(again).toEqual(s)
  })

  it("returns the input unchanged for a stage the rail does not recognise", () => {
    const s = initialStates()
    expect(advance(s, "bogus" as Stage)).toBe(s)
  })
})

describe("allDone: seals every stage regardless of where it stood", () => {
  it("marks every stage done from the initial state", () => {
    const s = allDone(initialStates())
    for (const stage of STAGES) expect(s[stage]).toBe("done")
  })

  it("marks every stage done even mid-run, including stages still pending", () => {
    const mid = advance(initialStates(), "sweep")
    const s = allDone(mid)
    for (const stage of STAGES) expect(s[stage]).toBe("done")
  })
})

/**
 * The stage machine above is one concern; the wire readers below are a
 * distinct one — 9e65be8 left them for a future item on purpose. Every one
 * of `readPlanned`, `groupPlan`, `readCost`, `readRunCost`, `readProgress`,
 * `readTrace`, `readResult` and `readUnderstanding` had never been imported
 * by a test either: same `grep -rln "from \"./types\"" --include="*.test.*"`
 * check as before turns up only this file. The file's own header calls these
 * "readers, not type assertions" precisely because the NDJSON off a live run
 * is untrusted — every shape check and fallback below is the difference
 * between a malformed frame silently blanking a panel and it crashing the
 * page.
 */

describe("readPlanned: the plan/planned frame", () => {
  it("returns null for a non-object and for a frame with no recognised kind", () => {
    expect(readPlanned(null)).toBeNull()
    expect(readPlanned("planned")).toBeNull()
    expect(readPlanned({ kind: "progress" })).toBeNull()
  })

  it("accepts both 'planned' and 'plan' as the kind", () => {
    expect(readPlanned({ kind: "planned", queries: [] })?.queries).toEqual([])
    expect(readPlanned({ kind: "plan", queries: [] })?.queries).toEqual([])
  })

  it("reads a bare-string query as source 'unknown' with no rationale, dropping blanks", () => {
    const p = readPlanned({ kind: "planned", queries: ["how does x break", "  "] })
    expect(p?.queries).toEqual([{ q: "how does x break", source: "unknown", rationale: "" }])
  })

  it("reads an object query, falling back source/concept/rationale to an invalid or absent value", () => {
    const p = readPlanned({
      kind: "planned",
      queries: [
        { q: "x vs y", source: "evaluation", concept: "reddit.com", rationale: "comparison pages" },
        { query: "x integration", intent: "not-a-real-intent", platform: "github", why: "stack list" },
      ],
    })
    expect(p?.queries).toEqual([
      { q: "x vs y", source: "evaluation", rationale: "comparison pages", concept: "reddit.com" },
      { q: "x integration", source: "unknown", rationale: "stack list", concept: "github" },
    ])
  })

  it("drops a query object with no q/query", () => {
    const p = readPlanned({ kind: "planned", queries: [{ source: "pain" }] })
    expect(p?.queries).toEqual([])
  })

  it("prefers the `plan` array over `queries` when both are present", () => {
    const p = readPlanned({ kind: "planned", plan: [{ q: "from-plan" }], queries: ["from-queries"] })
    expect(p?.queries).toEqual([{ q: "from-plan", source: "unknown", rationale: "" }])
  })

  it("takes count from a numeric `queries` frame, which carries only a count and no list", () => {
    const p = readPlanned({ kind: "planned", queries: 40 })
    expect(p?.count).toBe(40)
    expect(p?.queries).toEqual([])
  })

  it("falls back count to the parsed queries length when `queries` is not a bare number", () => {
    const p = readPlanned({ kind: "planned", queries: ["a", "b"] })
    expect(p?.count).toBe(2)
  })

  it("reads domain from slug, then brand, then domain, and defaults optional numbers", () => {
    expect(readPlanned({ kind: "planned", queries: [], brand: "acme", domain: "acme.com" })?.domain).toBe("acme")
    expect(readPlanned({ kind: "planned", queries: [], domain: "acme.com" })?.domain).toBe("acme.com")
    const p = readPlanned({ kind: "planned", queries: [] })
    expect(p?.estimatedUsd).toBe(0)
    expect(p?.requested).toBeUndefined()
    expect(p?.written).toBeUndefined()
  })

  it("leaves ceiling/clockSeconds absent (not null) for an uncapped run", () => {
    const uncapped = readPlanned({ kind: "planned", queries: [], ceiling: null, clockSeconds: null })
    expect(uncapped?.ceiling).toBeUndefined()
    expect(uncapped?.clockSeconds).toBeUndefined()
    const capped = readPlanned({ kind: "planned", queries: [], ceiling: 120, clockSeconds: 45 })
    expect(capped?.ceiling).toBe(120)
    expect(capped?.clockSeconds).toBe(45)
  })
})

describe("groupPlan: group by intent, largest group first", () => {
  it("returns an empty array for no queries", () => {
    expect(groupPlan([])).toEqual([])
  })

  it("groups by source and sorts groups largest-first, preserving order within a group", () => {
    const q = (source: string, q2: string) => ({ q: q2, source: source as never, rationale: "" })
    const groups = groupPlan([q("pain", "p1"), q("switching", "s1"), q("pain", "p2"), q("pain", "p3")])
    expect(groups.map((g) => g.source)).toEqual(["pain", "switching"])
    expect(groups[0].queries.map((x) => x.q)).toEqual(["p1", "p2", "p3"])
  })
})

describe("readCost: the per-round spend frame", () => {
  it("returns null without a finite numeric usd, rather than defaulting to a healthy-looking 0", () => {
    expect(readCost(null)).toBeNull()
    expect(readCost({})).toBeNull()
    expect(readCost({ usd: "1.5" })).toBeNull()
    expect(readCost({ usd: Infinity })).toBeNull()
    expect(readCost({ usd: NaN })).toBeNull()
  })

  it("reads a full frame and defaults the rest to 0", () => {
    expect(readCost({ usd: 0.003 })).toEqual({ round: 0, usd: 0.003, tokens: 0, serpCalls: 0, unlockerCalls: 0 })
    expect(readCost({ usd: 0.01, round: 2, tokens: 500, serpCalls: 3, unlockerCalls: 1 })).toEqual({
      round: 2,
      usd: 0.01,
      tokens: 500,
      serpCalls: 3,
      unlockerCalls: 1,
    })
  })
})

describe("readRunCost: the whole-run ledger", () => {
  it("returns null without a finite numeric usd", () => {
    expect(readRunCost(null)).toBeNull()
    expect(readRunCost({})).toBeNull()
    expect(readRunCost({ usd: NaN })).toBeNull()
  })

  it("treats only an explicit null ceilingUsd as uncapped; an absent or malformed one is 0, not a guess", () => {
    expect(readRunCost({ usd: 1, ceilingUsd: null })?.ceilingUsd).toBeNull()
    expect(readRunCost({ usd: 1, ceilingUsd: 5 })?.ceilingUsd).toBe(5)
    expect(readRunCost({ usd: 1 })?.ceilingUsd).toBe(0)
    expect(readRunCost({ usd: 1, ceilingUsd: "uncapped" })?.ceilingUsd).toBe(0)
  })

  it("reads byKind/byAgent lines, dropping any line with no label", () => {
    const r = readRunCost({
      usd: 1,
      byKind: [{ label: "serp", calls: 4, failures: 1, usd: 0.5, ms: 900 }, { calls: 1 }],
      byAgent: [{ label: "sweep" }],
    })
    expect(r?.byKind).toEqual([{ label: "serp", calls: 4, failures: 1, usd: 0.5, ms: 900 }])
    expect(r?.byAgent).toEqual([{ label: "sweep", calls: 0, failures: 0, usd: 0, ms: 0 }])
  })

  it("partial is true only for an exact boolean true, not any truthy value", () => {
    expect(readRunCost({ usd: 1, partial: true })?.partial).toBe(true)
    expect(readRunCost({ usd: 1, partial: "true" })?.partial).toBe(false)
    expect(readRunCost({ usd: 1 })?.partial).toBe(false)
  })
})

/*
 * formatUsd / formatDuration / shareOf back every number CostBreakdown.tsx
 * renders, and none of the three had a test anywhere in the repo (confirmed
 * with a repo-wide grep for each name across every *.test.* file before
 * starting). Each is a reader with the same shape as the rest of this file —
 * a guard that fails closed on bad input rather than defaulting to a
 * healthy-looking value — and each guard's own doc comment states the
 * failure it exists to avoid, so the tests pin exactly that.
 */
describe("formatUsd: four decimal places, or a dash", () => {
  it("renders four decimal places, per the doc comment's stated reason (a whole run is a third of a dollar, a SERP call is $0.0015)", () => {
    expect(formatUsd(0.3)).toBe("$0.3000")
    expect(formatUsd(0.0015)).toBe("$0.0015")
    expect(formatUsd(0)).toBe("$0.0000")
  })

  it("is a dash for anything that is not a finite number, never a defaulted $0", () => {
    expect(formatUsd(undefined)).toBe("—")
    expect(formatUsd(null)).toBe("—")
    expect(formatUsd(NaN)).toBe("—")
    expect(formatUsd(Infinity)).toBe("—")
  })
})

describe("formatDuration: a clock, not a decimal of minutes", () => {
  it("stays in whole seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(45_000)).toBe("45s")
  })

  it("switches to minutes and seconds at 60s, zero-padding the seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s")
    expect(formatDuration(754_000)).toBe("12m 34s")
  })

  it("is a dash for anything that is not a finite, non-negative number", () => {
    expect(formatDuration(undefined)).toBe("—")
    expect(formatDuration(null)).toBe("—")
    expect(formatDuration(NaN)).toBe("—")
    expect(formatDuration(Infinity)).toBe("—")
    expect(formatDuration(-1)).toBe("—")
  })
})

describe("shareOf: a line's percent of the bill", () => {
  it("rounds to the nearest whole percent", () => {
    expect(shareOf(1, 3)).toBe(33)
    expect(shareOf(2, 3)).toBe(67)
    expect(shareOf(0.5, 1)).toBe(50)
  })

  it("is 0 for a zero or negative total, per the doc comment (a run stopped before it spent anything still renders, rather than a NaN percent)", () => {
    expect(shareOf(0, 0)).toBe(0)
    expect(shareOf(5, 0)).toBe(0)
    expect(shareOf(5, -1)).toBe(0)
    expect(shareOf(5, NaN)).toBe(0)
  })
})

describe("readProgress: one progress-stream frame", () => {
  it("returns null for a missing or blank message", () => {
    expect(readProgress(null)).toBeNull()
    expect(readProgress({ agent: "sweep" })).toBeNull()
    expect(readProgress({ agent: "sweep", message: "   " })).toBeNull()
  })

  it("trims the message and derives stage from agent via stageOf", () => {
    const p = readProgress({ agent: "SWEEP", message: "  firing queries  ", round: 3, atSec: 12.5 })
    expect(p).toEqual({ round: 3, agent: "SWEEP", message: "firing queries", stage: "sweep", atSec: 12.5 })
  })

  it("stage is null for an agent name the rail doesn't recognise, and atSec is absent when non-finite", () => {
    const p = readProgress({ agent: "mystery", message: "working", atSec: Infinity })
    expect(p?.stage).toBeNull()
    expect(p?.atSec).toBeUndefined()
  })
})

describe("readTrace: one tool-call row", () => {
  it("returns null without a tool name", () => {
    expect(readTrace(null)).toBeNull()
    expect(readTrace({ agent: "sweep" })).toBeNull()
  })

  it("ok is true unless the frame says false, exactly", () => {
    expect(readTrace({ tool: "serp" })?.ok).toBe(true)
    expect(readTrace({ tool: "serp", ok: false })?.ok).toBe(false)
    expect(readTrace({ tool: "serp", ok: 0 })?.ok).toBe(true)
  })

  it("reads the full row and defaults missing numeric/string fields", () => {
    const t = readTrace({ tool: "serp", seq: 5, ts: "t", round: 1, agent: "sweep", kind: "search", argsDigest: "q", ms: 210, error: "", usd: 0.001, runningUsd: 0.05 })
    expect(t).toEqual({ seq: 5, ts: "t", round: 1, agent: "sweep", tool: "serp", kind: "search", argsDigest: "q", ms: 210, ok: true, error: "", usd: 0.001, runningUsd: 0.05 })
  })
})

describe("readResult: a results-stream frame", () => {
  it("returns null without a kind", () => {
    expect(readResult(null)).toBeNull()
    expect(readResult({})).toBeNull()
    expect(readResult([])).toBeNull()
  })

  it("carries the whole frame as payload, kind included", () => {
    const r = readResult({ kind: "complete", kept: 12, usd: 0.4 })
    expect(r).toEqual({ kind: "complete", payload: { kind: "complete", kept: 12, usd: 0.4 } })
  })
})

describe("readUnderstanding: the understand-stage frame", () => {
  it("returns null for a non-object and for a frame whose kind isn't understanding/understood", () => {
    expect(readUnderstanding(null)).toBeNull()
    expect(readUnderstanding({ kind: "planned" })).toBeNull()
  })

  it("accepts both 'understanding' and 'understood' as the kind", () => {
    expect(readUnderstanding({ kind: "understanding", domain: "acme.com" })?.domain).toBe("acme.com")
    expect(readUnderstanding({ kind: "understood", domain: "acme.com" })?.domain).toBe("acme.com")
  })

  it("reads a nested `understanding` payload in preference to the flat frame", () => {
    const u = readUnderstanding({
      kind: "understanding",
      domain: "top-level-should-be-ignored",
      understanding: { domain: "acme.com", sells: "widgets", buyer: "ops teams" },
    })
    expect(u?.domain).toBe("acme.com")
    expect(u?.sells).toBe("widgets")
    expect(u?.buyer).toBe("ops teams")
  })

  it("reads buyer as role-or-context when it is nested, or the bare string otherwise", () => {
    expect(readUnderstanding({ kind: "understanding", buyer: { role: "ops lead", context: "mid-market" } })?.buyer).toBe("ops lead")
    expect(readUnderstanding({ kind: "understanding", buyer: { context: "mid-market" } })?.buyer).toBe("mid-market")
    expect(readUnderstanding({ kind: "understanding", buyer: "ops lead" })?.buyer).toBe("ops lead")
  })

  it("keeps a product only if it has a name or a sells/does, and reads sells from either key", () => {
    const u = readUnderstanding({
      kind: "understanding",
      products: [{ name: "Acme Pro", does: "automates x" }, { name: "" }, {}],
    })
    expect(u?.products).toEqual([{ name: "Acme Pro", sells: "automates x" }])
  })

  it("filters coinages to non-empty strings and defaults usd to 0", () => {
    const u = readUnderstanding({ kind: "understanding", coinages: ["Acmeify", "", 5, null] })
    expect(u?.coinages).toEqual(["Acmeify"])
    expect(u?.usd).toBe(0)
  })
})
