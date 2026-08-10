import { findKb } from "@/lib/kb-lookup"
import { graphOf } from "@/lib/kb-from-run"
import { guarded } from "@/lib/api-error"

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

export const GET = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const found = await findKb(id)
  if ("refusal" in found) return found.refusal
  return Response.json(graphOf(found.run))
})
