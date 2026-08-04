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

/**
 * What this deployment may spend, in total, ever.
 *
 * Auth decides WHO can start a run. This decides HOW MUCH, and the two are
 * independent: a password shared with ten people is ten people who can each
 * run two hundred maps against the same account.
 *
 * Read from the provider rather than counted here, because a counter in this
 * process resets on every restart and forgets every run started by another
 * instance. The provider's own usage figure is the only number that is true
 * across both.
 */
/**
 * Read per request, NEVER at module scope.
 *
 * Next inlines `process.env.X` at build time for any statically analysable
 * reference, so `const CEILING = Number(process.env.OPENKB_CEILING_USD ?? 0)`
 * became `const CEILING = 0` in the bundle, `if (CEILING > 0)` became `if
 * (false)`, and the whole guard was tree-shaken out. The deployment reported
 * itself protected and had no ceiling in it at all.
 *
 * A function body defers the read to run time, which is when the host actually
 * sets the variable.
 */
function ceilingUsd(): number {
  return Number(process.env.OPENKB_CEILING_USD ?? 0)
}

async function spentSoFar(): Promise<number | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    const { data } = (await res.json()) as { data: { usage: number } }
    return data.usage
  } catch {
    return null
  }
}

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
  //
  // Undefined is not a bad value, it is the normal one now: BuildWorkflow sends
  // no `queries` at all, and an unset override lets the sweep deal every
  // product its own opening hand instead of racing every product for a share
  // of a fixed 40. Only an explicit override still needs a bound.
  const requested = body.queries === undefined ? undefined : Number(body.queries)
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 1 || requested > MAX_QUERIES)) {
    return Response.json(
      { error: `queries must be between 1 and ${MAX_QUERIES}` },
      { status: 400 },
    )
  }
  const queries = requested === undefined ? undefined : Math.floor(requested)

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

  // Checked before a run exists, so a refused request costs nothing. A null
  // reading means the provider did not answer: that is not a licence to spend,
  // so it refuses too. Failing closed on the one guard that protects the
  // balance is the only defensible direction.
  const ceiling = ceilingUsd()
  if (ceiling > 0) {
    const spent = await spentSoFar()
    if (spent === null) {
      return Response.json(
        { error: "cannot reach the model provider to check the spend ceiling, so not starting a run" },
        { status: 503 },
      )
    }
    const base = Number(process.env.OPENKB_CEILING_BASE_USD ?? 0)
    if (spent - base >= ceiling) {
      return Response.json(
        {
          error: `this deployment has spent its $${ceiling} ceiling. Nothing is broken; the limit is deliberate.`,
        },
        { status: 429 },
      )
    }
  }

  const modelId = process.env.OPENKB_MODEL ?? "google/gemini-3.5-flash"
  // `createRun` still records a definite number — its `queries` column is a
  // bookkeeping field a run's whole history reads, not the sweep's own input.
  // 0 means "no override was requested", the same convention `ceilingUsd()`
  // above uses for "no ceiling", rather than reintroducing the 40 default.
  const record = createRun(domain, queries ?? 0)

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
        // The same figure the guard above checked at request time. 0 means
        // unset (see `ceilingUsd()`'s own convention), which is honestly "no
        // ceiling" rather than a ceiling of zero dollars.
        ceilingUsd: ceiling > 0 ? ceiling : null,
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
