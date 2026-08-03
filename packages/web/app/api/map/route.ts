import { openrouter, createOpenRouter } from "@openrouter/ai-sdk-provider"
import { sweep } from "@open-kb/sweep"
import { createRun, failRun, finishRun } from "@/lib/runs"

/**
 * Start a map. Returns as soon as the run has an id, the sweep itself runs in
 * the background, writing into that run's `SpanStream`, and the browser watches
 * it through `/api/run/{id}/stream`.
 *
 * The response is deliberately not the result. A sweep is three minutes and a
 * request that waits for it is a request that times out, and worse, it is a
 * request whose failure destroys work that had already been paid for.
 */

/** Node, not Edge: the run outlives the request that started it, and the engine
 *  reads credentials off `process.env`. */
export const runtime = "nodejs"

interface Body {
  domain?: string
  queries?: number
}

const MAX_QUERIES = 120

export async function POST(req: Request) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 })
  }

  const domain = normalizeDomain(body.domain)
  if (!domain) {
    return Response.json(
      { error: `"${body.domain ?? ""}" does not name a company — try a domain like resend.com` },
      { status: 400 },
    )
  }

  // A query count is the single biggest lever on the bill, so a bad one is
  // refused here rather than silently coerced: `Number("")` is 0, and a sweep of
  // zero queries returns an empty map that reads as a quiet market.
  const requested = body.queries === undefined ? 40 : Number(body.queries)
  if (!Number.isFinite(requested) || requested < 1 || requested > MAX_QUERIES) {
    return Response.json(
      { error: `queries must be between 1 and ${MAX_QUERIES}` },
      { status: 400 },
    )
  }
  const queries = Math.floor(requested)

  // Checked before a run exists, because a missing key surfaces inside the
  // sweep as a failed model call after the SERP money is already spent.
  const missing = ["BRIGHTDATA_API_TOKEN", "BRIGHTDATA_SERP_ZONE", "BRIGHTDATA_UNLOCKER_ZONE", "OPENROUTER_API_KEY"].filter(
    (k) => !process.env[k],
  )
  if (missing.length) {
    return Response.json(
      { error: `not configured: ${missing.join(", ")} — set them in the repo-root .env` },
      { status: 503 },
    )
  }

  const modelId = process.env.OPENKB_MODEL ?? "google/gemini-3.5-flash"
  const record = createRun(domain, queries)

  // Not awaited. The whole point of the registry is that the run outlives this
  // request; awaiting here would turn a 200-in-a-millisecond into a three-minute
  // hold that a proxy cuts anyway.
  void (async () => {
    try {
      const result = await sweep({
        domain,
        queries,
        spans: record.spans,
        creds: {
          token: process.env.BRIGHTDATA_API_TOKEN!,
          serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
          unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
        },
        model: provider()(modelId),
        modelId,
        runId: record.id,
        signal: record.abort.signal,
        onLog: (line) => console.log(`[${record.id.slice(0, 8)}] ${line}`),
      })
      finishRun(record.id, result)
    } catch (e) {
      // A cancellation is not a crash. The sweep throws "aborted" from its next
      // checkpoint, and everything it had already found is in the span table,
      // so the reader is told the run was stopped rather than that it broke.
      const cancelled = record.abort.signal.aborted
      // Emitted onto the stream as well as recorded, so a browser that is
      // watching sees the outcome rather than a stream that simply stops.
      record.spans.emit({
        runId: record.id,
        agentId: "write",
        parentId: null,
        kind: "remember",
        name: "ui:results",
        argsDigest: JSON.stringify({
          kind: "error",
          message: cancelled
            ? "Stopped. Everything found before you stopped it is kept."
            : e instanceof Error
              ? e.message
              : String(e),
        }),
        ms: 0,
        ok: false,
        usd: 0,
      })
      failRun(record.id, e)
    }
  })()

  return Response.json({ runId: record.id, domain, queries })
}

/** The default `openrouter` export reads OPENROUTER_API_KEY at module scope,
 *  which in a dev server is evaluated before `.env` at the repo root has been
 *  loaded. Constructing it per request reads the key that is actually set. */
function provider() {
  return process.env.OPENROUTER_API_KEY
    ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
    : openrouter
}

/** `https://Resend.com/pricing` → `resend.com`. Returns "" for anything that is
 *  not a hostname, which is what the 400 above is keyed off. */
function normalizeDomain(input: string | undefined): string {
  if (typeof input !== "string") return ""
  let d = input.trim().toLowerCase()
  if (!d) return ""
  d = d.replace(/^[a-z][\w+.-]*:\/\//, "")
  d = d.split(/[/?#]/)[0] ?? ""
  d = d.replace(/^www\./, "")
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : ""
}
