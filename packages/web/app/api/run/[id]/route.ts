import { getRun } from "@/lib/runs"

/**
 * THE RUN'S FINAL ANSWER, WITHOUT HAVING TO CATCH IT LIVE.
 *
 * The result reaches the browser as a `complete` frame on the results stream,
 * so seeing it there depends on a reader being connected at the instant it is
 * written. It frequently is not: the results stream is nearly silent for the
 * minutes between `planned` and `complete`, the client reconnects on every
 * close, and a quiet stretch reads as a string of empty responses.
 *
 * So the run is asked directly. This is also what the client's readers consult
 * before giving up on silence — a quiet stream is what the middle of a sweep
 * looks like, and only the run itself can say whether it is over.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = getRun(id)
  if (!run) return Response.json({ status: "unknown" }, { status: 404 })

  return Response.json({
    status: run.status,
    domain: run.domain,
    queries: run.queries,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    ...(run.error ? { error: run.error } : {}),
    // The SAME object the `complete` frame carried, built once inside the run.
    // Assembling a second summary here is how a browser that caught the frame
    // and a browser that asked afterwards end up rendering two different runs.
    ...(run.result ? { result: run.result.report } : {}),
  })
}
