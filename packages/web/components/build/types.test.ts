import { describe, expect, it } from "vitest"
import { STAGES, advance, allDone, initialStates, stageOf, type Stage } from "./types"

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
