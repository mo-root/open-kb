import { cancelRun } from "@/lib/runs"
import { guarded } from "@/lib/api-error"

/**
 * Stop a run in flight.
 *
 * Until this existed the only way to stop a sweep was to kill the process,
 * which is also the way that discards everything it had paid for. A typo in a
 * domain, or Deep picked by accident, cost a full run either way.
 *
 * POST rather than DELETE: nothing is deleted. The run stops where it is, keeps
 * every host it found, and is written out like any other finished run.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  return cancelRun(id)
    ? Response.json({ cancelled: true })
    : Response.json({ cancelled: false, reason: "not running" }, { status: 409 })
})
