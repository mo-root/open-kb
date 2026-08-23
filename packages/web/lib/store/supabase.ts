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
  /**
   * What the run cost, in dollars, written at its ending — successful or not.
   *
   * NOT DERIVED FROM `result`, and the difference is the whole point of the
   * column. A run that failed at minute three has no result and still bought
   * its searches, so `result->stats->usd` would count a bad afternoon as free.
   * This is `SpanStream.totalUsd()`, which counts model AND search AND fetch,
   * and it is what lib/spend-limits.ts adds up to answer "what has this
   * deployment spent today".
   */
  usd?: number
  /**
   * Which visitor started it, as a salted hash — never an address. Written at
   * the start, so a run counts against its visitor from the moment it exists
   * rather than from the moment it ends. See `visitorOf` in lib/spend-limits.ts
   * for why it is a hash and what it is a hash OF.
   */
  visitor?: string | null
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

/**
 * How many runs this deployment STARTED since an instant. `null` means the
 * question could not be answered, which is not the same as zero.
 *
 * The distinction is the whole reason for the return type. `lib/public-runs.ts`
 * meters a public deployment against this number, and a store that is down
 * answering "0 runs today" would read as a full allowance and hand a stranger's
 * script the account. Every other reader in this file falls back to an empty
 * list because an empty gallery is a survivable lie; this one is the only
 * caller whose fallback would spend money, so it gets an unanswerable answer
 * and refuses on it.
 *
 * Counts the `runs` table itself rather than deriving from `listRuns`, and the
 * difference is not efficiency. `listRuns` drops running rows and caps at a
 * limit; an allowance has to count a run the moment it starts — before it can
 * possibly have finished — and has to count the ones that failed, because a run
 * that died at minute three already bought its searches.
 *
 * `select=id&limit=1` with `count=exact` rather than a bare `HEAD`: PostgREST
 * puts the total in `Content-Range` either way, and asking for one row is the
 * spelling that behaves the same across versions. It transfers one id.
 */
export async function countRunsSince(sinceIso: string): Promise<number | null> {
  return quiet(
    "countRunsSince",
    async () => {
      const res = await rest(
        `runs?select=id&started_at=gte.${encodeURIComponent(sinceIso)}&limit=1`,
        { headers: { Prefer: "count=exact" } },
      )
      if (!res || !res.ok) return null
      // `0-0/137`, or `*/0` when nothing matched. The total is after the slash.
      const total = res.headers.get("content-range")?.split("/")[1]
      const n = Number(total)
      return Number.isFinite(n) && n >= 0 ? n : null
    },
    null,
  )
}

/** One row as the budget reads it: when it started, whether it is still going,
 *  what it cost, and whose it was. Nothing else — a day's worth of `select=*`
 *  would drag every finished map's whole `result` blob across the wire to
 *  answer an arithmetic question.
 *
 *  Kept as a type though its Supabase reader is gone: `lib/spend-limits.ts`'s
 *  in-memory fallback (`ledgerSince`, for a deployment with no store
 *  configured) still returns this shape, so `count()` there can stay one
 *  function for both paths. */
export interface UsageRow {
  started_at: string
  status: RunStatus
  usd: number
  visitor: string | null
}

/** Which limit stopped a claim, and the three counts behind the decision. The
 *  sentences are written in lib/spend-limits.ts; this is the arithmetic. */
export interface ClaimCounts {
  byVisitor: number
  spentUsd: number
  inFlight: number
}

export type ClaimResult =
  | ({ kind: "claimed" } & ClaimCounts)
  | ({ kind: "refused"; limit: "visitor" | "day" | "at-once" } & ClaimCounts)
  | { kind: "unconfigured" }
  | { kind: "unavailable"; why: string }

/**
 * Ask Postgres whether a run may start, and have it write the row if so.
 *
 * ONE ROUND TRIP, because the decision and the record are the same act. The
 * shape this replaces — a since-select-all reader, decide in TypeScript,
 * insert later — was correct for every request taken alone and worthless
 * against a burst: fifty requests fired together all read the same empty
 * day. That reader is gone now (nothing called it once this landed);
 * `claim_run` in scripts/supabase-schema.sql takes a transaction-scoped
 * advisory lock, counts, and inserts instead, so the fifty-first sees the
 * first fifty.
 *
 * NOT `quiet`: the fallback here would SPEND. A store that is down, a
 * migration that has not been run, a function PostgREST has not noticed yet —
 * every one of those has to come back as "could not decide" and be refused,
 * never as "nothing today".
 */
export async function claimRun(args: {
  id: string
  domain: string
  queries: number
  startedAt: string
  visitor: string | null
  since: string
  windowMs: number
  runCapUsd: number | null
  dayCapUsd: number | null
  perVisitorPerDay: number | null
  atOnce: number | null
}): Promise<ClaimResult> {
  if (!configured()) return { kind: "unconfigured" }
  try {
    const res = await rest("rpc/claim_run", {
      method: "POST",
      body: JSON.stringify({
        p_id: args.id,
        p_domain: args.domain,
        p_queries: args.queries,
        p_started_at: args.startedAt,
        p_visitor: args.visitor,
        p_since: args.since,
        p_window_ms: Math.round(args.windowMs),
        p_run_cap: args.runCapUsd,
        p_day_cap: args.dayCapUsd,
        p_per_visitor: args.perVisitorPerDay,
        p_at_once: args.atOnce,
      }),
    })
    if (!res) return { kind: "unconfigured" }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error(`[supabase] claimRun ${res.status}: ${detail}`)
      // 404 is the one an operator can act on directly: PostgREST answers it
      // for a function it does not know, which is a deployment upgraded without
      // re-running the schema. Named as such rather than as "the store answered
      // 404", which reads like an outage and is not.
      return {
        kind: "unavailable",
        why:
          res.status === 404
            ? "this deployment has no claim_run function — re-run scripts/supabase-schema.sql"
            : `the store answered ${res.status}`,
      }
    }
    const body = (await res.json()) as Record<string, unknown> | null
    if (!body || typeof body.ok !== "boolean") {
      return { kind: "unavailable", why: "the store answered something the budget could not read" }
    }
    const counts: ClaimCounts = {
      byVisitor: Number(body.by_visitor ?? 0) || 0,
      spentUsd: Number(body.spent_usd ?? 0) || 0,
      inFlight: Number(body.in_flight ?? 0) || 0,
    }
    if (body.ok) return { kind: "claimed", ...counts }
    const which = body.limit
    if (which !== "visitor" && which !== "day" && which !== "at-once") {
      return { kind: "unavailable", why: "the store refused a run without saying which limit" }
    }
    return { kind: "refused", limit: which, ...counts }
  } catch (e) {
    console.error("[supabase] claimRun:", e)
    return { kind: "unavailable", why: "the store could not be reached" }
  }
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
