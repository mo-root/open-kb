import { getStoredRun, getRun } from "@/lib/runs"

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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    if (stored) {
      return Response.json({
        status: stored.status,
        domain: stored.domain,
        queries: stored.queries,
        startedAt: stored.startedAt,
        endedAt: stored.endedAt,
        result: stored.result,
      })
    }
    return Response.json({ status: "unknown" }, { status: 404 })
  }

  return Response.json({
    status: run.status,
    domain: run.domain,
    queries: run.queries,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    ...(run.error ? { error: run.error } : {}),
    // The same object the `complete` frame carried, built once inside the run.
    // Assembling a second summary here is how a browser that caught the frame
    // and a browser that asked afterwards end up rendering two different runs.
    ...(run.result ? { result: run.result.report } : {}),
  })
}
