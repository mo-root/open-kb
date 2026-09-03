import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
// Relative, not "@open-kb/core": the root package.json declares no dependency on either
// workspace package, so a bare specifier from here does not resolve — the same reason
// tests/live/ imports this way.
import { exportKbFiles } from "../packages/core/src/index.js"
import { exportTargetRefusal, judgeExportTarget } from "../scripts/export-target.js"

// The fixture is the real exporter's output, never a hand-written imitation: the guard's
// markers are claims about what exportKbFiles() writes, so a test that typed those bytes
// itself would agree with the guard forever, including after the exporter changed.
const files = exportKbFiles({
  anchor: "clerk.com",
  entities: [
    { name: "Auth0", domain: "auth0.com", kind: "company", relation: "competitor", tier: "own-page", foundBy: ["Auth"] },
    { name: "Stytch", domain: "stytch.com", kind: "company", relation: "substitute", tier: "page", foundBy: ["Auth"] },
  ],
})

let root: string

/** Write files into dir without deleting anything — deliberately not writeExport(): a test
 *  for a delete guard must never be able to delete. */
function writeInto(dir: string, list: Array<{ path: string; content: string }>): void {
  for (const f of list) {
    const p = join(dir, f.path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, f.content)
  }
}

/** A fresh directory under the temp root. Every path this file judges comes from here or
 *  from examples/, which is only ever read. */
function dir(name: string, list: Array<{ path: string; content: string }> = []): string {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  writeInto(d, list)
  return d
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "open-kb-export-target-"))
})

afterAll(() => {
  // Only ever the directory mkdtemp handed back, never a path assembled in a test body.
  if (root && root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

describe("judgeExportTarget", () => {
  it("clears a path that does not exist — the first export of an anchor", () => {
    expect(judgeExportTarget(join(root, "never-written"))).toEqual({
      writable: true,
      because: "absent",
      foreign: [],
    })
  })

  it("clears an empty directory", () => {
    expect(judgeExportTarget(dir("empty")).because).toBe("empty")
  })

  it("clears a complete export — a re-run overwrites its own last map", () => {
    const verdict = judgeExportTarget(dir("complete", files))
    expect(verdict.writable).toBe(true)
    expect(verdict.because).toBe("prior-export")
  })

  it("clears an export written before SKILL.md and llms.txt existed", () => {
    const old = files.filter((f) => f.path !== "SKILL.md" && f.path !== "llms.txt")
    expect(judgeExportTarget(dir("older", old)).because).toBe("prior-export")
  })

  it("clears an export whose manifest never landed — an interrupted run is not a wall", () => {
    // The half-written case. Keying on manifest.json alone would make a folder a crash
    // created un-overwritable forever, so the next run would have to --force past its own
    // wreckage. AGENTS.md is written first, so every prefix of a real export still vouches.
    for (let written = 1; written <= files.length; written++) {
      const partial = files.slice(0, written)
      const verdict = judgeExportTarget(dir(`partial-${written}`, partial))
      expect(verdict.writable, `${written} of ${files.length} files written`).toBe(true)
      expect(verdict.because).toBe("prior-export")
    }
    expect(files.some((f) => f.path === "manifest.json")).toBe(true)
    expect(files.findIndex((f) => f.path === "manifest.json")).toBeGreaterThan(0)
  })

  it("refuses a home directory, and names what it found", () => {
    const home = dir("home")
    mkdirSync(join(home, "Documents"))
    mkdirSync(join(home, "Desktop"))
    writeFileSync(join(home, ".zshrc"), "export PATH=/usr/bin\n")
    const verdict = judgeExportTarget(home)
    expect(verdict.writable).toBe(false)
    expect(verdict.because).toBe("foreign-contents")
    expect(verdict.foreign).toEqual([".zshrc", "Desktop", "Documents"])
  })

  it("refuses a project directory, README and all", () => {
    const repo = dir("repo", [
      { path: "README.md", content: "# my project\n" },
      { path: "package.json", content: "{}\n" },
      { path: "src/index.ts", content: "export {}\n" },
    ])
    const verdict = judgeExportTarget(repo)
    expect(verdict.writable).toBe(false)
    expect(verdict.foreign).toEqual(["package.json", "src"])
  })

  it("refuses a folder whose names look like an export but whose files are not", () => {
    // Names alone must not authorize a delete: a skills folder holds SKILL.md and a README,
    // and every entry here is on the exporter's list.
    const decoy = dir("decoy", [
      { path: "README.md", content: "# notes\n" },
      { path: "SKILL.md", content: "---\nname: my-own-skill\n---\n" },
      { path: "entities/people.md", content: "everyone I know\n" },
    ])
    const verdict = judgeExportTarget(decoy)
    expect(verdict.writable).toBe(false)
    expect(verdict.because).toBe("unmarked")
    expect(verdict.foreign).toEqual([])
  })

  /* Both cases below were found by attacking the first version of this guard,
     with working repros through the real entrypoint. Neither was hypothetical:
     the first erased a skill folder and the second a folder of hand-written
     research, both silently and both exit 0. */

  it("refuses a skill folder whose name merely starts with kb-", () => {
    // The marker used to be `name: kb-`, which is a naming convention rather
    // than anything this exporter emits — and `kb-` is the obvious prefix for a
    // knowledge-base skill. Every entry here is on the name list, so the marker
    // was the only thing standing between this folder and a recursive delete.
    const skill = dir("kb-notes", [
      { path: "SKILL.md", content: "---\nname: kb-notes\ndescription: my notes skill\n---\n\n# my notes\n" },
      { path: "README.md", content: "# my own readme\n\nyears of curation\n" },
    ])
    const verdict = judgeExportTarget(skill)
    expect(verdict.writable).toBe(false)
    expect(verdict.because).toBe("unmarked")
  })

  it("treats a top-level export name that is a file, not a directory, as foreign", () => {
    // `foreignInside` assumes each of DIR_CONTENTS' four names, if present, is a
    // directory it can `readdirSync` — `entities`, `relations`, `segments` and
    // `evidence` are all exporter-written folders and no test had ever made one
    // of them a plain file instead. `statSync(dir).isDirectory()` is exactly the
    // guard against that shape, and it had never been driven false.
    const flat = dir("kb-flat-entities", [
      { path: "AGENTS.md", content: "# How to use this knowledge base\n" },
      { path: "manifest.json", content: JSON.stringify({ anchor: "clerk.com", entities: [], files: [] }) },
    ])
    writeFileSync(join(flat, "entities"), "not a directory\n")
    const verdict = judgeExportTarget(flat)
    expect(verdict.writable).toBe(false)
    expect(verdict.because).toBe("foreign-contents")
    expect(verdict.foreign).toEqual(["entities"])
  })

  it("refuses an export somebody has parked their own work inside", () => {
    // The top-level check cannot see one level down, and the delete is
    // recursive — so `entities/` and `evidence/` are exactly where a person's
    // own files would be, and exactly what the guard used to wave through.
    const parked = dir("kb-clerk-com", [
      { path: "AGENTS.md", content: "# How to use this knowledge base\n" },
      { path: "manifest.json", content: JSON.stringify({ anchor: "clerk.com", entities: [], files: [] }) },
      { path: "entities/auth0-com.md", content: "# auth0\n" },
      { path: "entities/my-research/notes.md", content: "six months of hand-written analysis\n" },
      { path: "evidence/my-interview-transcripts.txt", content: "irreplaceable\n" },
    ])
    const verdict = judgeExportTarget(parked)
    expect(verdict.writable).toBe(false)
    expect(verdict.because).toBe("foreign-contents")
    expect(verdict.foreign).toEqual(["entities/my-research", "evidence/my-interview-transcripts.txt"])
  })

  it("still clears a real export, whose directories hold only what it wrote", () => {
    const real = dir("kb-real", [
      { path: "AGENTS.md", content: "# How to use this knowledge base\n" },
      { path: "manifest.json", content: JSON.stringify({ anchor: "clerk.com", entities: [], files: [] }) },
      { path: "entities/auth0-com.md", content: "# auth0\n" },
      { path: "relations/competitor.md", content: "# competitors\n" },
      { path: "segments/auth.md", content: "# auth\n" },
      { path: "evidence/receipts.md", content: "# receipts\n" },
    ])
    expect(judgeExportTarget(real)).toEqual({ writable: true, because: "prior-export", foreign: [] })
  })

  it("refuses a manifest.json that is some other tool's", () => {
    const webapp = dir("webapp", [
      { path: "manifest.json", content: JSON.stringify({ name: "My PWA", icons: [] }) },
      { path: "README.md", content: "# pwa\n" },
    ])
    expect(judgeExportTarget(webapp).because).toBe("unmarked")
  })

  it("refuses a file", () => {
    const f = join(dir("holder"), "notes.md")
    writeFileSync(f, "# notes\n")
    expect(judgeExportTarget(f)).toEqual({ writable: false, because: "not-a-directory", foreign: [] })
  })

  it("still clears an export somebody opened in Finder", () => {
    const browsed = dir("browsed", files)
    writeFileSync(join(browsed, ".DS_Store"), "\0\0")
    expect(judgeExportTarget(browsed).because).toBe("prior-export")
  })

  it("treats a folder holding only .DS_Store as empty", () => {
    const touched = dir("touched")
    writeFileSync(join(touched, ".DS_Store"), "\0\0")
    expect(judgeExportTarget(touched).because).toBe("empty")
  })

  it("clears the export checked into this repo, unmodified", () => {
    // examples/kb-clerk-com is a real generated export and the only fixture nobody wrote by
    // hand. Read only — the guard never writes, and neither does this.
    const verdict = judgeExportTarget(join("examples", "kb-clerk-com"))
    expect(verdict.writable).toBe(true)
    expect(verdict.because).toBe("prior-export")
  })
})

describe("exportTargetRefusal", () => {
  it("resolves the path, so `.` says what it meant, and prints the command that works", () => {
    const verdict = { writable: false, because: "foreign-contents" as const, foreign: ["package.json", "src"] }
    const lines = exportTargetRefusal(".", verdict, "pnpm run export runs/x.json . --force")
    expect(lines[0]).toBe(`refusing to erase ${resolve(".")} — it holds package.json, src`)
    expect(lines.join("\n")).toContain("pnpm run export runs/x.json . --force")
    expect(lines.join("\n")).toContain("runs/exports/kb-<anchor>/")
  })

  it("counts the rest when a folder holds more than it can name", () => {
    const verdict = {
      writable: false,
      because: "foreign-contents" as const,
      foreign: ["Applications", "Desktop", "Documents", "Downloads", "Movies"],
    }
    expect(exportTargetRefusal("/Users/someone", verdict, "x")[0]).toContain(
      "it holds Applications, Desktop, Documents and 2 more",
    )
  })

  it("says a file is a file, not that it is unmarked", () => {
    const verdict = { writable: false, because: "not-a-directory" as const, foreign: [] }
    expect(exportTargetRefusal("notes.md", verdict, "x")[0]).toContain("it is a file, not a directory")
  })
})
