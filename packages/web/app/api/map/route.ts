import { after } from "next/server"
import { openrouter, createOpenRouter } from "@openrouter/ai-sdk-provider"
import { sweep } from "@open-kb/sweep"
import { queriesThatFit, runSeconds } from "@open-kb/core"
import { priceForModel } from "@open-kb/providers"
import { normalizeDomain } from "@/lib/anchor"
import { createRun, failRun, finishRun } from "@/lib/runs"
import { guarded } from "@/lib/api-error"
import { DEMO_REFUSAL, DEMO_REPO, isDemo } from "@/lib/demo"

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

/**
 * How long the host lets this invocation live, in seconds — the response AND
 * the `after()` work below, which share one budget.
 *
 * WHY 800 AND NOT 1800. 800 is what Vercel's Pro plan gives generally
 * available, with no switch to find and nothing to opt into; the plan tables
 * put Hobby at 300 hard and Pro/Enterprise at 800. 1800 exists as an extended
 * limit, but it is a beta that has to be turned on per function, and this
 * number is read at BUILD time — a value the account cannot honour is a build
 * error, not a slow run. So the default is the one that works on the plan the
 * owner is being asked to buy, and 1800 is a deliberate edit after the beta is
 * enabled, documented in DEPLOY.md rather than assumed here.
 *
 * ON HOBBY THIS MUST BECOME 300. Vercel rejects a `maxDuration` above the
 * plan's ceiling at build time, so a Hobby deployment of this file as written
 * does not deploy at all. That is the honest failure — louder than a run that
 * is killed at 300 seconds having reported nothing.
 *
 * Exported for the platform, and read below by the watchdog, so the deadline
 * and the limit cannot drift apart: there is one number and both use it.
 */
/**
 * A LITERAL, and 300 rather than 800. Both halves were measured the hard way.
 *
 * It cannot be an expression. `Number(process.env.OPENKB_MAX_DURATION ?? 300)`
 * builds fine and then fails collection with "Invalid segment configuration
 * export detected" — Next requires this to be statically analysable, so the
 * plan's ceiling cannot be a deploy-time variable however much it wants to be.
 *
 * 300 is the only value every plan accepts, and a hardcoded 800 does not deploy
 * AT ALL on Hobby: "Serverless Functions must have a maxDuration between 1 and
 * 300 for plan hobby", after a clean 51-second build. Defaulting to the value
 * that always works means a clone deploys anywhere; raising it is then a
 * deliberate act by someone who knows the plan they are on.
 *
 * ON PRO, RAISE THIS TO 800. Measured on runs/, 300s fits about half of the
 * current-shape sweeps and 800s about three fifths — see DEPLOY.md. For 1800
 * the extended limit is an opt-in beta enabled per function in project
 * settings; turn it on there first or the deploy is rejected the same way.
 */
export const maxDuration = 300

/**
 * How much of the budget is reserved for ending the run properly.
 *
 * THIS MARGIN IS THE WHOLE POINT OF THE WATCHDOG. Being killed at the limit and
 * stopping just before it are only different if the "just before" leaves enough
 * time to write the ending down — `failRun` closes the span stream, emits the
 * final `ui:results` frame the browser is waiting on, and issues the Supabase
 * upsert that records the run as failed. A margin too small turns a clean
 * failure back into a vanished one, at greater expense, because the run also
 * stopped early.
 *
 * 30 seconds, made of three things rather than picked: the terminal write is a
 * round trip to Postgres (retried), the sweep needs to reach its next abort
 * checkpoint before it stops spending, and the invocation's true start is
 * EARLIER than the timestamp taken below — cold start, request routing and body
 * parse all happen before the handler runs, and the platform is counting from
 * the earlier instant. That last one is the reason this is not five seconds: an
 * error in that direction is unrecoverable, and every second of the margin only
 * costs a run that was going to be killed anyway.
 */
const DEADLINE_MARGIN_S = 30

/**
 * The clock this run actually has: the host's limit, less the margin the
 * watchdog below already reserves for writing the ending down.
 *
 * One expression, used three times — the budget, the deadline handed to the
 * engine, and the timer that ends the invocation — so the run cannot be sized
 * against one number and stopped against another.
 */
const CLOCK_S = maxDuration - DEADLINE_MARGIN_S

/**
 * HOW BIG A RUN THIS DEPLOYMENT CAN FINISH, in queries.
 *
 * THE BUG THIS IS. This route passed no query budget at all, so the engine
 * dealt its own hand: every product an opening hand, widen while the yield
 * holds, stop on the spend ceiling. That is right on a terminal, where there is
 * no clock. On one measured Vercel run (clerk.com, run 1de8e96c, 481 spans) it
 * bought 132 SERP searches — three minutes of pure buying — and the watchdog
 * stopped it at 270s having just STARTED the phase that turns hosts into a map.
 * $0.7099 spent, no map produced, and nothing about it looked like a failure
 * from the inside. A deliberately narrower map that COMPLETES beats a wide one
 * that is killed, and it is not close: the killed one charged for everything it
 * bought and delivered none of it.
 *
 * THE ARITHMETIC, and every coefficient in it is measured — the derivation and
 * its sources are in `@open-kb/core`'s clock.ts, quoted here in summary:
 *
 *     fixed phases (understand + plan)                60s
 *     one query's search, at a 20-wide pool           1.4s
 *     hosts one query drags into rank                 13
 *     one host judged, at the rank pool's 8           0.63s
 *     tail: link batches, report, durable write       30s
 *
 *     per query = 1.4 + 13 × 0.63           = 9.6s, of which 85% is rank
 *     budget    = (270 − 60 − 30) / 9.6     = 18 queries
 *
 * RANK IS THE LONG POLE AND HOSTS ARE ITS UNIT, which is why a query budget is
 * really a host budget wearing a disguise: 18 queries is about 234 hosts, and
 * 234 hosts is 147s of the 180s this host has left after the phases that do not
 * scale. The same arithmetic run backwards says the killed 132-query run needed
 * roughly 23 minutes. It was given four and a half.
 *
 * A LITERAL WOULD HAVE BEEN WRONG. `maxDuration` is a build-time literal Next
 * requires to be statically analysable (see its comment), and it is edited per
 * plan — 300 on Hobby, 800 on Pro. Deriving the budget from it means raising
 * the limit raises the map: 800 buys 70 queries, 1800 buys 175. A hardcoded 18
 * would have quietly capped a Pro deployment at the Hobby map.
 */
const QUERY_BUDGET = queriesThatFit(CLOCK_S)

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

/**
 * Wrapped for the UNHANDLED path only, and nothing below moves.
 *
 * Every refusal in this handler — 400 for a non-JSON body, 400 for a domain
 * that names no company, 400 for an out-of-range query count, 503 for missing
 * credentials, 503 for an unreachable provider, 429 for the spend ceiling — is
 * a `return`, not a throw. `guarded` never sees a `return`, so all six keep
 * their exact status and their exact sentence. They are the answer, not a
 * fault.
 *
 * What it does catch is the path that had no answer at all: `createRun` and the
 * `Response.json` after it. This is the endpoint that spends money, so it is
 * the worst one to have answering a reader with zero bytes and no token.
 *
 * It cannot 500 a run that already started. Everything that can throw is at or
 * before `createRun`; if `createRun` throws, no run exists, and the background
 * IIFE below has its own catch, which reaches `failRun` rather than this
 * wrapper.
 */
export const POST = guarded(async (req: Request) => {
  /**
   * The first instant this app can observe, and the one the watchdog counts
   * from. Taken before any awaited work — a slow spend-ceiling check is time the
   * platform's clock is already spending, so measuring from after it would hand
   * the run a budget the host never agreed to.
   */
  const startedAt = Date.now()

  /**
   * The read-only demo, refused first — before the body is even parsed.
   *
   * FIRST, and the position is the feature. Every other refusal below is about
   * the REQUEST: this domain names no company, that query count is out of
   * range, these credentials are missing. Demo mode is about the DEPLOYMENT,
   * and it is true before the request is read, so validating a body this
   * handler will never act on only buys the caller a more specific complaint
   * about an input that was never the problem. It also keeps the guard
   * unconditional: there is no ordering of bad input that reaches `createRun`
   * past this line.
   *
   * 403, not 500 and not 503. Nothing failed — the server understood the
   * request perfectly and is configured to refuse it, which is what 403 means.
   * 503 would say "try again later" about a deployment that will answer the
   * same way forever, and `guarded` never sees this at all, because a refusal
   * is a `return` rather than a throw and therefore keeps its status, its
   * sentence, and its silence in the log.
   *
   * `demo: true` rides alongside the sentence so a client can branch on the
   * fact rather than on the prose. BuildWorkflow does not need it — it is told
   * at render time by the server component and never sends this request — but
   * anything else pointed at this endpoint deserves a machine-readable answer,
   * and matching on an English sentence is how a caller breaks on a reword.
   */
  if (isDemo()) {
    return Response.json(
      { error: DEMO_REFUSAL, demo: true, repo: DEMO_REPO },
      { status: 403 },
    )
  }

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

  const modelId = process.env.OPENKB_MODEL ?? "deepseek/deepseek-v4-flash"
  // `createRun` still records a definite number — its `queries` column is a
  // bookkeeping field a run's whole history reads, not the sweep's own input.
  // 0 means "no override was requested", the same convention `ceilingUsd()`
  // above uses for "no ceiling", rather than reintroducing the 40 default.
  const record = createRun(domain, queries ?? 0)

  // Not awaited by the RESPONSE. The whole point of the registry is that the run
  // outlives this request; awaiting here would turn a 200-in-a-millisecond into
  // a three-minute hold that a proxy cuts anyway.
  //
  // Awaited by the HOST, which is a different thing and the one that was
  // missing. A bare `void (async () => …)()` is a promise nobody holds: on a box
  // that runs until you stop it, the run finishes because the process is still
  // there, and that is the only reason it finishes. Under a request-scoped
  // runtime the instance is free to freeze the moment the handler's work is
  // done, and "done" is decided by what the runtime was told about. `after`
  // is how it is told — the task below is part of this invocation until it
  // resolves, which is why every write inside it is now awaited all the way
  // down (see `finishRun` and `settle` in lib/runs.ts). Resolving early and
  // resolving before the result row lands are the same event here, and the run
  // that gets thrown away is one that already spent the money.
  const task = (async () => {
    try {
      const result = await sweep({
        domain,
        queries,
        // The two halves of "make this fit", and they are different promises.
        //
        // `maxQueries` is the SIZE of the run: the whole thing, opening hand
        // and every widening round, because `queries` alone clamps only the
        // catalog and one measured run turned an opening of 10 into 77 fired.
        // A caller with a clock cannot bound a run with a number the run may
        // multiply by seven.
        //
        // `deadlineAt` is the BACKSTOP, and it is the same instant the watchdog
        // below counts to, from the same `startedAt`. The budget is arithmetic
        // over a median yield of 13 hosts per query against a measured spread
        // of 7 to 17, so half of all runs are slower than the number that sized
        // them; the engine reads the clock at its own checkpoints and ships a
        // shorter map rather than overrunning into the guillotine.
        maxQueries: QUERY_BUDGET,
        deadlineAt: startedAt + CLOCK_S * 1000,
        // Search-wave width, same dial the CLI takes; retry-afters keep it honest.
        concurrency: Number(process.env.OPENKB_SEARCH_CONCURRENCY ?? 0) || undefined,
        spans: record.spans,
        creds: {
          token: process.env.BRIGHTDATA_API_TOKEN!,
          serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
          unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
        },
        model: provider()(modelId),
        modelId,
        pricing: priceForModel(modelId),
        runId: record.id,
        // The same figure the guard above checked at request time. 0 means
        // unset (see `ceilingUsd()`'s own convention), which is honestly "no
        // ceiling" rather than a ceiling of zero dollars.
        ceilingUsd: ceiling > 0 ? ceiling : null,
        signal: record.abort.signal,
        onLog: (line) => console.log(`[${record.id.slice(0, 8)}] ${line}`),
      })
      // Awaited: this is the run becoming durable, and the task must not be
      // able to resolve in front of it.
      await finishRun(record.id, result)
    } catch (e) {
      // Every part of the ending is `failRun`'s now — whether this was a stop
      // or a crash (it holds the AbortController), what the reader is told (a
      // sweep's throw is not a sentence this app may repeat: it is an
      // OpenRouter or Bright Data error and can carry a request id or a key
      // fragment), and the last frame on the stream, which has to precede the
      // close that `failRun` also owns. This catch used to write the frame and
      // hand `failRun` the raw error a line later, which is how the live panel
      // and `GET /api/run/[id]` came to disagree about the same failure.
      // Awaited for the same reason the success path is. A failure is a record
      // too — the row is the only thing that can tell another instance why a
      // run that spent money died, and losing it is how a browser ends up
      // polling a 404 forever.
      await failRun(record.id, e)
    }
  })()

  // The promise, not a callback: it is already running — the sweep must start
  // now, not after the response is flushed — and `after` takes either.
  //
  // It cannot reject. Both branches inside the task end in an awaited call that
  // swallows its own write failures, so there is nothing here for the runtime
  // to report as an unhandled task.
  //
  // Wrapped in the watchdog rather than handed over bare, so the invocation ends
  // on this app's terms a margin before it ends on the platform's.
  after(withDeadline(task, record, startedAt))

  // THE ROW BEFORE THE ID. The browser opens the stream the instant it has a
  // run id, and that request is a different invocation with an empty registry
  // — Postgres is the only thing that can tell it the id is real. Measured on
  // the deployment before this line existed: `{"error":"no such run"}` and
  // zero frames for a run that was working perfectly, because the row was
  // still in flight when the browser asked for it.
  //
  // Costs one round trip on a request that is already answering in
  // milliseconds, and only when a store is configured. A failure here is not
  // fatal to the run — the engine has already started and the file path still
  // records it — so it is swallowed rather than turned into a 500 for a run
  // that is going to happen anyway.
  await record.created?.catch(() => {})

  // The budget rides back with the id, so the surface that started the run can
  // say what it bought BEFORE the first frame arrives — a reader who is told up
  // front that this host affords 18 questions reads the map that follows as a
  // size, not as a limit of the engine. `queries` stays what it always was: the
  // caller's own ask, echoed, undefined when they made none.
  return Response.json({
    runId: record.id,
    domain,
    queries,
    budget: {
      maxQueries: QUERY_BUDGET,
      clockSeconds: CLOCK_S,
      hostSeconds: maxDuration,
      // What the same arithmetic says this run should take. A reader comparing
      // it against `clockSeconds` can see the margin the budget was chosen for.
      estimatedSeconds: Math.round(runSeconds(QUERY_BUDGET)),
    },
  })
})

/**
 * End the run as a FAILED run just before the platform would end it as nothing.
 *
 * WHAT THIS IS FOR. `after()` buys the background task the rest of the
 * invocation, and not one second more: at `maxDuration` the instance is
 * stopped, and a stopped instance does not run a catch block, does not close
 * the span stream, and does not write a row. The run simply stops existing —
 * the browser watching `/api/run/{id}/stream` waits on a stream that will never
 * close, `/kb` never lists it, and the money is spent with nothing to show for
 * it. That silence is the failure mode worth engineering against, because it is
 * indistinguishable from a bug in this app and it costs the same as a success.
 *
 * WHY A TIMER AND NOT `getDeadline()`. The obvious implementation asks the
 * platform when it intends to stop, via `getDeadline()` from `@vercel/functions`.
 * That function could not be found: it appears nowhere in the Vercel skill set
 * shipped with this toolchain (`grep -r getDeadline` over the whole plugin
 * returns nothing), and `@vercel/functions` is not a dependency of this
 * workspace. Depending on it would mean adding a package for an API whose
 * existence is unverified, to protect against a failure that is itself hard to
 * observe. A start timestamp and the `maxDuration` this file already exports
 * need neither, and are exactly as accurate as the margin is honest — the two
 * numbers are the same two the platform is using.
 *
 * `startedAt` is taken at the top of the handler, which is LATER than the
 * instant the platform is counting from; `DEADLINE_MARGIN_S` is sized to absorb
 * that difference along with the write. See its comment.
 *
 * ORDER IS THE WHOLE CORRECTNESS ARGUMENT. `failRun` reads the abort signal to
 * decide whether a run was deliberately stopped, and a timeout is not a stop —
 * a reader told "Stopped. Everything found before you stopped it is kept."
 * about a run nobody stopped has been lied to, which is the opposite of the
 * point. So the record is written FIRST, while the signal is still clear, and
 * the sweep is aborted SECOND, purely to stop it spending. The task's own catch
 * then sees an aborted signal, but the run has already reached a terminal state
 * by then.
 */
function withDeadline(
  task: Promise<void>,
  record: { id: string; abort: AbortController },
  startedAt: number,
): Promise<void> {
  // `CLOCK_S`, not the subtraction spelled out again: the engine was handed
  // `startedAt + CLOCK_S * 1000` as its deadline, and a watchdog counting to a
  // different instant than the run is pacing itself against is a watchdog that
  // fires into a run that was about to finish, or too late to record one.
  const remaining = CLOCK_S * 1000 - (Date.now() - startedAt)

  return new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => {
        void (async () => {
          console.error(
            `[${record.id.slice(0, 8)}] deadline: stopping at ${CLOCK_S}s ` +
              `of this host's ${maxDuration}s limit, so the run is recorded rather than killed mid-write`,
          )
          try {
            // Before the abort, deliberately. See the note above.
            await failRun(
              record.id,
              new Error(
                `run exceeded this deployment's ${maxDuration}s function limit and was stopped ` +
                  `${DEADLINE_MARGIN_S}s early so the failure could be recorded`,
              ),
            )
          } finally {
            record.abort.abort()
            resolve()
          }
        })()
      },
      Math.max(0, remaining),
    )

    // The ordinary ending: the run finished inside its budget, so the timer must
    // not hold the invocation open waiting to fire into a run that is already
    // over. `unref` is not enough — this has to be cancelled, because on a
    // long-lived host (the Dockerfile, `next start`) the process outlives the
    // request and a stray timer would abort a finished run's successor.
    void task.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

/** The default `openrouter` export reads OPENROUTER_API_KEY at module scope,
 *  which in a dev server is evaluated before `.env` at the repo root has been
 *  loaded. Constructing it per request reads the key that is actually set. */
function provider() {
  return process.env.OPENROUTER_API_KEY
    ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
    : openrouter
}
