import { isCompleted, listStoredRuns } from "@/lib/runs"
import { summaryOf } from "@/lib/kb-from-run"
import { guarded } from "@/lib/api-error"

/**
 * Every knowledge base this deployment holds, one per completed run.
 *
 * v1 listed a blob store; this lists `runs/`. The gallery page reads the
 * registry directly (it is a server component), so this route exists for the
 * clients that cannot: anything fetching the list from the browser.
 *
 * ONE PER COMPLETED RUN, and the filter is what keeps that sentence true.
 * `listStoredRuns` returns failed runs now — a run that crashed is a fact worth
 * reading, and /runs is where it is read. It is not a knowledge base: there is
 * no map, no anchor and no entity in it, so a card here would open onto
 * nothing. That was the exact defect `isStoredRun` was tightened to close, and
 * widening the registry must not reopen it one status along.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = guarded(async () => {
  const runs = await listStoredRuns()
  return Response.json({ kbs: runs.filter(isCompleted).map(summaryOf) })
})
