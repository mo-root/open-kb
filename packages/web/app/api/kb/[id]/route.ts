import { getStoredRun } from "@/lib/runs"
import { viewOf } from "@/lib/kb-from-run"

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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await getStoredRun(id)
  if (!run) return Response.json({ error: "no such knowledge base" }, { status: 404 })
  return Response.json(viewOf(run))
}
