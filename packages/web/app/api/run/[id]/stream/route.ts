import { adapterFor, isNamespace, type Namespace } from "@/lib/stream-adapter"
import { getRun } from "@/lib/runs"
import { guarded, logFault } from "@/lib/api-error"
import * as db from "@/lib/store/supabase"
import type { Span } from "@open-kb/core"

/**
 * Live view of a run, one namespace at a time: ?ns=progress | agent | cost |
 * trace. Omit `ns` for the default stream, which carries results.
 *
 * One JSON object per line, `application/x-ndjson`, which is what the browser's
 * line-splitting reader expects.
 *
 * `startIndex` is what makes a reconnect lossless.
 *
 * The failure this fixes. A serverless response ends at 300s while a run keeps
 * going. The browser saw `done`, stopped reading, and the pipeline sat on one
 * stage for the rest of a run that was working perfectly, the product looked
 * broken while doing exactly what it was asked. The client reconnects and says
 * how many frames it already has, so the next response resumes rather than
 * replaying from zero and double-counting every cost frame.
 *
 * The resume is exact because it is a replay-and-skip, not a seek.
 * `SpanStream.stream()` always hands a new subscriber the whole log from span 1,
 * and the adapter is a pure fold over that log, so re-running it reproduces
 * frame-for-frame what the first connection produced. Counting frames and
 * dropping the first N is therefore identical to having never disconnected —
 * which a raw span offset would not be, since one span yields a frame in some
 * namespaces and nothing in others.
 */

/**
 * Serve a finished or foreign run out of the spans table.
 *
 * Identical framing to the live path so a client cannot tell them apart: same
 * adapter, same `delivered` counting before the skip, same NDJSON.
 */
function replay(req: Request, spans: readonly Span[]): Response {
  const url = new URL(req.url)
  const nsParam = url.searchParams.get("ns")
  if (nsParam !== null && !isNamespace(nsParam)) {
    return Response.json({ error: `unknown namespace "${nsParam}"` }, { status: 400 })
  }
  const toFrame = adapterFor(nsParam ?? "results")
  const parsed = Number(url.searchParams.get("startIndex"))
  const skip = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0

  const encoder = new TextEncoder()
  let delivered = 0
  const lines: string[] = []
  for (const span of spans) {
    const frame = toFrame(span)
    if (frame === null) continue
    delivered += 1
    if (delivered <= skip) continue
    lines.push(`${JSON.stringify(frame)}\n`)
  }
  return new Response(encoder.encode(lines.join("")), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}

export const runtime = "nodejs"
/** Never prerender or cache: the body is the run, live. */
export const dynamic = "force-dynamic"

/**
 * The one route where a fault has two halves, and only one of them can answer.
 *
 * BEFORE THE FIRST BYTE — `await params`, `getRun`, `db.getSpans`, the whole of
 * `replay()` (which builds its entire body in memory before constructing a
 * Response), the `new URL` and `adapterFor` below — nothing has been sent yet,
 * so `guarded` turns a throw there into the same 500-plus-ref every other
 * handler gives. `db.getSpans` is a network call on the path a reconnecting
 * browser takes, so this is not a hypothetical branch.
 *
 * AFTER THE FIRST BYTE, inside the ReadableStream, nothing can. The 200 and the
 * `application/x-ndjson` header left with the first frame; there is no status
 * to change and no body to replace, and a JSON error object appended to an
 * NDJSON stream would only be a frame the client's readers do not recognise.
 * `guarded` cannot even see those: `start()` is a separate async context whose
 * rejection goes to the stream, not to this function, which by then has already
 * returned. So the catch inside `start()` is where that half is handled, and
 * all it can do — all that is left to do — is mint a ref into the log.
 *
 * Buffering the head so that early faults could still become a 500 was
 * considered and rejected: this stream is deliberately silent for minutes at a
 * time between `planned` and `complete`, so holding the first frame back would
 * break the one property the route exists for.
 */
export const GET = guarded(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const run = getRun(id)

  // Not in this process. Before Postgres that was the end of it: a server
  // restart, or a run older than the 20 the registry keeps, left the browser
  // reconnecting to a 404 forever while its map sat finished on disk. The spans
  // are a table now, so replay them and finish.
  //
  // A replay is a snapshot, not a subscription. The client reconnects with its
  // cursor and picks up whatever has landed since, which is what it already
  // does across every other kind of disconnect.
  if (!run) {
    if (!db.configured()) return Response.json({ error: "no such run" }, { status: 404 })
    const stored = await db.getSpans(id)

    // NO SPANS IS NOT NO RUN, and conflating them is what made the app look
    // broken from a browser.
    //
    // This asked the span table whether a run exists. At the start of a run
    // that table is EMPTY — the pump batches at 25 spans or 3 seconds — and
    // the browser opens this stream the instant POST /api/map returns an id,
    // which is well inside that window. So the answer was 404, the client
    // stopped, and a run that went on to work perfectly showed nothing for its
    // entire life. Measured twice on the deployment, on two separate causes;
    // this is the second and last of them.
    //
    // The run row is the existence certificate and the route now asks it
    // directly. A real run with no spans yet gets an open stream carrying
    // nothing, which is the truthful frame: it has started and has not said
    // anything. The client already handles a stream that goes quiet and
    // reconnects with its cursor, which is how it survives every other kind of
    // gap.
    if (!stored.length) {
      const row = await db.getRunRow(id)
      if (!row) return Response.json({ error: "no such run" }, { status: 404 })
    }
    return replay(req, stored)
  }

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
          // next emission, or the run's close, releases it either way.
          if (req.signal.aborted) break
          const frame = toFrame(span)
          if (frame === null) continue
          delivered += 1
          // Counted before the skip, not after: the count is the client's
          // cursor, and a skipped frame still happened.
          if (delivered <= skip) continue
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
        }
      } catch (err) {
        // A closed client aborts the enqueue, and that is the ordinary case:
        // nothing to report, the run is untouched and the next connection
        // replays from `startIndex`. Anything else is a real fault that used to
        // vanish here completely — the stream simply ended, and a short stream
        // is indistinguishable from a quiet one.
        //
        // A ref in the log is the whole of what is available (see the block
        // above the handler). The client is told nothing, because there is no
        // longer any way to tell it anything, and it reconnects regardless.
        //
        // The discriminator races: a client can vanish a moment before its
        // signal is marked aborted, and then a disconnect is logged as a fault.
        // One spurious line is cheaper than the swallowed fault this replaces.
        if (!req.signal.aborted) logFault(err, req)
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
})
