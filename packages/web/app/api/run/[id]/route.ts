import { getStoredRun, getRun, type RunRecord, type StoredRun } from "@/lib/runs"
import { guarded } from "@/lib/api-error"

/**
 * The run's final answer, without having to catch it live.
 *
 * The result reaches the browser as a `complete` frame on the results stream,
 * so seeing it there depends on a reader being connected at the instant it is
 * written. It frequently is not: the results stream is nearly silent for the
 * minutes between `planned` and `complete`, the client reconnects on every
 * close, and a quiet stretch reads as a string of empty responses.
 *
 * So the run is asked directly. This is also what the client's readers consult
 * before giving up on silence, a quiet stream is what the middle of a sweep
 * looks like, and only the run itself can say whether it is over.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const run = getRun(id)

  // Memory first, then disk, the registry is per-process and holds only the
  // last 20 finished runs, so a restart or a busy session makes a run that
  // completed and persisted look like a run that never existed.
  //
  // That gap was not cosmetic. This endpoint is what the client consults to
  // decide whether silence means "over" or "still working", and it treats a
  // failed lookup as "cannot tell, keep reading". So a finished map, already
  // on disk, already listed in the gallery, one click away, left the page that
  // built it spinning a live indicator forever with its Map button disabled.
  // The obvious response to that is to run the same map again and pay twice.
  if (!run) {
    const stored = await getStoredRun(id)
    // A failed run reaches here with no result and reads as one — `status:
    // "failed"` and the sentence. That used to be a 404, because
    // lib/store/supabase.ts dropped every row without a result, and a 404 is
    // what the client reads as "cannot tell, keep reading": a run that died on
    // another instance left the page that started it spinning for ever.
    if (stored) return body(stored)
    return Response.json({ status: "unknown" }, { status: 404 })
  }

  return body(run)
})

/**
 * The one answer, whichever half of the registry it came from.
 *
 * THE TWO BRANCHES HAD DRIFTED, and in both directions at once. The live branch
 * returned `run.result.report` — the run's own summary — while the stored
 * branch two lines below returned the entire `SweepResult`, and neither was
 * written down as a decision. That cost two things:
 *
 *   THE CLIENT COULD NOT READ IT. BuildWorkflow's fallback poll does
 *   `setResult(body.result)` and `ResultPanel` renders `r.kept`, `r.kinds`,
 *   `r.usd` — fields of `report`. A `SweepResult` has none of them at the top
 *   level, so `body.result.kept` was `undefined` and the stored branch had been
 *   quietly serving a shape nobody reads: a run recovered from disk or Postgres
 *   drew an empty summary card.
 *
 *   AND IT WAS TOO BIG TO SEND. Measured on the 71 artifacts in `runs/`, as
 *   `Response.json` would serialise them (no indentation): the vercel.com sweep
 *   is a 4.77MB `SweepResult` and stripe.com 4.13MB, against a 4.5MB response
 *   cap on the target host — so the largest map in the corpus answered 413 and
 *   the next one down was 8% short of it. Their `report`s are 30.4KB and
 *   12.8KB; the largest report in the whole corpus is 120.3KB. The summary is
 *   what the reader wants and it is three orders of magnitude smaller than what
 *   the run is. The map itself has its own route — `/api/kb/[id]` and
 *   `/api/kb/[id]/graph`, which return derived views rather than the raw run.
 *
 * So one function builds both, and a future edit cannot move one branch without
 * the other.
 */
function body(run: StoredRun | RunRecord): Response {
  return Response.json({
    status: run.status,
    domain: run.domain,
    queries: run.queries,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    // Bounded upstream, and it has to be: whatever the sweep threw is an Error
    // in `failRun` and a bare string by the time it is here, with nothing left
    // to say whether the app wrote it. In memory that bounding is `failRun`'s
    // `faultNotice`; out of Postgres it is `toStored` keeping the notice and
    // dropping the cause. lib/runs.ts holds the reasoning; this line is a
    // production body and must stay a pass-through of something already safe.
    ...(run.error ? { error: run.error } : {}),
    // The same object the `complete` frame carried, built once inside the run.
    // Assembling a second summary here is how a browser that caught the frame
    // and a browser that asked afterwards end up rendering two different runs.
    ...(run.result ? { result: run.result.report } : {}),
  })
}
