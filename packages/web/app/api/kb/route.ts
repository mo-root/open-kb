import { listStoredRuns } from "@/lib/runs"
import { summaryOf } from "@/lib/kb-from-run"

/**
 * Every knowledge base this deployment holds, one per completed run.
 *
 * v1 listed a blob store; this lists `runs/`. The gallery page reads the
 * registry directly (it is a server component), so this route exists for the
 * clients that cannot: anything fetching the list from the browser.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const runs = await listStoredRuns()
  return Response.json({ kbs: runs.map(summaryOf) })
}
