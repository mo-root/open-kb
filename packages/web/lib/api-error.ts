/**
 * What a route handler answers when it throws, and the token that ties that
 * answer to the server log.
 *
 * THE FAULT THIS EXISTS FOR. Measured on a `next start` with
 * `OPENKB_RUNS_DIR=/` — the one value lib/runs.ts refuses — `/api/kb`,
 * `/api/kb/[id]`, `/api/kb/[id]/graph` and `/api/run/[id]` each answered **500,
 * zero bytes, and no `content-type` header at all**. A `fetch` saw `r.ok ===
 * false` and an empty body, so every client in this app fell back to printing
 * "HTTP 500", and there was nothing to follow that up with, because the server
 * log line for a route-handler throw carries no digest either:
 *
 *     Error: OPENKB_RUNS_DIR is "/", which resolves to / — the filesystem root...
 *         at z (.next/server/app/api/kb/route.js:1:610)          <- no digest
 *
 * compare the same throw from a PAGE, which Next does tag:
 *
 *         at l (.next/server/app/kb/[id]/page.js:2:14150) { digest: 2302084429 }
 *
 * So the page half of this app (app/error.tsx, 8f3172e) has a token joining
 * what the reader sees to what the operator greps, and the API half had neither
 * end of it. app/error.tsx cannot close the gap: route handlers do not render
 * React boundaries — measured with that boundary in place, those four routes
 * still answered zero bytes. The `ref` below is the missing token, and this
 * module is the only place it is minted.
 *
 * WHY THE BODY CANNOT CARRY THE MESSAGE. React redacts a page error before any
 * boundary sees it; a route handler has no such protection, and whatever goes
 * in the body is what ships. The very fault that opened this item reads
 * `OPENKB_RUNS_DIR is "/", which resolves to / — the filesystem root. ... e.g.
 * /openkb-runs.`: an environment variable's name, its value, and two filesystem
 * paths. Returning `err.message` in production would install exactly the leak
 * React exists to prevent, on six endpoints at once. Backlog 3h is already open
 * against two *pages* for doing precisely that, so doing it here would be
 * shipping a known bug into new code.
 *
 * AND NOW THE PAGE HALF, closed against the same rule — see "the sentence a
 * page may speak for" at the foot of this file. That item is this one's twin:
 * a route handler has no redaction to lose, a page that catches its own error
 * throws React's redaction away, and both end up rendering server-origin text
 * to a reader. One module answers both, so an operator greps one format.
 */

/** The shape every unhandled route-handler fault answers with. */
export interface FaultBody {
  /**
   * A fixed sentence with the ref spelled into it. Safe in any build, because
   * nothing about the fault is in it.
   *
   * The ref appears here as well as in `ref`, and that duplication is the
   * point. `ref` is for a machine; the sentence is for the two clients that
   * render `error` and nothing else — NoteView.tsx's `(await r.json()).error`
   * and KbOverview.tsx's `setError(data.error ?? …)` — so a screenshot of a
   * broken note panel now contains the token instead of a shrug. No client had
   * to change for that.
   */
  error: string
  /** The correlation token on its own, for anything reading this as data. */
  ref: string
  /** The real message. Non-production builds only; see `showsDetail`. */
  detail?: string
}

/**
 * Whether the body may carry the fault's own text.
 *
 * This is the same line the page half already draws: under `next dev` React
 * redacts nothing and app/error.tsx prints the real message, so a developer
 * curling an endpoint should not be worse off than one loading a page. In a
 * production build neither half says anything.
 *
 * `detail` is a separate field rather than a richer `error` deliberately.
 * `error` is what the two clients above render into the UI, and a field whose
 * meaning changes with NODE_ENV is a field that leaks the day somebody's build
 * mode is wrong.
 *
 * Read inside a function, never at module scope — but NOT for the reason
 * app/api/map/route.ts's `ceilingUsd()` gives. There, a module-scope read was a
 * real bug: Next inlines `process.env.X` at build time and OPENKB_CEILING_USD
 * is set by the host at run time, so the guard compiled to `if (false)`.
 * NODE_ENV is the opposite case — it genuinely is a build-time constant, and
 * inlining it to `"production"` in a production build is the correct answer.
 * The function exists so the test can pin both branches: vitest runs this
 * TypeScript directly, with no bundler inlining anything, so flipping
 * `process.env.NODE_ENV` there flips this.
 */
function showsDetail(): boolean {
  return process.env.NODE_ENV !== "production"
}

/**
 * A fresh correlation ref: 12 hex characters, off the same `crypto.randomUUID()`
 * the run registry uses for run ids.
 *
 * Random per occurrence, not a hash of the error the way React's digest is. A
 * digest names an error CLASS, so every reader hitting the same broken
 * deployment quotes the same number and `grep` returns a thousand lines. This
 * has to name one request, because "here is my ref" is the entire user-facing
 * half of the feature.
 *
 * 12 rather than 8: at 8 hex the birthday bound puts an even chance of some
 * collision at roughly 65k refs, which one long-lived log can reach. At 12 it
 * is around 17 million. A collision is survivable — two lines, two timestamps —
 * but one line is the promise being made.
 */
export function faultRef(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12)
}

/**
 * Record a fault and return its ref, without answering anything.
 *
 * Split out from `faultResponse` for the one caller that cannot send a
 * response: app/api/run/[id]/stream/route.ts, whose fault happens after the
 * headers are gone. Everything else should use `guarded`.
 *
 * The format is one line, ref first, message on the SAME line.
 * `console.error(prefix, err)` prints Node's inspection of the error, whose
 * first line is `Error: <message>` — so for anything thrown as an Error, which
 * is everything this app throws, `grep <ref>` alone lands on the cause. That is
 * deliberately better than the page side, where Next appends `{ digest: … }` to
 * the LAST line of the stack and app/error.tsx has to tell the reader to run
 * `grep -B6`.
 *
 * The exception, stated so the claim above is not read wider than it holds: a
 * thrown plain object inspects across several lines with `{` first, so the
 * grepped line carries the ref and nothing else. `grep -A20 <ref>` covers that
 * and the stack in both cases. Not worth flattening the message into the prefix
 * to close — it would cost the structured inspection on every ordinary fault to
 * buy a better first line on a kind of throw this codebase does not make.
 *
 * `[api]` matches the `[runs]` prefix lib/runs.ts already logs under.
 */
export function logFault(err: unknown, req?: unknown): string {
  const ref = faultRef()
  console.error(`[api] fault ${ref} ${whereOf(req)}:`, err)
  return ref
}

/**
 * The one sentence an unnamed fault is allowed to be, wherever it surfaces.
 *
 * Extracted rather than written twice: `faultResponse` puts it in a JSON body
 * and `faultNotice` puts it on a page, and two spellings of the same promise is
 * how a reader ends up quoting a ref in words the operator's runbook does not
 * use. It says "request" on a page too, because a page render is one.
 */
function refSentence(ref: string): string {
  return `the server could not handle this request — quote ref ${ref}, the server log has the cause`
}

/** Log the fault and answer with the stable body. Always 500, always JSON —
 *  the zero-byte, no-`content-type` answer is the thing being fixed, so the
 *  header matters as much as the payload. `no-store` because a cached 500
 *  would hand one request's ref to everyone who followed. */
export function faultResponse(err: unknown, req?: unknown): Response {
  const ref = logFault(err, req)
  const body: FaultBody = {
    error: refSentence(ref),
    ref,
  }
  if (showsDetail()) body.detail = err instanceof Error ? err.message : String(err)
  return Response.json(body, { status: 500, headers: { "Cache-Control": "no-store" } })
}

/**
 * Wrap a route handler so an unhandled throw becomes the body above.
 *
 * WHY A WRAPPER AND NOT SIX TRY/CATCH BLOCKS. The ref is worth something only
 * if every handler mints it the same way and logs it in the same format — a
 * token the operator cannot grep for uniformly is not a token. Six copies is
 * six chances for that to drift, silently. It also keeps the handlers looking
 * like handlers: each of these is a four-line function whose whole body is two
 * awaits and a `Response.json`, and a try/catch around each would double its
 * length and indent the part that matters.
 *
 * WHAT IT DOES NOT TOUCH: deliberate refusals. Those are `return`s, not throws
 * — `{ error: "no such knowledge base" }` at 404, `{ error: "path is required"
 * }` at 400, and api/map/route.ts's 400/503/429 all pass through this function
 * byte-identical and unlogged. It only ever sees an exception.
 *
 * Generic over the whole argument tuple so it fits both shapes Next hands a
 * handler: the bare `GET()` in api/kb/route.ts and the `(req, { params })` of
 * every dynamic segment, each keeping its own param type.
 */
export function guarded<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      // Next always passes the Request first, even to handlers that declare no
      // parameters, so this is the method and path in practice. Narrowed rather
      // than assumed because the tuple is generic.
      return faultResponse(err, args[0])
    }
  }
}

/* --------------------------------------- the sentence a page may speak for */

/**
 * WHAT WAS MEASURED. app/kb/page.tsx and app/runs/page.tsx each catch a
 * registry fault themselves and render `err.message`, and on a `next start`
 * with `OPENKB_RUNS_DIR=/` both shipped this into production HTML at status
 * 200:
 *
 *     Could not list knowledge bases
 *     OPENKB_RUNS_DIR is "/", which resolves to / — the filesystem root. No run
 *     can be read or written there. Point it at a subdirectory, e.g.
 *     /openkb-runs.
 *
 * an environment variable's name, its value, and two filesystem paths — the
 * same string the header of this file opens with. React redacts a Server
 * Component error before app/error.tsx ever sees it, which is the only reason
 * that boundary is safe; a component that catches its own error has thrown the
 * redaction away.
 *
 * WHY IT IS A DEFECT EVEN THOUGH TODAY'S TEXT IS OURS. The only thing
 * `listStoredRuns` throws today is the refusal above, which this app wrote and
 * which contains no user data. So the leak is real but the wording is currently
 * ours by coincidence, and coincidence is the bug: `/kb`'s try wraps
 * `.map(summaryOf)` as well as the read, so the day kb-from-run throws, that
 * message ships too, and nobody will have read it first. A page that renders
 * `err.message` must render a message IT CHOSE, not any message it caught.
 *
 * WHAT MUST NOT BE LOST. Deleting the message is a worse product, not a fix. A
 * registry that cannot be READ is a different fact from a registry with nothing
 * IN it, and 81bd308 added that distinction deliberately: telling an operator
 * "nothing mapped yet" when the truth is "the runs directory is unusable" sends
 * them off to re-buy a map they already paid for. The OPENKB_RUNS_DIR sentence
 * is the remedy as well as the diagnosis — it names the variable and the fix —
 * so it survives here word for word.
 *
 * THE MECHANISM: a closed catalogue. A page may print a sentence only if THIS
 * FILE wrote it. `namedFaults` below is the whole shelf, the `NamedFault`
 * constructor is deliberately not exported, and a throw site therefore cannot
 * author text at all — it picks an entry and fills that entry's named holes.
 *
 * Chosen against the three alternatives, on the one test that matters, which is
 * how hard it is to WIDEN by accident:
 *
 *   - an exported error class. Widening is one line at any throw site, and the
 *     line writes itself: throw new PublicError(`could not read runs:
 *     ${e.message}`). Interpolation is exactly how a leak gets committed while
 *     looking like helpfulness. A class bounds where a fault came FROM, never
 *     what it SAYS.
 *   - a tagged property (`err.speakable = true`). The same hole, plus any
 *     re-wrapping layer can tag an error it did not write, and the safe set can
 *     only be grepped for, never enumerated or tested.
 *   - a predicate over the message text. It ties safety to wording, so fixing a
 *     typo silently un-names the fault and the useful message vanishes with no
 *     test failing; and a pattern loose enough to survive the interpolated path
 *     is loose enough to admit whatever else lands in that slot.
 *
 * The catalogue is the only one of the four whose safe set is a LIST — small
 * enough to read, and read back by a test that asserts its exact keys
 * (`api-error.test.ts`, "the whole shelf"). Adding to it means editing this
 * object, under this comment, and turning that test red on the way past.
 */

/**
 * The brand, keyed on `Symbol.for` rather than resting on `instanceof` alone.
 *
 * Same reason lib/runs.ts keeps its registry under `Symbol.for("open-kb.runs")`:
 * a module graph can hold more than one copy of this file, and `instanceof`
 * across two copies is false. A well-known symbol is the same key in both. The
 * class is still checked first — it is the typed answer — and the brand is what
 * stops a duplicated module from silently downgrading the one message this
 * whole mechanism exists to keep.
 *
 * Forgeable, and worth saying out loud rather than implying otherwise: anyone
 * can write `Object.defineProperty(err, Symbol.for("open-kb.named-fault"), …)`.
 * That is not the failure being defended against. The defect being fixed is a
 * catch that is safe by accident; the defence is that widening it now has to be
 * typed on purpose, in this file, where this comment is.
 */
const NAMED = Symbol.for("open-kb.named-fault")

/** Not exported, and that is the mechanism: the only way to obtain one is an
 *  entry in `namedFaults`, so the set of sentences a page can print is the set
 *  of entries in that object. */
class NamedFault extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NamedFault"
    // Non-enumerable, so the brand never turns up in a `{ ...err }` spread, a
    // JSON dump, or the inspection `logFault` prints.
    Object.defineProperty(this, NAMED, { value: true })
  }
}

/**
 * Why the runs directory could not be read, in this app's words and not the
 * operating system's.
 *
 * A CLOSED UNION, and that is what keeps `runsDirUnreadable` inside the rule the
 * shelf below states. The fact underneath it is an errno, and an errno arrives
 * wearing a message this app did not write — `EACCES: permission denied, scandir
 * '/srv/data/openkb-runs'` — which is exactly the caught text this catalogue
 * exists to keep off a page. So lib/runs.ts hands over no message, and not even
 * the code: it reads the errno, decides which of these three facts that errno
 * names, and passes the KEY. The prose is a literal here, the hole takes a value
 * from a set declared here, and nothing the filesystem wrote crosses over.
 *
 * Three facts rather than one per errno, because the split is by REMEDY. Each of
 * these is something an operator fixes by changing a permission or a path, and
 * the sentence says which. A failure with no such remedy — the process out of
 * file descriptors, a disk answering EIO — is deliberately not on the shelf at
 * all: lib/runs.ts rethrows it as itself and the reader gets a ref, because
 * "quote this ref" is the honest instruction when there is nothing in the
 * environment to change.
 */
export type RunsDirTrouble = "refused" | "notADirectory" | "unnameable"

/** The middle of that sentence, one clause per fact, each ending on the verb of
 *  its own fix so the shared tail reads as the second of two options. */
const RUNS_DIR_TROUBLE: Record<RunsDirTrouble, string> = {
  refused:
    "it is there, and this server is not allowed to read it. Give the server read " +
    "and search permission on it",
  notADirectory: "what is at that path is not a directory. Move it aside",
  unnameable:
    "that path cannot name a directory on this filesystem — a symbolic link that " +
    "leads back to itself, or a name longer than the filesystem allows. Untangle it",
}

/**
 * The whole shelf. Every sentence a page may render verbatim is here.
 *
 * Two entries today, and they are the same fact twice: a runs directory that
 * cannot hold or hand back a run. That is not the mechanism being oversized for
 * the problem — it is the problem being small and the widening being the risk,
 * which is why the shelf is a list rather than a rule.
 *
 * THE RULE FOR A NEW ENTRY, because the mechanism only holds if the entries do.
 * An entry's TEXT is a literal in this file. Its HOLES may be filled only with
 * values this app itself computed — a config value the operator set, a path this
 * module resolved, a count. Never a caught error's `.message`, never a
 * provider's words, never anything that arrived from the network or the
 * filesystem as prose. `runsDirIsRoot` takes two strings, so its shape reads as
 * permission to interpolate; it is not. It may take them because both are things
 * the operator typed into OPENKB_RUNS_DIR and this module then resolved — the
 * reader is being shown their own configuration back. `runsDirUnreadable` is the
 * cleaner illustration and the one to copy from: its second hole is a KEY into
 * `RUNS_DIR_TROUBLE` above rather than a string, because the fact it names
 * reaches lib/runs.ts as an errno whose message the operating system wrote.
 *
 * A hole you cannot describe in those terms means the sentence belongs on the
 * `[api] fault <ref>` line instead, which is what `faultNotice` does by default.
 */
export const namedFaults = {
  /**
   * OPENKB_RUNS_DIR resolves to a filesystem root — thrown by `checkedDir` in
   * lib/runs.ts, wording from 81bd308, byte for byte, because runs.test.ts pins
   * it and because an operator staring at an empty gallery is the only reader
   * this sentence has.
   *
   * `resolved` is a filesystem root — the only case that reaches this entry —
   * and a root is the one path `path.resolve` leaves its trailing separator on,
   * so the concatenation below is `path.join` without dragging node:path into a
   * module that has no other reason to touch the filesystem.
   */
  runsDirIsRoot(value: string, resolved: string): Error {
    return new NamedFault(
      `OPENKB_RUNS_DIR is ${JSON.stringify(value)}, which resolves to ${resolved} — the ` +
        `filesystem root. No run can be read or written there. Point it at a subdirectory, ` +
        `e.g. ${resolved}openkb-runs.`,
    )
  },

  /**
   * The runs directory is there and unusable — thrown by `listStoredRuns` and
   * `getStoredRun` in lib/runs.ts, once they have classified the errno.
   *
   * THE SENTENCE THIS DISPLACES is "Nothing mapped yet.", which is what both
   * list pages rendered for a `chmod 000` runs directory and for a regular file
   * handed over as one: 200, empty gallery, no banner, measured on both. That is
   * 81bd308's lie arriving through a different errno than the one it was fixed
   * for — the sibling comment above says telling a reader nothing was built
   * sends them off to re-buy a map that already exists, and it is no less true
   * when the cause is a permission bit than when it is a filesystem root. So the
   * remedy is that remedy: name the directory, name what is wrong with it, and
   * say plainly that unreadable is not empty.
   *
   * `dir` is this module's own resolved path, filling the same hole
   * `runsDirIsRoot` fills with the operator's own configuration. Not the id from
   * the URL, ever — the id is not what is broken, and 81bd308 exists partly to
   * stop a message blaming it. `trouble` is a key, so the only prose in the
   * result is this file's.
   */
  runsDirUnreadable(dir: string, trouble: RunsDirTrouble): Error {
    return new NamedFault(
      `The runs directory ${JSON.stringify(dir)} is unusable: ${RUNS_DIR_TROUBLE[trouble]}, ` +
        `or point OPENKB_RUNS_DIR at a directory this server can read. Nothing is listed ` +
        `until it can be — an unreadable registry is not an empty one, and the map you are ` +
        `looking for may already be inside it.`,
    )
  },

  /**
   * OPENKB_DEMO is on and the committed maps are not where they should be —
   * thrown by `demoMapsDir` in lib/runs.ts once its walk has come up empty.
   *
   * WHY IT IS ON THE SHELF and not a ref. The test in the header of this
   * object is whether the operator has something to change, and here they have
   * two things: the directory did not ship with the build, or the working
   * directory is somewhere the walk cannot see it — and both are answered by
   * one environment variable. A ref would send them to a log line that says
   * the same thing to a smaller audience.
   *
   * WHY IT IS NOT SILENCE, which is the alternative it was chosen against. A
   * demo deployment that cannot find its maps renders an empty gallery under
   * "Nothing mapped yet.", and that is precisely the sentence 81bd308 spent a
   * commit deleting: a reader told nothing was built goes and builds one, which
   * on this deployment is the one thing demo mode exists to prevent them doing.
   *
   * Both holes are this app's own: `cwd` is a path this module resolved, and
   * `expected` is a constant lib/runs.ts spells out. Nothing from a caught
   * error, a provider or a URL crosses over.
   */
  /**
   * A run reached the most one map may cost here and was stopped at it —
   * thrown by `withSpendCap` in app/api/map/route.ts, from the watchdog that
   * reads the span stream's own running total.
   *
   * WHY IT IS ON THE SHELF. The test above is whether the reader has something
   * to do about it, and this reader has three things, all of which the sentence
   * has to carry: the run is not broken, everything it found before the stop is
   * kept and readable, and a bigger map is available to anyone willing to run
   * it on their own keys. A ref would send a visitor to a server log they
   * cannot read, about a deliberate act, on the deployment's busiest surface.
   * It is also the ONE ending a reader is most likely to misread as a bug,
   * because a partial map looks exactly like a broken one.
   *
   * WHY IT CANNOT BE A LITERAL IN THE ROUTE. `failRun` in lib/runs.ts runs
   * every failure through `faultNotice`, deliberately, because a sweep's throw
   * is an OpenRouter or Bright Data error that can carry a request id or a
   * fragment of a key. An app-authored sentence handed to it unbranded comes
   * back out as "something went wrong, quote this ref" — the deadline
   * watchdog below made exactly this mistake (a plain `new Error(...)`) until
   * `runDeadline` gave it a shelf entry of its own, same fix, same reason.
   *
   * Both holes are numbers this app computed from its own configuration:
   * `capUsd` is the ceiling in force, `spentUsd` the span stream's running
   * total. Nothing caught, nothing from a provider, nothing from a URL.
   */
  runCostCeiling(capUsd: number, spentUsd: number): Error {
    return new NamedFault(
      `This map reached $${spentUsd.toFixed(2)}, which is the most — $${capUsd.toFixed(2)} — that ` +
        `one map is allowed to cost on this deployment, and it was stopped there. Everything it ` +
        `had already found is kept and is on the page. Nothing is broken and the domain you asked ` +
        `about is not the problem: the limit is deliberate, and it is what stops a single map ` +
        `spending a whole day's budget. Clone the repo and run it on your own keys for a map with ` +
        `no ceiling on it.`,
    )
  },

  /**
   * A run reached the host's own time limit and was stopped just short of it —
   * thrown by `withDeadline` in app/api/map/route.ts, the sibling watchdog to
   * `runCostCeiling` above, counting seconds instead of dollars.
   *
   * WHY IT IS ON THE SHELF. Same shape as `runCostCeiling`, same three things a
   * reader staring at a map that stopped partway through needs to hear: it is
   * not broken, what it found is kept, and a run with no clock on it exists.
   * MEASURED: before this entry, `withDeadline` handed `failRun` a plain
   * `new Error(...)` — unbranded, so `faultNotice` printed "something went
   * wrong, quote this ref" for a stop this app caused on purpose and could
   * fully explain. A reader whose run ran out the clock got the least
   * informative sentence in the whole app for the most explicable ending.
   *
   * The one hole is `clockSeconds` (`CLOCK_S` at the call site): a number this
   * app derived from `maxDuration`, not the host's own wording of the limit.
   */
  runDeadline(clockSeconds: number): Error {
    return new NamedFault(
      `This map ran for ${clockSeconds}s, which is the longest this deployment lets one map run, ` +
        `and it was stopped there. Everything it had already found is kept and is on the page. ` +
        `Nothing is broken and the domain you asked about is not the problem: the limit is how ` +
        `long this deployment can host one request, not a fact about the market. Clone the repo ` +
        `and run it on your own keys for a map with no time limit on it.`,
    )
  },

  demoMapsMissing(cwd: string, expected: string): Error {
    return new NamedFault(
      `OPENKB_DEMO is on, so this deployment serves its committed maps and starts no runs — ` +
        `but no ${expected}/ directory was found at or above ${JSON.stringify(cwd)}. This is ` +
        `not an empty demo, it is a demo that cannot find what it ships with: either the ` +
        `directory did not make it into the deployment, or this process is running somewhere ` +
        `the search cannot reach it. Set OPENKB_DEMO_MAPS_DIR to the directory holding the ` +
        `maps. Not OPENKB_RUNS_DIR — that one says where new runs are written, and demo mode ` +
        `does not read it.`,
    )
  },
} as const

/** The message a page may show for this fault, or `null` when the app did not
 *  write it. An empty sentence is not a sentence, so it reads as unnamed —
 *  `faultNotice` depends on never returning "". */
// Deliberately NOT exported. `faultNotice` is the only door, because it cannot
// be misused — its fallback is the ref. This returns `string | null`, and a null
// invites `namedFaultMessage(err) ?? err.message` at a call site, which reads as
// helpful and is the original defect written in one line. Re-export it the day
// something genuinely needs the null, and not before.
/**
 * Whether this app wrote the sentence inside this error.
 *
 * A BOOLEAN, DELIBERATELY, and that is the whole difference between this and
 * the function below it. `namedFaultMessage` is not exported because a
 * `string | null` invites `namedFaultMessage(err) ?? err.message` at a call
 * site, which reads as helpful and is the original leak written in one line.
 * There is no such move available from a boolean: a caller who learns the
 * answer is yes still has to go through `faultNotice` to get the words.
 *
 * The one caller is `failRun` in lib/runs.ts, deciding between two sentences it
 * already holds — its own "Stopped." literal for a run a person cancelled, and
 * whatever `faultNotice` gives it. A named fault means the stop had a REASON
 * this app can state (the spend cap is the first), and a reason beats "Stopped."
 * for a reader looking at a map that ended early.
 */
export function isNamedFault(err: unknown): boolean {
  return namedFaultMessage(err) !== null
}

function namedFaultMessage(err: unknown): string | null {
  if (!(err instanceof Error) || !err.message) return null
  // `Reflect.get` rather than an index, because `Error` declares no symbol
  // index signature and the cast that would silence that is the kind of cast
  // that later hides a real mistake.
  const named = err instanceof NamedFault || Reflect.get(err, NAMED) === true
  return named ? err.message : null
}

/**
 * What a page renders for a fault it caught: the fault's own sentence when this
 * file wrote it, otherwise the fixed sentence and a ref, logged with the cause.
 * The same deal the nine `guarded` handlers already give, in the shape a
 * component can put in a `<div>`.
 *
 * `where` is a Request when there is one and a plain route string when there is
 * not — a Server Component is handed neither.
 *
 * IT DOES NOT VARY WITH NODE_ENV, and the reason is `showsDetail`'s own
 * argument turned around. A route handler can afford a separate `detail` field
 * because `error` stays fixed beside it; a page has exactly one string, so a
 * build-mode branch here would BE the message, and the leak arrives the day
 * somebody's build mode is wrong. The developer affordance is the log line,
 * which now carries ref and cause together.
 *
 * A NAMED FAULT IS NOT LOGGED. There is nothing to correlate — the reader
 * already has the entire message — and `/kb` re-reads the registry on every
 * request, so a line per render would bury the faults that do carry a ref.
 *
 * THE RETURN IS NEVER EMPTY, and both callers lean on it. They render
 * `error ? "could not list…" : rows.length === 0 ? "nothing mapped yet" : …`,
 * so an empty string would take the second rung and restore 81bd308's lie: an
 * unreadable registry reported as a deployment that has simply never run
 * anything.
 */
export function faultNotice(err: unknown, where?: unknown): string {
  const named = namedFaultMessage(err)
  if (named !== null) return named
  return refSentence(logFault(err, where))
}

/** `GET /api/kb/x/note?path=y` for the log line. The query string is the
 *  client's own input and often the thing that failed, so it stays; it is going
 *  to a server log, not to a body. */
function whereOf(req: unknown): string {
  // A page has no Request in hand, so both list pages pass their own route as a
  // string. Taken as written for the same reason the query string is: this line
  // is server-side, and the alternative is an anonymous fault.
  if (typeof req === "string") return req
  if (!(req instanceof Request)) return "(no request)"
  try {
    const u = new URL(req.url)
    return `${req.method} ${u.pathname}${u.search}`
  } catch {
    return req.method
  }
}
