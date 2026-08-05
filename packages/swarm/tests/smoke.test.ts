import { describe, it, expect } from "vitest"
import * as swarm from "../src/index.js"
import { ALLOWANCES, EvidenceStore } from "@open-kb/core"

describe("@open-kb/swarm scaffold", () => {
  it("the package resolves as a module", () => {
    expect(typeof swarm).toBe("object")
  })

  it("the kernel is reachable from inside the package's dependency graph", () => {
    // The swarm builds on core's ledger and evidence store; if either import
    // breaks, every tool in this package is unbuildable.
    expect(ALLOWANCES.peek).toBeCloseTo(0.03)
    expect(new EvidenceStore().size()).toBe(0)
  })
})
