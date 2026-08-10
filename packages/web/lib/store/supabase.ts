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
        // A run still going is not a map anyone can browse, so the LISTING
        // drops it. That is a gallery rule, not a serialisation one, and it
        // lives here rather than in `toStored` because `getRunRow` needs the
        // opposite answer: the stream route asks "is this id real?" about a
        // run that is, by definition, still running. One function answering
        // both questions is how a browser ended up being told "no such run"
        // about a run it had just started.
        if (r.status === "running") return []
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

/* ------------------------------------------------- the two halves of `error` */

/**
 * The `error` column is one text field with two audiences in it, and this is
 * the joint.
 *
 * lib/runs.ts bounds what a browser may read — a sweep's throw is an OpenRouter
 * or Bright Data error and can carry a request id or a fragment of a key, so
 * `faultNotice` replaces it with a fixed sentence and a grep-able ref. The
 * CAUSE still has to be kept: stderr holds it for as long as the host keeps
 * logs, which on a serverless box is hours, and the row outlives that by years.
 * So both go in the column, the notice first.
 *
 * That was safe while nothing read the column back. It is not any more: a
 * failed row is now a readable run (see `toStored`), and `GET /api/run/[id]`
 * puts `error` in a production body. So the split stops being a convention in a
 * comment and becomes two functions in the module that owns the column —
 * written here rather than in lib/runs.ts because the format IS the column's,
 * and because runs.ts already imports this file at run time while the reverse
 * would close the cycle.
 *
 * The separator is matched at its FIRST occurrence. A notice that somehow
 * contained one would be truncated at its own copy, which errs towards saying
 * less to the browser — the only direction this may err in.
 */
const CAUSE = "\ncause: "

/** What `failRun` writes: the reader's sentence, then the operator's cause. */
export function errorColumn(notice: string, cause: unknown): string {
  const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
  return `${notice}${CAUSE}${detail}`
}

/** The half of that column a browser may be shown. A column written before the
 *  cause was appended, or by anything else, is a notice entire. */
function noticeIn(column: string): string {
  const at = column.indexOf(CAUSE)
  return at === -1 ? column : column.slice(0, at)
}

/**
 * A row as a run this deployment can read, or null when there is nothing to
 * read yet.
 *
 * A `running` row is real and worth having — the span table is filling up
 * behind it — but no surface can render a map or an outcome from it, so it is
 * still dropped.
 *
 * A FAILED ROW IS KEPT, and that is the fix. The rule used to be "no result, no
 * run", and `failRun` never writes a result, so every crashed, cancelled and
 * over-limit run was unreadable from anywhere except the one instance that had
 * run it. Concretely: the browser's `runIsOver()` polls `GET /api/run/[id]`,
 * a 404 there means "cannot tell, keep reading", and a run that died on another
 * instance therefore left the page that started it spinning for ever — the same
 * failure `getStoredRun`'s memory-then-disk fallback was written to end, one
 * status along. "This run failed, here is why" is a worse answer than a map and
 * a much better one than "no such run".
 *
 * The result stays absent rather than being filled with an empty `SweepResult`:
 * a failed run measured no hosts and no cost, and a zeroed map would render as
 * a market this deployment looked at and found nothing in. `StoredRun.result`
 * is optional for exactly this row, and `isCompleted` in lib/runs.ts is how
 * every KB surface keeps its hands off it.
 */
function toStored(r: RunRow): StoredRun | null {
  // A RUNNING row is a real run and must survive this, which is the whole
  // reason a browser can watch a run it did not start.
  //
  // Measured on the deployment: POST /api/map returns a run id, the browser
  // opens /api/run/<id>/stream, and that request is a DIFFERENT invocation —
  // often a different instance — whose in-process registry has never heard of
  // the run. It falls through to Postgres, and Postgres said null, because
  // this function dropped every row without a result. The browser got
  // `{"error":"no such run"}` and zero frames for the entire run while the
  // engine worked perfectly behind it. Three minutes of blank screen, then a
  // finished map appearing in the gallery with no explanation.
  //
  // `running` was the state this forgot. `failed` was added when a crashed run
  // turned out to be invisible the same way; this is the same bug one state
  // earlier, and the reason to state both here is that the next status anyone
  // adds will need the same thought.
  if (!r.result && r.status !== "failed" && r.status !== "running") return null
  return {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    startedAt: Date.parse(r.started_at),
    endedAt: r.ended_at ? Date.parse(r.ended_at) : undefined,
    status: r.status,
    ...(r.result ? { result: r.result } : {}),
    ...(r.error ? { error: noticeIn(r.error) } : {}),
  }
}
