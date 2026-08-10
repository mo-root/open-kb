/**
 * What may be erased.
 *
 * An export is written wholesale — the target directory is deleted before it is
 * rewritten — which is right for a folder this tool wrote and catastrophic for
 * one somebody typed. `pnpm run export runs/x.json ~/Documents` erased
 * ~/Documents and then wrote a market map into it; `rmSync(force: true)` does
 * not even complain about a path it has never seen, so there was nothing to
 * notice. The delete now asks one question first, and this answers it.
 *
 * It answers from what the exporter actually writes (packages/core/src/
 * export-kb.ts), not from the folder's name: every entry of an export comes
 * from a fixed list, down one level as well as at the top, and AGENTS.md,
 * SKILL.md, llms.txt and manifest.json open with text this tool emits. All
 * three parts are needed, and the two that were added came from someone
 * attacking the first. The name list alone clears a skills folder holding
 * SKILL.md and a README. A marker alone clears a repo that had been exported
 * into once. And a marker keyed on a naming convention rather than on emitted
 * text is not a marker at all — `name: kb-` matched any skill called kb-
 * anything, so the guard cleared one and wrote a market map over it. The
 * top-level list is also blind by construction: it says nothing about what sits
 * inside `entities/` or `evidence/`, which is where a person's own work would
 * be, and the delete is recursive. Checked against every export this repo had
 * produced when it was written — examples/kb-clerk-com and the 55 in
 * runs/exports/, one of them old enough to predate SKILL.md and llms.txt, which
 * is why the name list is a superset.
 *
 * A half-written export stays writable, on purpose. The files land in sorted
 * order, so AGENTS.md is written first and manifest.json second to last: a run
 * killed in the middle leaves a folder with no manifest, and keying the marker
 * on manifest.json alone would make that folder permanently un-overwritable —
 * a crash would cost the next run a --force. Any one of the four markers
 * vouches for the folder, so every prefix of a real export is recognised as
 * one, and the instant between the delete and the first write leaves a folder
 * that is simply empty.
 *
 * Lives here and not in packages/core, which stays pure: this reads the disk.
 * export-kb.ts keeps its shape — argv, mkdir and a console — and asks this.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

/** Every top-level name exportKbFiles() can put in an export folder, files and
 *  directories alike. A superset: an older export missing SKILL.md is still an
 *  export, so absence never counts against a folder — only a stranger does. */
const EXPORT_ENTRIES = new Set([
  "AGENTS.md",
  "README.md",
  "SKILL.md",
  "entities",
  "evidence",
  "llms.txt",
  "manifest.json",
  "relations",
  "segments",
])

/** The one entry a real export can hold that the exporter did not write: Finder
 *  drops it into any folder a person opens, and an export is meant to be read.
 *  Ignoring it keeps a browsed export overwritable. It cannot launder a foreign
 *  folder — a marker still has to vouch for what is left. */
const IGNORED_ENTRIES = new Set([".DS_Store"])

/**
 * What each export directory may hold, one level down.
 *
 * The top-level name list is not enough on its own. `entities/`, `evidence/`,
 * `relations/` and `segments/` are names a person might also use, and a folder
 * whose top level looks like an export can have anything at all parked inside
 * one of them — six months of hand-written notes under `entities/`, a
 * transcript in `evidence/` — none of which the top-level check can see and all
 * of which the recursive delete takes. The exporter writes one flat `.md` per
 * row (export-kb.ts:231, :251, :270), so a subdirectory or any other name is
 * somebody else's.
 *
 * `evidence/receipts.md` is here for the exports that still have one. The
 * exporter stopped writing it — a receipt now lives only on the note of the
 * claim it grounds — but the 55 folders in runs/exports/ predate that, and
 * absence never counts against a folder while a stranger always does. Nothing
 * new will ever land in `evidence/`; this keeps the old ones overwritable.
 */
const DIR_CONTENTS: Record<string, (name: string) => boolean> = {
  entities: (n) => n.endsWith(".md"),
  relations: (n) => n.endsWith(".md"),
  segments: (n) => n.endsWith(".md"),
  evidence: (n) => n === "receipts.md",
}

/**
 * Openers only this exporter writes. Any one of them vouches for the folder.
 *
 * Each has to be text this tool emits, not a convention it happens to follow.
 * `SKILL.md` was keyed on `name: kb-` alone, which is a natural prefix for a
 * knowledge-base skill and not a fingerprint: an agent skill folder holding
 * just SKILL.md and README.md passes the name list, and `kb-notes` matched, so
 * the guard cleared somebody's skill and rewrote it as a market map. The body
 * heading below (export-kb.ts:419) is the part no one writes by accident.
 */
const MARKERS: ReadonlyArray<readonly [string, (raw: string) => boolean]> = [
  ["AGENTS.md", (raw) => raw.startsWith("# How to use this knowledge base")],
  ["SKILL.md", (raw) => /^---\nname: kb-[\s\S]*?\n# Swimming in this map\n/.test(raw)],
  ["llms.txt", (raw) => /^# .+ market map\n/.test(raw)],
  [
    "manifest.json",
    (raw) => {
      try {
        const m = JSON.parse(raw) as { anchor?: unknown; entities?: unknown; files?: unknown }
        return typeof m.anchor === "string" && Array.isArray(m.entities) && Array.isArray(m.files)
      } catch {
        return false
      }
    },
  ],
]

export interface ExportTargetVerdict {
  /** May the writer delete this path and rewrite it? */
  writable: boolean
  because: "absent" | "empty" | "prior-export" | "not-a-directory" | "foreign-contents" | "unmarked"
  /** Top-level entries no export ever holds — what makes the folder a stranger's. Empty otherwise. */
  foreign: string[]
}

/** Anything one level inside an export directory that the exporter would not
 *  have put there, named `<dir>/<child>` so the refusal can point at it. A name
 *  the exporter writes as a directory but which is a file here counts too. */
function foreignInside(outDir: string, entries: string[]): string[] {
  const out: string[] = []
  for (const name of entries) {
    const allows = DIR_CONTENTS[name]
    if (!allows) continue
    const dir = join(outDir, name)
    if (!statSync(dir).isDirectory()) {
      out.push(name)
      continue
    }
    for (const child of readdirSync(dir)) {
      if (IGNORED_ENTRIES.has(child)) continue
      if (!allows(child) || statSync(join(dir, child)).isDirectory()) out.push(`${name}/${child}`)
    }
  }
  return out
}

/** Decide whether outDir may be erased and rewritten. Reads; never writes. */
export function judgeExportTarget(outDir: string): ExportTargetVerdict {
  if (!existsSync(outDir)) return { writable: true, because: "absent", foreign: [] }
  if (!statSync(outDir).isDirectory()) return { writable: false, because: "not-a-directory", foreign: [] }

  const entries = readdirSync(outDir).filter((name) => !IGNORED_ENTRIES.has(name))
  if (entries.length === 0) return { writable: true, because: "empty", foreign: [] }

  const foreign = [...entries.filter((name) => !EXPORT_ENTRIES.has(name)), ...foreignInside(outDir, entries)].sort()
  if (foreign.length > 0) return { writable: false, because: "foreign-contents", foreign }

  const marked = MARKERS.some(([name, opens]) => {
    if (!entries.includes(name)) return false
    try {
      return opens(readFileSync(join(outDir, name), "utf8"))
    } catch {
      return false
    }
  })
  return marked
    ? { writable: true, because: "prior-export", foreign: [] }
    : { writable: false, because: "unmarked", foreign: [] }
}

function nameList(names: string[]): string {
  const head = names.slice(0, 3).join(", ")
  const rest = names.length - 3
  return rest > 0 ? `${head} and ${rest} more` : head
}

/** The refusal, as lines for stderr: the resolved path (so `.` and `~` say what
 *  they meant), why it was refused, and the two ways forward — a different
 *  target, or this one on purpose. `retry` is the caller's own argv with the
 *  flag appended, so the printed command is the exact one that would work. */
export function exportTargetRefusal(outDir: string, verdict: ExportTargetVerdict, retry: string): string[] {
  const why =
    verdict.because === "not-a-directory"
      ? "it is a file, not a directory"
      : verdict.because === "foreign-contents"
        ? `it holds ${nameList(verdict.foreign)}`
        : "nothing in it was written by this exporter"
  return [
    `refusing to erase ${resolve(outDir)} — ${why}`,
    `an export is written wholesale, so its target is deleted first; that is only safe for a`,
    `folder this tool wrote (one opens with AGENTS.md, SKILL.md, llms.txt and manifest.json).`,
    `leave the outDir off to write the default runs/exports/kb-<anchor>/, or erase this path`,
    `on purpose:`,
    `  ${retry}`,
  ]
}
