import { findKb } from "@/lib/kb-lookup"
import { exportKbFiles, type ExportRunLike } from "@open-kb/core"
import { zipOf } from "@/lib/zip"
import { guarded } from "@/lib/api-error"

/**
 * The export button's other half: the whole knowledge base as a zip of
 * markdown — core's exportKbFiles (wikilinks, receipts, the honesty rules in
 * AGENTS.md) through the dependency-free store-zip. What the reader downloads
 * is exactly what `pnpm run export` writes; one builder, two doors.
 */

/**
 * A zip route under a JSON fault wrapper, which sounds like a mismatch and is
 * not.
 *
 * The question worth asking of any non-JSON route is whether a fault can arrive
 * after the headers, because then there is no status left to change. Here it
 * cannot: `zipOf` returns a finished `Uint8Array`, the whole archive is built in
 * memory, and only then is `new Response(...)` constructed. Every throw on this
 * path — `getStoredRun` on a bad OPENKB_RUNS_DIR, `exportKbFiles` on a
 * malformed result, `zipOf` itself — happens before a single byte or header is
 * sent, so a 500 with the JSON body is not merely possible, it is the correct
 * answer.
 *
 * What changes for the reader: the download link in KbBrowser.tsx is a plain
 * `<a href>`, so a browser that hits this now shows `{"error":…,"ref":…}` in a
 * tab rather than saving a zero-byte file called `kb-<anchor>.zip`. A visible
 * refusal carrying a ref beats a corrupt download that looks like it worked.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = guarded(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const found = await findKb(id)
  if ("refusal" in found) return found.refusal
  const { result } = found.run
  const files = exportKbFiles(result as unknown as ExportRunLike)
  const zip = zipOf(files)
  const anchor = (result.anchor || "map").replace(/\W+/g, "-")
  return new Response(new Uint8Array(zip).buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="kb-${anchor}.zip"`,
    },
  })
})
