import { getStoredRun } from "@/lib/runs"
import { noteOf } from "@/lib/kb-from-run"

/**
 * One entity, whole — what `NoteView` renders.
 *
 * `?path=` is the node id, which is shaped like a v1 note path
 * ("players/postmarkapp.com.md"). It never touches the filesystem: the run is
 * one JSON object and the path is looked up inside it, so there is no traversal
 * surface here at all.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const path = new URL(req.url).searchParams.get("path")
  if (!path) return Response.json({ error: "path is required" }, { status: 400 })

  const run = await getStoredRun(id)
  if (!run) return Response.json({ error: "no such knowledge base" }, { status: 404 })

  const note = noteOf(run, path)
  if (!note) return Response.json({ error: `nothing at ${path}` }, { status: 404 })
  return Response.json(note)
}
