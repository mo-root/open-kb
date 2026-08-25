import { describe, expect, it } from "vitest"
import { sniffEntities } from "../scripts/audit.js"
import type { AuditEntityRow } from "../packages/core/src/index.js"

/**
 * `sniffEntities` — the shape-sniffing behind `pnpm run audit` — had no
 * direct test anywhere. The packet builder/scorer it feeds
 * (`packages/core/src/audit.ts`) is already covered thoroughly; this file
 * (argv, one JSON file, a console) ran its whole CLI body at import time, so
 * nothing could import it to test the sniff in isolation. Coverage gap found
 * sweeping `scripts/*.ts beyond sweep.ts` (D-scope: "areas nobody has
 * swept"). Fixed the same way `parseRun` was pulled out of diff-runs.ts:
 * extract the pure shape check (it now takes the already-parsed JSON rather
 * than reading the file itself), gate the CLI body behind an
 * `invokedDirectly` guard.
 */
const row = (domain: string, over: Partial<AuditEntityRow> = {}): AuditEntityRow => ({
  name: domain,
  domain,
  kind: "company",
  relation: "competitor",
  ...over,
})

describe("sniffEntities", () => {
  it("reads top-level entities — the sweep and swarm shape", () => {
    expect(sniffEntities("runs/a.json", { entities: [row("a.com")] })).toEqual([row("a.com")])
  })

  it("reads entities under result — the kernel wrapper shape", () => {
    expect(sniffEntities("runs/b.json", { result: { entities: [row("b.com")] } })).toEqual([row("b.com")])
  })

  it("prefers top-level entities over result when — impossibly — both are present", () => {
    const json = { entities: [row("top.com")], result: { entities: [row("nested.com")] } }
    expect(sniffEntities("runs/a.json", json)).toEqual([row("top.com")])
  })

  it("refuses a shape with neither, naming the path in the shared sentence", () => {
    expect(() => sniffEntities("runs/bad.json", {})).toThrow(
      "runs/bad.json: no entities at the top level or under result — not a run file this reads",
    )
  })

  it("refuses when result exists but its own entities are missing", () => {
    expect(() => sniffEntities("runs/bad.json", { result: {} })).toThrow(/not a run file this reads/)
  })
})
