import { getStoredRun } from "@/lib/runs"
import { exportKbFiles, type ExportRunLike } from "@open-kb/core"
import { zipOf } from "@/lib/zip"

/**
 * The export button's other half: the whole knowledge base as a zip of
 * markdown — core's exportKbFiles (wikilinks, receipts, the honesty rules in
 * AGENTS.md) through the dependency-free store-zip. What the reader downloads
 * is exactly what `pnpm run export` writes; one builder, two doors.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await getStoredRun(id)
  if (!run) return Response.json({ error: "no such knowledge base" }, { status: 404 })
  const files = exportKbFiles(run.result as unknown as ExportRunLike)
  const zip = zipOf(files)
  const anchor = ((run.result as { anchor?: string }).anchor ?? "map").replace(/\W+/g, "-")
  return new Response(new Uint8Array(zip).buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="kb-${anchor}.zip"`,
    },
  })
}
