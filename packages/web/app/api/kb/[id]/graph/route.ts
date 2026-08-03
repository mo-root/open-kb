import { getStoredRun } from "@/lib/runs"
import { graphOf } from "@/lib/kb-from-run"

/**
 * The map, as `GraphCanvas` eats it: `GraphView` from lib/viewTypes.ts.
 *
 * v1 built this from the `[[wikilinks]]` between markdown notes. There are no
 * notes and no wikilinks here, the graph is derived from the run's classified
 * entities (lib/kb-from-run.ts `graphOf`), which is also where the reasoning
 * behind the kind→colour collapse and the star topology is written down.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await getStoredRun(id)
  if (!run) return Response.json({ error: "no such knowledge base" }, { status: 404 })
  return Response.json(graphOf(run))
}
