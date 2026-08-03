import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"

describe("core purity", () => {
  it("core contains no env access, DOM, or vendor names", () => {
    const run = () => execFileSync("node", ["scripts/check-core-purity.mjs"], { encoding: "utf8" })
    expect(run).not.toThrow()
  })
})
