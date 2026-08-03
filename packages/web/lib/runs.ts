import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { SpanStream } from "@open-kb/core"
import type { SweepResult } from "@open-kb/sweep"

/**
 * Every run this server is holding.
 *
 * WHAT THIS REPLACES. v1 started a run with `start(buildWorkflow)` and read it
 * back with `getRun(id).getReadable({ namespace })` — the durable-workflow
 * platform owned the run's identity, its stream and its return value, and in
 * exchange every step had to live inside a `"use step"` sandbox. That sandbox
 * is what strangled the orchestration this rewrite exists to free.
 *
 * So the platform is gone and this is what is left of it: a Map. A run is a
 * plain async function writing into a `SpanStream`; this holds the stream so a
 * browser can attach to it, and holds the result so a browser that attached too
 * late can still read the answer.
 *
 * THE STREAM IS IN-MEMORY. THE ANSWER IS NOT.
 *
 * The registry above is still deliberately local: a restart forgets every live
 * stream, and a second server process shares none of them. That is the correct
 * trade for a stream — it is only interesting while a run is in flight.
 *
 * The RESULT is a different fact. A finished run is a knowledge base, /kb lists
 * knowledge bases, and a gallery that empties itself every time the dev server
 * restarts is a gallery that says the work never happened. So a run that
 * finishes is also written to `runs/run-<id>.json` — one JSON file per run,
 * under a directory that is already gitignored. That is the whole durability
 * story: no database, no schema, no migration, and a `rm` is a valid uninstall.
 *
 * `run-` prefixed on purpose. `runs/` already holds `sweep-*.json` written by
 * `scripts/sweep.ts` (a bare `SweepResult`, no envelope), and the loader must
 * not read one shape as the other.
 */

export type RunStatus = "running" | "complete" | "failed"

/** A finished run as it lands on disk — the registry's fields minus the stream,
 *  which is the one thing that cannot outlive the process. */
export interface StoredRun {
  id: string
  domain: string
  queries: number
  startedAt: number
  endedAt?: number
  status: RunStatus
  result: SweepResult
}

export interface RunRecord {
  id: string
  domain: string
  queries: number
  startedAt: number
  endedAt?: number
  status: RunStatus
  spans: SpanStream
  result?: SweepResult
  error?: string
}

/**
 * Held on `globalThis`, not in a module-level `const`.
 *
 * Next's dev server re-evaluates a route's module graph on edit, and a fresh
 * module instance means a fresh Map — every in-flight run would vanish from the
 * registry while its background task carried on spending money into a stream
 * nobody could reach. The global survives the re-evaluation.
 */
const KEY = Symbol.for("open-kb.runs")
type Registry = Map<string, RunRecord>
const g = globalThis as unknown as { [KEY]?: Registry }
const runs: Registry = (g[KEY] ??= new Map())

/** How many finished runs are kept before the oldest is dropped. A run holds
 *  its whole span log, so an unbounded registry is an unbounded heap. */
const KEEP_FINISHED = 20

export function createRun(domain: string, queries: number): RunRecord {
  const record: RunRecord = {
    id: crypto.randomUUID(),
    domain,
    queries,
    startedAt: Date.now(),
    status: "running",
    spans: new SpanStream(),
  }
  runs.set(record.id, record)
  evict()
  return record
}

export function getRun(id: string): RunRecord | undefined {
  return runs.get(id)
}

export function finishRun(id: string, result: SweepResult): void {
  const r = runs.get(id)
  if (!r) return
  r.result = result
  r.status = "complete"
  r.endedAt = Date.now()
  // Closing ends every attached `stream()`, including ones parked waiting for
  // the next span. A reader that never sees the close spins forever on a run
  // that finished minutes ago.
  r.spans.close()
  // Not awaited: the caller is the sweep's completion path, and a run that
  // succeeded must not be reported as failed because a disk write was slow.
  // A write that fails is logged and the run stays readable from memory until
  // the process ends — losing the file is losing a listing, not losing work.
  void persist(r).catch((e) => {
    console.error(`[runs] could not persist ${id}:`, e)
  })
}

export function failRun(id: string, error: unknown): void {
  const r = runs.get(id)
  if (!r) return
  r.error = error instanceof Error ? error.message : String(error)
  r.status = "failed"
  r.endedAt = Date.now()
  r.spans.close()
}

function evict(): void {
  const finished = [...runs.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
    runs.delete(r.id)
  }
}

/* ------------------------------------------------------------------- on disk */

/**
 * Where the JSON goes.
 *
 * `next.config.ts` sets `OPENKB_RUNS_DIR` in the same Node process that then
 * serves every route — the same trick it already uses to read the repo-root
 * `.env` — so the normal path needs no guessing. The walk-up is the fallback
 * for anything that imports this module outside a Next server (a script, a
 * test), and `<cwd>/runs` is the last resort.
 */
function runsDir(): string {
  const fromEnv = process.env.OPENKB_RUNS_DIR
  if (fromEnv) return fromEnv
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.join(dir, "runs")
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.resolve(process.cwd(), "runs")
}

const FILE_PREFIX = "run-"

/**
 * `scripts/sweep.ts` writes a bare `SweepResult` to `runs/sweep-<domain>.json` —
 * no envelope, no id, no timestamps, because a terminal does not need them.
 *
 * A run costing real money and half an hour of waiting should not be invisible in
 * the browser purely because of where it was started from, so the gallery adopts
 * those files too: the filename supplies the id, and the timings come from the
 * result the sweep already records. The two shapes stay distinct on disk — this
 * reads one as the other deliberately, rather than by accident.
 */
const CLI_PREFIX = "sweep-"

function adoptCliRun(filename: string, parsed: unknown): StoredRun | null {
  if (!parsed || typeof parsed !== "object") return null
  const r = parsed as Partial<SweepResult> & { stats?: Partial<SweepResult["stats"]> }
  // `anchor`, not `domain` — the sweep names the company it started from, and the
  // registry names the thing a run was asked about. Same value, different word.
  if (typeof r.anchor !== "string" || !Array.isArray(r.entities)) return null

  const id = filename.slice(CLI_PREFIX.length, -".json".length)
  const seconds = r.stats?.seconds ?? 0
  // The CLI records duration, not wall-clock instants. Anchor the run to the file's
  // own name-derived identity and treat "now minus duration" as its start: the
  // gallery orders by end time, and an undated run would sort to the beginning of
  // time and read as the oldest thing here.
  const endedAt = Date.now()
  return {
    id,
    domain: r.anchor,
    queries: r.stats?.queries ?? r.queries?.length ?? 0,
    startedAt: endedAt - Math.round(seconds * 1000),
    endedAt,
    status: "complete",
    result: r as SweepResult,
  }
}

/**
 * An id has to look like the `crypto.randomUUID()` that minted it.
 *
 * It reaches the read side as a URL path segment, so anything outside the UUID
 * alphabet is refused rather than escaped: a traversal here would read an
 * arbitrary JSON file off the host and serve it as a knowledge base.
 *
 * Both the LIST and the READ go through this. They used not to, and the
 * mismatch was a live bug: a file whose id failed the check was still listed by
 * `listStoredRuns` (which only read the filename) and then 404'd when the
 * reader clicked it — a gallery card that opens onto nothing.
 */
function isRunId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
}

function fileFor(id: string): string {
  if (!isRunId(id)) throw new Error(`not a run id: ${id}`)
  return path.join(runsDir(), `${FILE_PREFIX}${id}.json`)
}

async function persist(r: RunRecord): Promise<void> {
  if (!r.result) return
  const stored: StoredRun = {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status,
    result: r.result,
  }
  await mkdir(runsDir(), { recursive: true })
  await writeFile(fileFor(r.id), JSON.stringify(stored, null, 2), "utf8")
}

/** A record only counts as stored once it has a result — a run that is still
 *  in flight has nothing to read. */
function storedFrom(r: RunRecord): StoredRun | null {
  if (!r.result || r.status !== "complete") return null
  return {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status,
    result: r.result,
  }
}

function isStoredRun(v: unknown): v is StoredRun {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  const result = o.result as Record<string, unknown> | undefined
  return (
    isRunId(o.id) &&
    typeof o.domain === "string" &&
    !!result &&
    typeof result.anchor === "string" &&
    Array.isArray(result.entities)
  )
}

/**
 * Every completed run, newest first.
 *
 * Memory wins over disk for the same id: the in-process record is the one a
 * just-finished run is readable from before its file has landed. A file that
 * does not parse is SKIPPED and logged rather than thrown — one corrupt run
 * must not take the whole gallery down with it.
 */
export async function listStoredRuns(): Promise<StoredRun[]> {
  const byId = new Map<string, StoredRun>()

  let names: string[] = []
  try {
    names = await readdir(runsDir())
  } catch {
    names = [] // no runs/ yet — that is an empty gallery, not an error
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    if (!name.startsWith(FILE_PREFIX) && !name.startsWith(CLI_PREFIX)) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(runsDir(), name), "utf8"))
      const stored = isStoredRun(parsed) ? parsed : adoptCliRun(name, parsed)
      if (stored) byId.set(stored.id, stored)
    } catch (e) {
      console.error(`[runs] skipping unreadable ${name}:`, e)
    }
  }
  for (const r of runs.values()) {
    const s = storedFrom(r)
    if (s) byId.set(s.id, s)
  }

  return [...byId.values()].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
}

/** One completed run. Memory first — a run that finished a moment ago is
 *  readable before its file lands. */
export async function getStoredRun(id: string): Promise<StoredRun | null> {
  const live = runs.get(id)
  if (live) {
    const s = storedFrom(live)
    if (s) return s
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(fileFor(id), "utf8"))
    if (isStoredRun(parsed)) return parsed
  } catch {
    // not a browser-started run — fall through and try the CLI's shape
  }
  const name = `${CLI_PREFIX}${id}.json`
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(runsDir(), name), "utf8"))
    return adoptCliRun(name, parsed)
  } catch {
    return null
  }
}
