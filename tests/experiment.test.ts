import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { measure } from "../scripts/experiment.js"

/**
 * `measure` (the arithmetic behind `scripts/experiment.ts`'s per-arm report)
 * had no test anywhere — the whole file ran at import time, an unconditional
 * `main().catch(...)` at the bottom that opens with a live fetch to
 * openrouter.ai (`keyUsage()`) and, past that, real `pnpm sweep` subprocesses.
 * So nothing could import the module at all, let alone just `measure`.
 * Coverage gap found sweeping `scripts/*.ts` beyond `sweep.ts` (D-scope:
 * "areas nobody has swept"), the same class SELF-55/56/57 already fixed in
 * query-yield.ts, corroboration-arrival.ts and overnight.ts.
 *
 * Fixed the same way: gate the CLI body (here, the whole `main()` call)
 * behind the `invokedDirectly` guard those three already use, and give
 * `measure` a `dir` parameter — it hardcoded `"runs"` — so a test can point
 * it at a fixture directory instead of the real one. Default unchanged, so
 * the CLI's own `measure(anchor)` call still reads `runs/`.
 */
describe("measure", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openkb-experiment-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (overrides: Record<string, unknown> = {}) => ({
    decomposition: { products: ["a", "b"], capabilities: ["market1", "market2", "market3"] },
    entities: [
      { kind: "market", relation: "competitor" },
      { kind: "market", relation: "competitor" },
      { kind: "market", relation: "substitute" },
      { kind: "market", relation: "discusses" },
      { kind: "market", relation: "lists" },
      { kind: "market", relation: "none" },
      { kind: "noise", relation: "competitor" },
    ],
    edges: [{ confidence: "measured" }, { confidence: "measured" }, { confidence: "inferred" }],
    stats: { usd: 1.23, seconds: 456, tokIn: 1000, tokOut: 200, tokReasoning: 50 },
    ...overrides,
  })

  it("returns {} when no run file matches the anchor's slug", () => {
    expect(measure("nomatch.com", dir)).toEqual({})
  })

  it("reads products, markets, kept/noise counts and relation tallies off the newest matching run", () => {
    writeFileSync(join(dir, "sweep-brightdata-com-20260821105321.json"), JSON.stringify(run()))
    const m = measure("brightdata.com", dir)
    expect(m).toMatchObject({
      file: "sweep-brightdata-com-20260821105321.json",
      products: 2,
      markets: 3,
      entities: 6, // seven rows, one noise
      noise: 1,
      competitors: 2,
      substitutes: 1,
      communities: 1,
      directories: 1,
      unplaced: 1,
      edges: 3,
      measuredEdges: 2,
      usd: 1.23,
      seconds: 456,
      tokIn: 1000,
      tokOut: 200,
      reasoning: 50,
    })
  })

  it("picks the lexicographically newest file when several runs match the same anchor", () => {
    writeFileSync(join(dir, "sweep-brightdata-com-20260820000000.json"), JSON.stringify(run({ stats: { usd: 0.01, seconds: 1 } })))
    writeFileSync(join(dir, "sweep-brightdata-com-20260821105321.json"), JSON.stringify(run({ stats: { usd: 9.99, seconds: 2 } })))
    const m = measure("brightdata.com", dir)
    expect(m.file).toBe("sweep-brightdata-com-20260821105321.json")
    expect(m.usd).toBe(9.99)
  })

  it("ignores a file for a different anchor entirely", () => {
    writeFileSync(join(dir, "sweep-shopify-com-20260821105321.json"), JSON.stringify(run()))
    expect(measure("brightdata.com", dir)).toEqual({})
  })

  it("defaults markets and reasoning to 0, and noise to 0, when the run carries none", () => {
    writeFileSync(
      join(dir, "sweep-clean-com-20260821000000.json"),
      JSON.stringify(run({
        decomposition: { products: ["a"] },
        entities: [{ kind: "market", relation: "competitor" }],
        edges: undefined,
        stats: { usd: 0.5, seconds: 10, tokIn: 5, tokOut: 5 },
      })),
    )
    const m = measure("clean.com", dir)
    expect(m).toMatchObject({ markets: 0, noise: 0, reasoning: 0, edges: 0, measuredEdges: 0 })
  })
})
