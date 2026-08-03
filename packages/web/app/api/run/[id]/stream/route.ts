import { adapterFor, isNamespace, type Namespace } from "@/lib/stream-adapter"
import { getRun } from "@/lib/runs"

/**
 * Live view of a run, one namespace at a time: ?ns=progress | agent | cost |
 * trace. Omit `ns` for the default stream, which carries results.
 *
 * One JSON object per line, `application/x-ndjson`, which is what the browser's
 * line-splitting reader expects.
 *
 * `startIndex` is what makes a reconnect lossless.
 *
 * THE FAILURE THIS FIXES. A serverless response ends at 300s while a run keeps
 * going. The browser saw `done`, stopped reading, and the pipeline sat on one
 * stage for the rest of a run that was working perfectly — the product looked
 * broken while doing exactly what it was asked. The client reconnects and says
 * how many frames it already has, so the next response resumes rather than
 * replaying from zero and double-counting every cost frame.
 *
 * The resume is exact because it is a REPLAY-AND-SKIP, not a seek.
 * `SpanStream.stream()` always hands a new subscriber the whole log from span 1,
 * and the adapter is a pure fold over that log, so re-running it reproduces
 * frame-for-frame what the first connection produced. Counting frames and
 * dropping the first N is therefore identical to having never disconnected —
 * which a raw span offset would NOT be, since one span yields a frame in some
 * namespaces and nothing in others.
 */

export const runtime = "nodejs"
/** Never prerender or cache: the body is the run, live. */
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = getRun(id)
  if (!run) return Response.json({ error: "no such run" }, { status: 404 })

  const url = new URL(req.url)
  const nsParam = url.searchParams.get("ns")
  if (nsParam !== null && !isNamespace(nsParam)) {
    return Response.json({ error: `unknown namespace "${nsParam}"` }, { status: 400 })
  }
  const ns: Namespace = nsParam ?? "results"

  const parsed = Number(url.searchParams.get("startIndex"))
  const skip = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0

  const toFrame = adapterFor(ns)
  const encoder = new TextEncoder()
  let delivered = 0

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const span of run.spans.stream()) {
          // A disconnected client must stop being a subscriber. Checked on each
          // span rather than on an abort listener because the generator can be
          // parked between spans and there is nothing to interrupt there; the
          // next emission — or the run's close — releases it either way.
          if (req.signal.aborted) break
          const frame = toFrame(span)
          if (frame === null) continue
          delivered += 1
          // Counted before the skip, not after: the count IS the client's
          // cursor, and a skipped frame still happened.
          if (delivered <= skip) continue
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
        }
      } catch {
        // A closed client aborts the enqueue. Nothing to report — the run is
        // untouched and the next connection replays from `startIndex`.
      } finally {
        controller.close()
      }
    },
    cancel() {
      // The `for await` above unsubscribes on its own `finally` when the
      // generator is dropped, so there is nothing to release here. Declaring
      // cancel keeps a client disconnect from surfacing as an unhandled error.
    },
  })

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store, no-transform",
      // Without this a dev proxy or a CDN buffers the whole response and the
      // "live" stream arrives all at once when the run ends.
      "X-Accel-Buffering": "no",
    },
  })
}
