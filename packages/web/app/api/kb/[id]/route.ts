import { findKb } from "@/lib/kb-lookup"
import { viewOf } from "@/lib/kb-from-run"
import { guarded } from "@/lib/api-error"

/**
 * One knowledge base's envelope: manifest, per-type counts, and every entity as
 * a `NoteRef`. This is what `KbOverview` fetches on mount.
 *
 * port NOTE. v1's dashboard made a second request here —
 * `/api/kb/<slug>/note?path=ecosystem.md`, and re-parsed a markdown table out
 * of the note body to recover "players by kind". That table was written by the
 * build and read back by a regex, which is why the panel silently emptied the
 * day the note's format changed. The tallies ride in this envelope now
 * (`kinds`, `relations`), counted straight off the run, so there is no format
 * between the count and the reader.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const found = await findKb(id)
  if ("refusal" in found) return found.refusal
  return Response.json(viewOf(found.run))
})
