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
 * IT IS DELIBERATELY LOCAL AND IN-MEMORY. A restart forgets every run and a
 * second server process shares nothing. That is the correct trade for a local
 * demo — the alternative is a durability story, and a durability story is
 * exactly the thing that cost v1 its orchestration. Nothing here should grow a
 * database without that conversation happening first.
 */

export type RunStatus = "running" | "complete" | "failed"

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
