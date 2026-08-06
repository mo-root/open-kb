import { describe, it, expect } from "vitest"
import { judgeHosts as fromRank } from "../src/rank.js"
import { judgeHosts as fromCore } from "@open-kb/core"

/**
 * The move's one invariant: the sweep's judgeHosts IS core's judgeHosts — the
 * same function object, not a copy. A second implementation behind the old
 * import path is exactly the drift the move exists to prevent: the swarm and
 * the sweep must judge with one kernel or their audited numbers stop being
 * about the same code.
 */
describe("rank.ts re-export", () => {
  it("re-exports core's judgeHosts by identity, never a copy", () => {
    expect(fromRank).toBe(fromCore)
  })
})
