import { describe, expect, it } from "vitest"
import { denoise, parseRun } from "../scripts/diff-runs.js"
import type { DriftEntityRow } from "../packages/core/src/index.js"

/**
 * `parseRun` and `denoise` — the shape-sniffing and noise-filtering behind
 * `pnpm diff-runs` — had no direct test anywhere. The whole file ran at
 * import time (argv, `readFileSync`, console), so nothing could import it.
 * The shared refusal sentence was checked by source text only
 * (`tests/four-readers-refuse-a-non-run-file-with-one-sentence.test.ts`) —
 * that proves the string is present, not that the branch that emits it is
 * reached correctly. Coverage gap found sweeping `scripts/*.ts beyond
 * sweep.ts` (D-scope: "areas nobody has swept"). Fixed the same way
 * `resolve`/`tally` were pulled out of `read.ts`: extract the pure functions
 * (`parseRun` now takes the already-parsed JSON rather than reading the file
 * itself), gate the CLI body behind the same `invokedDirectly` guard.
 */
const company = (domain: string, over: Partial<DriftEntityRow> = {}): DriftEntityRow => ({
  name: domain,
  domain,
  kind: "company",
  relation: "competitor",
  ...over,
})

describe("parseRun", () => {
  it("reads top-level entities — the sweep and swarm shape", () => {
    const json = { entities: [company("a.com")], edges: [] }
    expect(parseRun("runs/a.json", json)).toEqual({ entities: [company("a.com")], edges: [] })
  })

  it("reads entities under result — the kernel wrapper shape", () => {
    const json = { result: { entities: [company("b.com")], edges: [] } }
    expect(parseRun("runs/b.json", json)).toEqual({ entities: [company("b.com")], edges: [] })
  })

  it("defaults edges to [] when the matched shape omits them", () => {
    expect(parseRun("runs/a.json", { entities: [company("a.com")] })).toEqual({ entities: [company("a.com")], edges: [] })
  })

  it("prefers top-level entities over result when — impossibly — both are present", () => {
    const json = { entities: [company("top.com")], result: { entities: [company("nested.com")] } }
    expect(parseRun("runs/a.json", json).entities).toEqual([company("top.com")])
  })

  it("refuses a shape with neither, naming the path in the shared sentence", () => {
    expect(() => parseRun("runs/bad.json", {})).toThrow(
      "runs/bad.json: no entities at the top level or under result — not a run file this reads",
    )
  })

  it("refuses when result exists but its own entities are missing", () => {
    expect(() => parseRun("runs/bad.json", { result: {} })).toThrow(/not a run file this reads/)
  })
})

describe("denoise", () => {
  it("drops noise-kind rows and keeps everything else", () => {
    const m = { entities: [company("keep.com"), company("skip.com", { kind: "noise" })], edges: [] }
    expect(denoise(m).entities).toEqual([company("keep.com")])
  })

  it("passes edges through untouched", () => {
    const edges = [{ from: "a.com", to: "b.com", relation: "competitor" }]
    expect(denoise({ entities: [], edges }).edges).toBe(edges)
  })

  it("is a no-op when nothing is noise", () => {
    const m = { entities: [company("a.com"), company("b.com")], edges: [] }
    expect(denoise(m).entities).toEqual(m.entities)
  })
})
