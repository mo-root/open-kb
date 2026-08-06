import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { SpanStream, type Span } from "@open-kb/core"
import * as db from "./store/supabase"
import type { SweepResult } from "@open-kb/sweep"

/**
 * Every run this server is holding.
 *
 * v1 used a durable-workflow platform that owned each run's identity, stream
 * and return value, and required every step to live in a `"use step"` sandbox.
 * That sandbox is what this rewrite exists to escape, so what replaces it is a
 * Map. A run is a plain async function writing into a `SpanStream`.
 *
 * The stream stays in memory: a restart forgets every live stream, and a stream
 * only matters while a run is in flight.
 *
 * The result does not. A finished run is a knowledge base and /kb lists those,
 * so a gallery that empties on every dev restart claims the work never
 * happened. Finished runs are written to `runs/run-<id>.json`. No database, no
 * schema, and `rm` is a valid uninstall.
 *
 * The `run-` prefix matters: `runs/` also holds `sweep-*.json` from
 * `scripts/sweep.ts`, which is a bare `SweepResult` with no envelope.
 */

export type RunStatus = "running" | "complete" | "failed"

/** A finished run as it lands on disk, the registry's fields minus the stream,
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
  /**
   * How to stop this run.
   *
   * The sweep has honoured an AbortSignal at four checkpoints and on every
   * model call since it was written, and nothing ever passed one. So the only
   * way to stop a run was to kill the process, which is also the only way to
   * lose everything it had paid for: cancel and destroy were the same button.
   */
  abort: AbortController
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
 * module instance means a fresh Map, every in-flight run would vanish from the
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
    abort: new AbortController(),
  }
  runs.set(record.id, record)
  evict()

  if (db.configured()) {
    void db.upsertRun({
      id: record.id,
      domain,
      queries,
      status: "running",
      started_at: new Date(record.startedAt).toISOString(),
    })
    void pump(record)
  }
  return record
}

/**
 * Write spans to Postgres while the run is still going.
 *
 * The whole reason this exists: a run's output lived only in this process until
 * the pipeline's last instruction, so a server that died at minute 11 of 12
 * discarded every search and model call already paid for. Spans land as they
 * are emitted, so a dead run is a readable one.
 *
 * Batched on both count and time. One HTTP call per span would add a round trip
 * to every SERP result; waiting for a full batch would lose the tail of a run
 * that crashes mid-batch, which is the case this is for.
 */
const FLUSH_SPANS = 25
const FLUSH_MS = 3_000

async function pump(record: RunRecord): Promise<void> {
  let batch: Span[] = []
  let last = Date.now()

  const flush = async () => {
    if (!batch.length) return
    const sending = batch
    batch = []
    last = Date.now()
    await db.appendSpans(record.id, sending)
  }

  try {
    for await (const span of record.spans.stream()) {
      batch.push(span)
      if (batch.length >= FLUSH_SPANS || Date.now() - last >= FLUSH_MS) await flush()
    }
  } catch (e) {
    console.error(`[runs] span pump for ${record.id} stopped:`, e)
  }
  // The stream closed, so `finishRun` or `failRun` has already run. Whatever is
  // still in hand is the tail of the run and is the most interesting part of it.
  await flush()
}

export function getRun(id: string): RunRecord | undefined {
  return runs.get(id)
}

/**
 * Stop a run, keeping what it has already found.
 *
 * The sweep throws on its next checkpoint, the catch in the map route records
 * it, and everything already streamed is already in Postgres. A cancelled run
 * is a short run, not a lost one.
 */
export function cancelRun(id: string): boolean {
  const r = runs.get(id)
  if (!r || r.status !== "running") return false
  r.abort.abort()
  return true
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
  // the process ends, losing the file is losing a listing, not losing work.
  void persist(r).catch((e) => {
    console.error(`[runs] could not persist ${id}:`, e)
  })
  if (db.configured()) {
    void db.upsertRun({
      id: r.id,
      domain: r.domain,
      queries: r.queries,
      status: "complete",
      started_at: new Date(r.startedAt).toISOString(),
      ended_at: new Date(r.endedAt).toISOString(),
      result,
    })
  }
}

export function failRun(id: string, error: unknown): void {
  const r = runs.get(id)
  if (!r) return
  r.error = error instanceof Error ? error.message : String(error)
  r.status = "failed"
  r.endedAt = Date.now()
  r.spans.close()
  // A failed run is recorded, unlike the file path which drops it entirely.
  // It cost real money and its spans say exactly where it stopped.
  if (db.configured()) {
    void db.upsertRun({
      id: r.id,
      domain: r.domain,
      queries: r.queries,
      status: "failed",
      started_at: new Date(r.startedAt).toISOString(),
      ended_at: new Date(r.endedAt).toISOString(),
      error: r.error,
    })
  }
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
 * serves every route, the same trick it already uses to read the repo-root
 * `.env`, so the normal path needs no guessing. The walk-up is the fallback
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
 * result the sweep already records. The two shapes stay distinct on disk, this
 * reads one as the other deliberately, rather than by accident.
 */
const CLI_PREFIX = "sweep-"
// The swarm's CLI writes the same shape under its own name; a run costing real
// money should not be invisible in the browser purely because of which engine
// produced it. Both prefixes adopt through the same reader.
const SWARM_PREFIX = "swarm-"

function adoptCliRun(filename: string, parsed: unknown): StoredRun | null {
  if (!parsed || typeof parsed !== "object") return null
  const r = parsed as Partial<SweepResult> & { stats?: Partial<SweepResult["stats"]> }
  // `anchor`, not `domain`, the sweep names the company it started from, and the
  // registry names the thing a run was asked about. Same value, different word.
  if (typeof r.anchor !== "string" || !Array.isArray(r.entities)) return null

  const prefix = filename.startsWith(SWARM_PREFIX) ? SWARM_PREFIX : CLI_PREFIX
  // A swarm run keeps its prefix in the id so the two engines' runs of one
  // anchor stay distinct in the gallery instead of colliding on the stamp.
  const id = filename.startsWith(SWARM_PREFIX)
    ? filename.slice(0, -".json".length)
    : filename.slice(prefix.length, -".json".length)
  const seconds = r.stats?.seconds ?? 0
  // The CLI stamps its filenames `<domain>-yyyymmddhhmm`, so the run's real end
  // time is recoverable from the id and the gallery can order CLI runs against
  // each other honestly. Files written before the stamp existed fall back to
  // `Date.now()`: the CLI records a duration, not wall-clock instants, and an
  // undated run left at zero would sort to the beginning of time and read as the
  // oldest thing here.
  const stamped = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id)
  const endedAt = stamped
    ? Date.parse(`${stamped[1]}-${stamped[2]}-${stamped[3]}T${stamped[4]}:${stamped[5]}:00Z`)
    : Date.now()
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
 * Both the list and the read go through this. They used not to, and the
 * mismatch was a live bug: a file whose id failed the check was still listed by
 * `listStoredRuns` (which only read the filename) and then 404'd when the
 * reader clicked it, a gallery card that opens onto nothing.
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

/** A record only counts as stored once it has a result, a run that is still
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
 * does not parse is skipped and logged rather than thrown, one corrupt run
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
    if (!name.startsWith(FILE_PREFIX) && !name.startsWith(CLI_PREFIX) && !name.startsWith(SWARM_PREFIX)) continue
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(runsDir(), name), "utf8"))
      const stored = isStoredRun(parsed) ? parsed : adoptCliRun(name, parsed)
      if (stored) byId.set(stored.id, stored)
    } catch (e) {
      console.error(`[runs] skipping unreadable ${name}:`, e)
    }
  }
  for (const stored of await db.listRuns()) byId.set(stored.id, stored)
  for (const r of runs.values()) {
    const s = storedFrom(r)
    if (s) byId.set(s.id, s)
  }

  return [...byId.values()].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
}

/** One completed run. Memory first, a run that finished a moment ago is
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
    // not a browser-started run, fall through and try the CLI's shape
  }
  for (const name of id.startsWith(SWARM_PREFIX)
    ? [`${id}.json`]
    : [`${CLI_PREFIX}${id}.json`]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(runsDir(), name), "utf8"))
      return adoptCliRun(name, parsed)
    } catch {
      // not on disk either, keep looking
    }
  }
  return db.getRunRow(id)
}
