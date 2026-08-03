import type { Span } from "@open-kb/core"
import type { SweepResult } from "@open-kb/sweep"
import type { RunStatus, StoredRun } from "../runs"

/**
 * Runs and their spans, in Postgres, over Supabase's PostgREST endpoint.
 *
 * Over HTTP rather than a Postgres socket, following v1: this runs in
 * serverless functions where connection pools are a liability, and PostgREST
 * needs no pool and no driver.
 *
 * Every function here returns rather than throws when the store is not
 * configured, so the file-backed path in lib/runs.ts stays the default and a
 * missing key never takes a route down. Schema: scripts/supabase-schema.sql.
 */

export interface RunRow {
  id: string
  domain: string
  queries: number
  status: RunStatus
  started_at: string
  ended_at?: string | null
  error?: string | null
  result?: SweepResult | null
}

function config(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) return null
  return { url: url.replace(/\/+$/, ""), key }
}

export function configured(): boolean {
  return config() !== null
}

async function rest(path: string, init: RequestInit = {}): Promise<Response | null> {
  const cfg = config()
  if (!cfg) return null
  return fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    // Next patches fetch and caches GETs by default. A run's state is the one
    // thing that must never come from a build-time cache.
    cache: "no-store",
  })
}

/** Never throws. A store that is down must slow a run's bookkeeping, not end
 *  the run: the search money is already spent by the time we write. */
async function quiet<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    console.error(`[supabase] ${what}:`, e)
    return fallback
  }
}

/* --------------------------------------------------------------------- write */

export async function upsertRun(row: RunRow): Promise<void> {
  await quiet(
    "upsertRun",
    async () => {
      const res = await rest("runs", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
      })
      if (res && !res.ok) console.error(`[supabase] upsertRun ${res.status}: ${await res.text()}`)
    },
    undefined,
  )
}

/**
 * Append spans.
 *
 * `ignore-duplicates` rather than merge: (run_id, seq) already identifies a
 * span, and a span never changes after it is emitted. A retried batch is
 * therefore a no-op instead of a rewrite.
 */
export async function appendSpans(runId: string, spans: readonly Span[]): Promise<void> {
  if (!spans.length) return
  await quiet(
    "appendSpans",
    async () => {
      const res = await rest("run_spans", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(spans.map((s) => ({ run_id: runId, seq: s.seq, span: s }))),
      })
      if (res && !res.ok) console.error(`[supabase] appendSpans ${res.status}: ${await res.text()}`)
    },
    undefined,
  )
}

/* ---------------------------------------------------------------------- read */

export async function listRuns(limit = 100): Promise<StoredRun[]> {
  return quiet(
    "listRuns",
    async () => {
      const res = await rest(`runs?select=*&order=started_at.desc&limit=${limit}`)
      if (!res || !res.ok) return []
      return ((await res.json()) as RunRow[]).flatMap((r) => {
        const s = toStored(r)
        return s ? [s] : []
      })
    },
    [],
  )
}

export async function getRunRow(id: string): Promise<StoredRun | null> {
  return quiet(
    "getRunRow",
    async () => {
      const res = await rest(`runs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`)
      if (!res || !res.ok) return null
      const [row] = (await res.json()) as RunRow[]
      return row ? toStored(row) : null
    },
    null,
  )
}

/**
 * Spans past a cursor, for a browser attaching to a run this process is not
 * holding. `after` is exclusive and matches the client's own resume cursor.
 */
export async function getSpans(runId: string, after = -1, limit = 5000): Promise<Span[]> {
  return quiet(
    "getSpans",
    async () => {
      const res = await rest(
        `run_spans?run_id=eq.${encodeURIComponent(runId)}&seq=gt.${after}` +
          `&select=span&order=seq.asc&limit=${limit}`,
      )
      if (!res || !res.ok) return []
      return ((await res.json()) as { span: Span }[]).map((r) => r.span)
    },
    [],
  )
}

/** A row is only a readable run once it has a result. A `running` row is real
 *  and worth listing, but nothing can render a map from it yet. */
function toStored(r: RunRow): StoredRun | null {
  if (!r.result) return null
  return {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    startedAt: Date.parse(r.started_at),
    endedAt: r.ended_at ? Date.parse(r.ended_at) : undefined,
    status: r.status,
    result: r.result,
  }
}
