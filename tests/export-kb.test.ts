import { describe, expect, it } from "vitest"
import { asRun, entityPages, renderIndex, retryWithForce, type IndexRow, type LoadedRun } from "../scripts/export-kb.js"
import type { ExportedFile } from "../packages/core/src/index.js"

/**
 * `scripts/export-kb.ts` had zero test coverage anywhere. Its whole body ran
 * at import time (argv, `mkdirSync`, `writeFileSync`), so nothing here was
 * reachable from a test process — the same shape `diff-runs.ts`, `audit.ts`,
 * `read.ts`, `recall.ts`, `calibrate-kernel.ts` and `bakeoff.ts` were in
 * before their own fires. The shape-sniffer, the argv-echo helper, the
 * shipped-page counter and the INDEX renderer are the pure logic in the
 * file; they are pulled out as `asRun`/`retryWithForce`/`entityPages`/
 * `renderIndex` and the CLI body gated behind the same `invokedDirectly`
 * guard those files use. `tests/seven-scripts-crashed-on-a-runs-directory-
 * that-does-not-exist.test.ts` already covers the `--all` subprocess path
 * end to end (its readdirSync guard, its INDEX write); this file covers the
 * pure pieces that subprocess test cannot see into.
 */

const entity = (name: string) => ({ name, kind: "org", relation: "competitor" })

describe("asRun sniffs an already-parsed run file the same two ways diff-runs and audit do", () => {
  it("accepts top-level entities (sweep, swarm)", () => {
    const json = { entities: [entity("a")], anchor: "figma.com" }
    expect(asRun(json)).toBe(json)
  })

  it("accepts the kernel wrapper's result", () => {
    const result = { entities: [entity("a")], anchor: "figma.com" }
    expect(asRun({ result })).toBe(result)
  })

  it("returns null rather than throwing on a shape with neither", () => {
    expect(asRun({ anchor: "figma.com" })).toBeNull()
    expect(asRun({ result: { anchor: "figma.com" } as LoadedRun })).toBeNull()
  })

  it("returns null on null or undefined input, the shape a failed JSON.parse hands off", () => {
    expect(asRun(null)).toBeNull()
    expect(asRun(undefined)).toBeNull()
  })

  it("prefers top-level entities over a same-named result field", () => {
    const json = { entities: [entity("top")], result: { entities: [entity("nested")] } }
    expect(asRun(json)).toBe(json)
  })
})

describe("retryWithForce echoes back the caller's own argv with --force appended", () => {
  it("appends --force to a plain argv", () => {
    expect(retryWithForce(["runs/sweep-figma-com-x.json"])).toBe("pnpm run export runs/sweep-figma-com-x.json --force")
  })

  it("quotes an argument that contains whitespace", () => {
    expect(retryWithForce(["runs/x.json", "my export dir"])).toBe(
      'pnpm run export runs/x.json "my export dir" --force',
    )
  })

  it("handles --all the same as any other positional", () => {
    expect(retryWithForce(["--all"])).toBe("pnpm run export --all --force")
  })
})

describe("entityPages counts shipped entity notes, not the crawl", () => {
  const file = (path: string): ExportedFile => ({ path, content: "" })

  it("counts only files under entities/", () => {
    const files = [file("entities/a.md"), file("entities/b.md"), file("README.md"), file("SKILL.md")]
    expect(entityPages(files)).toBe(2)
  })

  it("is zero for a folder with no entity pages", () => {
    expect(entityPages([file("README.md")])).toBe(0)
  })
})

describe("renderIndex groups rows by anchor and links the drift command between runs", () => {
  it("renders one section per anchor, sorted alphabetically", () => {
    const rows: IndexRow[] = [
      { anchor: "vercel.com", source: "runs/sweep-vercel-com-x.json", dir: "runs/exports/kb-sweep-vercel-com-x", entities: 10 },
      { anchor: "figma.com", source: "runs/sweep-figma-com-x.json", dir: "runs/exports/kb-sweep-figma-com-x", entities: 5 },
    ]
    const index = renderIndex(rows)
    expect(index.indexOf("## figma.com")).toBeLessThan(index.indexOf("## vercel.com"))
    expect(index).toContain("- [runs/sweep-figma-com-x.json](kb-sweep-figma-com-x/README.md) — 5 entities")
  })

  it("adds a diff link between the two newest runs of the same anchor, and only then", () => {
    const rows: IndexRow[] = [
      { anchor: "figma.com", source: "runs/a.json", dir: "runs/exports/kb-a", entities: 5 },
      { anchor: "figma.com", source: "runs/b.json", dir: "runs/exports/kb-b", entities: 6 },
    ]
    expect(renderIndex(rows)).toContain("Drift between runs: `pnpm run diff runs/a.json runs/b.json`")
    expect(renderIndex([rows[0]!])).not.toContain("Drift between runs:")
  })

  it("stays a well-formed page with zero rows", () => {
    const index = renderIndex([])
    expect(index).toContain("# The knowledge lake")
    expect(index).not.toContain("##")
  })
})
