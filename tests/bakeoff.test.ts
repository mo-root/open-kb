import { describe, expect, it } from "vitest"
import { CONTESTANTS, failedRow, renderTable, rowFromRun, type Contestant, type Row } from "../scripts/bakeoff.js"

/**
 * `scripts/bakeoff.ts` had zero test coverage anywhere. Its whole body ran at
 * import time (argv, `execFileSync` spawning real `sweep.ts`/`audit.ts`
 * children, `writeFileSync`), so nothing could import it in a test process —
 * the same shape `diff-runs.ts`, `read.ts`, `calibrate-kernel.ts` and the
 * other CLI readers were in before their own fires. Row-building and table
 * rendering are the only pure logic in the file; they are pulled out as
 * `rowFromRun`/`failedRow`/`renderTable` and gated CLI body behind the same
 * `invokedDirectly` guard those files use. No behavior changed — same field
 * reads, same table shape, same stamp logic.
 */

const contestant: Contestant = { key: "deepseek-off", model: "deepseek/deepseek-v4-flash-0731", note: "current default" }

describe("rowFromRun reads a run file's own report, the honest meter", () => {
  it("pulls the headline numbers straight from stats and report", () => {
    const r = {
      stats: { usd: 1.386, seconds: 812.4, hosts: 52 },
      report: {
        entities: 30,
        relations: { competitor: 12, unknown: 3 },
        recall: { pooled: 0.6667 },
        kernel: { groundingMean: 0.81 },
      },
    }
    expect(rowFromRun(contestant, "sweep-figma-com-20260101120000.json", r)).toEqual<Row>({
      key: "deepseek-off",
      model: "deepseek/deepseek-v4-flash-0731",
      usd: 1.386,
      seconds: 812,
      entities: 30,
      hosts: 52,
      competitors: 12,
      unknowns: 3,
      recall: "0.67",
      groundingMean: "0.81",
      file: "sweep-figma-com-20260101120000.json",
    })
  })

  it("rounds seconds, because the table's wall-clock column is whole", () => {
    const r = { stats: { usd: 0.5, seconds: 41.6, hosts: 4 }, report: { entities: 2 } }
    expect(rowFromRun(contestant, "f", r).seconds).toBe(42)
  })

  it("defaults relations, recall and grounding when a run's report is missing them", () => {
    // A run with no probe (no --n) or an old shape without kernel stats still
    // has to produce a row, not throw.
    const r = { stats: { usd: 0.2, seconds: 10, hosts: 1 }, report: { entities: 1 } }
    const row = rowFromRun(contestant, "f", r)
    expect(row.competitors).toBe(0)
    expect(row.unknowns).toBe(0)
    expect(row.recall).toBe("no probe")
    expect(row.groundingMean).toBe("-")
  })
})

describe("failedRow marks a contestant NaN rather than a fake dollar figure", () => {
  it("carries the contestant's own key and model through a failure", () => {
    const row = failedRow(contestant, "run failed")
    expect(row.key).toBe(contestant.key)
    expect(row.model).toBe(contestant.model)
    expect(Number.isNaN(row.usd)).toBe(true)
    expect(Number.isNaN(row.seconds)).toBe(true)
    expect(row.recall).toBe("run failed")
    expect(row.file).toBe("-")
  })

  it("says why: a thrown sweep reads differently from a missing file", () => {
    expect(failedRow(contestant, "run failed").recall).toBe("run failed")
    expect(failedRow(contestant, "no file").recall).toBe("no file")
  })
})

describe("renderTable prints FAILED instead of $NaN, and stays readable empty", () => {
  it("renders a healthy row with a dollar sign and a resolved recall figure", () => {
    const row = rowFromRun(contestant, "sweep-figma-com-x.json", {
      stats: { usd: 1.386, seconds: 812, hosts: 52 },
      report: { entities: 30, relations: { competitor: 12, unknown: 3 }, recall: { pooled: 0.6667 }, kernel: { groundingMean: 0.81 } },
    })
    const table = renderTable("figma.com", "52", [row], "2026-08-25")

    expect(table).toContain("# Bake-off — figma.com, 52 queries each, sequential, 2026-08-25")
    expect(table).toContain("| deepseek-off | deepseek/deepseek-v4-flash-0731 | $1.39 | 812 | 52 | 30 | 12 | 3 | 0.67 | 0.81 |")
    expect(table).toContain("- deepseek-off: runs/sweep-figma-com-x.json")
  })

  it("prints FAILED, not a NaN dollar amount, for a contestant that threw", () => {
    const table = renderTable("figma.com", "52", [failedRow(contestant, "run failed")], "2026-08-25")
    expect(table).toContain("| deepseek-off | deepseek/deepseek-v4-flash-0731 | FAILED |")
    expect(table).not.toContain("NaN")
  })

  it("drops a failed contestant from the run-file list, since it has none", () => {
    const table = renderTable("figma.com", "52", [failedRow(contestant, "no file")], "2026-08-25")
    expect(table).not.toContain("- deepseek-off:")
  })

  it("stays a well-formed table with zero contestants", () => {
    const table = renderTable("figma.com", "52", [], "2026-08-25")
    expect(table).toContain("| config | model | $ |")
    // Only the header and its separator start with "|" — no data row, no
    // dangling run-file bullet, for a bake-off where every contestant errored
    // before a row was even pushed.
    expect(table.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(2)
  })
})

describe("the contestant roster", () => {
  it("has no two entries sharing a key", () => {
    expect(new Set(CONTESTANTS.map((c) => c.key)).size).toBe(CONTESTANTS.length)
  })

  it("names the current default first, matching the table's own top row on a real run", () => {
    expect(CONTESTANTS[0]?.key).toBe("deepseek-off")
  })
})
