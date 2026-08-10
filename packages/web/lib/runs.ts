import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { constants as fsConstants, existsSync } from "node:fs"
import path from "node:path"
import { SpanStream, type Span } from "@open-kb/core"
import { faultNotice, namedFaults, type RunsDirTrouble } from "./api-error"
import { isDemo } from "./demo"
import * as db from "./store/supabase"
import type { SweepResult } from "@open-kb/sweep"

/**
 * Every run this server is holding.
 *
 * v1 used a durable-workflow platform that owned each run's identity, stream
 * and return value, and required every step to live in a `"use step"` sandbox.
 * That sandbox is what this rewrite exists to escape, so what replaces it is a
 * Map. A run is a plain async function writing into a `SpanStream`.
 *
 * The stream stays in memory: a restart forgets every live stream, and a stream
 * only matters while a run is in flight.
 *
 * The result does not. A finished run is a knowledge base and /kb lists those,
 * so a gallery that empties on every dev restart claims the work never
 * happened. Finished runs are written to `runs/run-<id>.json`. No database, no
 * schema, and `rm` is a valid uninstall.
 *
 * The `run-` prefix matters: `runs/` also holds `sweep-*.json` from
 * `scripts/sweep.ts`, which is a bare `SweepResult` with no envelope.
 */

export type RunStatus = "running" | "complete" | "failed"

/** A finished run as it lands on disk, the registry's fields minus the stream,
 *  which is the one thing that cannot outlive the process. */
export interface StoredRun {
  id: string
  domain: string
  queries: number
  startedAt: number
  endedAt?: number
  status: RunStatus
  /**
   * The map — absent exactly when the run did not produce one.
   *
   * It was required, and that requirement is what made a failed run
   * unreadable: `toStored` in lib/store/supabase.ts had to drop any row without
   * one, so a crash, a cancel or a spend refusal was visible only from the
   * instance that ran it. The alternative to optionality was a zeroed
   * `SweepResult`, which would render as a market this deployment searched and
   * found empty — a measurement nobody took.
   *
   * Guard with `isCompleted` rather than by hand: it narrows to `CompletedRun`,
   * which is what every KB surface takes.
   */
  result?: SweepResult
  /**
   * Why it failed, in the one sentence a reader may be shown.
   *
   * Already bounded when it gets here. In memory it is `failRun`'s own
   * `faultNotice` output; out of Postgres it is the reader's half of the
   * `error` column, split off by lib/store/supabase.ts. Neither carries the
   * provider's words, which is the whole reason both spellings exist.
   */
  error?: string
}

/** A run with a map in it. The KB surfaces read nothing else, and saying so in
 *  the type is what keeps them from having to invent one for a run that
 *  failed. */
export type CompletedRun = StoredRun & { result: SweepResult }

/** Whether this run produced a map. The narrowing is the point — `filter(isCompleted)`
 *  hands `summaryOf` and friends exactly what they declare. */
export function isCompleted(run: StoredRun): run is CompletedRun {
  return run.result !== undefined
}

export interface RunRecord {
  id: string
  /**
   * How to stop this run.
   *
   * The sweep has honoured an AbortSignal at four checkpoints and on every
   * model call since it was written, and nothing ever passed one. So the only
   * way to stop a run was to kill the process, which is also the only way to
   * lose everything it had paid for: cancel and destroy were the same button.
   */
  abort: AbortController
  domain: string
  queries: number
  startedAt: number
  endedAt?: number
  status: RunStatus
  spans: SpanStream
  result?: SweepResult
  error?: string
  /**
   * The span pump, so the run's own ending can wait for it.
   *
   * `pump` reads the stream until it closes and then flushes whatever is still
   * in hand — the tail of the run, and the most interesting part of it. That
   * flush was fired into the void: `finishRun` closed the stream and returned,
   * and the last batch landed only because the process happened to still be
   * running. On a host that freezes the instance the moment the request's
   * `after()` task resolves, "happened to still be running" stops being true,
   * and the last 25 spans of a run that worked are simply gone.
   *
   * Undefined when there is no store to pump into, which is the file-backed
   * default. `Promise.all` takes that as a resolved slot, so the terminal path
   * needs no branch for it.
   */
  pumped?: Promise<void>

  /**
   * The write that puts this run's `running` row in Postgres, awaited by the
   * route before it hands the id to the browser.
   *
   * Separate from `pumped`, which is the span tail at the END of a run. This
   * one is the row at the START, and it is the difference between a browser
   * that can watch a run and one that gets "no such run" for three minutes:
   * the reader is always a different invocation, so the row is the only thing
   * that says the id it was just given is real.
   *
   * Undefined when there is no store, the file-backed default, where the
   * reader is the same process and the registry answers.
   */
  created?: Promise<void>
}

/**
 * Held on `globalThis`, not in a module-level `const`.
 *
 * Next's dev server re-evaluates a route's module graph on edit, and a fresh
 * module instance means a fresh Map, every in-flight run would vanish from the
 * registry while its background task carried on spending money into a stream
 * nobody could reach. The global survives the re-evaluation.
 */
const KEY = Symbol.for("open-kb.runs")
type Registry = Map<string, RunRecord>
const g = globalThis as unknown as { [KEY]?: Registry }
const runs: Registry = (g[KEY] ??= new Map())

/** How many finished runs are kept before the oldest is dropped. A run holds
 *  its whole span log, so an unbounded registry is an unbounded heap. */
const KEEP_FINISHED = 20

export function createRun(domain: string, queries: number): RunRecord {
  const record: RunRecord = {
    id: crypto.randomUUID(),
    domain,
    queries,
    startedAt: Date.now(),
    status: "running",
    spans: new SpanStream(),
    abort: new AbortController(),
  }
  runs.set(record.id, record)
  evict()

  if (db.configured()) {
    // HELD, NOT VOIDED, and the route awaits it before it answers.
    //
    // Voided, this raced the browser and lost. The POST returns a run id in a
    // millisecond, the browser opens the stream immediately, and that request
    // lands on an instance with no memory of the run — so it asks Postgres,
    // and Postgres does not have the row yet either, because this write was
    // still in flight. 404, and the client stops.
    //
    // The row is the run's existence certificate. Nothing may observe the id
    // before the row that explains it, so the id is not handed out until this
    // has landed.
    record.created = db.upsertRun({
      id: record.id,
      domain,
      queries,
      status: "running",
      started_at: new Date(record.startedAt).toISOString(),
    })
    // Held rather than voided: `finishRun` and `failRun` await it, so the tail
    // flush is part of the run being over rather than a race against shutdown.
    record.pumped = pump(record)
  }
  return record
}

/**
 * Write spans to Postgres while the run is still going.
 *
 * The whole reason this exists: a run's output lived only in this process until
 * the pipeline's last instruction, so a server that died at minute 11 of 12
 * discarded every search and model call already paid for. Spans land as they
 * are emitted, so a dead run is a readable one.
 *
 * Batched on both count and time. One HTTP call per span would add a round trip
 * to every SERP result; waiting for a full batch would lose the tail of a run
 * that crashes mid-batch, which is the case this is for.
 */
const FLUSH_SPANS = 25
const FLUSH_MS = 3_000

async function pump(record: RunRecord): Promise<void> {
  let batch: Span[] = []
  let last = Date.now()

  const flush = async () => {
    if (!batch.length) return
    const sending = batch
    batch = []
    last = Date.now()
    await db.appendSpans(record.id, sending)
  }

  try {
    for await (const span of record.spans.stream()) {
      batch.push(span)
      if (batch.length >= FLUSH_SPANS || Date.now() - last >= FLUSH_MS) await flush()
    }
  } catch (e) {
    console.error(`[runs] span pump for ${record.id} stopped:`, e)
  }
  // The stream closed, so `finishRun` or `failRun` has already run. Whatever is
  // still in hand is the tail of the run and is the most interesting part of it.
  await flush()
}

export function getRun(id: string): RunRecord | undefined {
  return runs.get(id)
}

/**
 * Stop a run, keeping what it has already found.
 *
 * The sweep throws on its next checkpoint, the catch in the map route records
 * it, and everything already streamed is already in Postgres. A cancelled run
 * is a short run, not a lost one.
 */
export function cancelRun(id: string): boolean {
  const r = runs.get(id)
  if (!r || r.status !== "running") return false
  r.abort.abort()
  return true
}

/**
 * Everything a run's ending has to get onto durable storage, awaited.
 *
 * WHY THIS IS A FUNCTION AND WHY IT IS AWAITED. All three writes used to be
 * `void`ed with a comment explaining that a slow disk must not fail a run that
 * succeeded. That reasoning is still right and nothing here contradicts it — a
 * write that fails is still logged, and the run is still reported as it really
 * ended. What was wrong was the LIFETIME: an unawaited promise is a promise
 * nobody is keeping the process alive for. On a normal box that is invisible,
 * because the process outlives the run by hours. On a serverless host the
 * request's `after()` task is exactly as long as the instance lives, so a
 * `finishRun` that returned before its own store write had landed could — and
 * on Vercel, routinely would — end a run that WORKED with no result row, no
 * map, and nothing in the gallery. The money was spent and the record was not
 * written.
 *
 * So each write keeps its own catch and none of them can fail the run; what
 * changes is that the run is not over until all three have answered.
 *
 * In parallel, not in sequence: they are three independent destinations (the
 * file, the run row, the span table) and a run's ending should cost one round
 * trip, not three. `Promise.all` rejects on the first rejection, which is why
 * every slot has to be non-rejecting — `db.upsertRun` and the pump's flush are
 * already `quiet`, and `persist` is given its catch here.
 */
async function settle(r: RunRecord, row: db.RunRow): Promise<void> {
  await Promise.all([
    persist(r).catch((e) => {
      console.error(`[runs] could not persist ${r.id}:`, e)
    }),
    db.configured() ? db.upsertRun(row) : undefined,
    r.pumped,
  ])
}

/**
 * A run that produced a map, recorded.
 *
 * Async, and the caller must await it — app/api/map/route.ts hands the whole
 * background task to `after()`, and this promise is the last link in that
 * chain. See `settle` for what is being waited on and why it is not optional.
 */
export async function finishRun(id: string, result: SweepResult): Promise<void> {
  const r = runs.get(id)
  if (!r) return
  r.result = result
  r.status = "complete"
  r.endedAt = Date.now()
  // Closing ends every attached `stream()`, including ones parked waiting for
  // the next span. A reader that never sees the close spins forever on a run
  // that finished minutes ago. Before `settle`, always: the pump it awaits ends
  // ON this close, so awaiting first would wait for a stream nothing will ever
  // shut.
  r.spans.close()
  await settle(r, {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    status: "complete",
    started_at: new Date(r.startedAt).toISOString(),
    ended_at: new Date(r.endedAt).toISOString(),
    result,
  })
}

/** A deliberate stop is an outcome, not a fault, so its sentence is a literal
 *  here rather than whatever the sweep threw on its way out of the checkpoint.
 *  `ResultPanel` gives this ending its own neutral chrome. */
const STOPPED = "Stopped. Everything found before you stopped it is kept."

/**
 * Record a run's failure, in the one place that can still see what failed.
 *
 * WHY THE BOUND IS HERE and not at the two places that render it. `error` is
 * whatever the SWEEP threw — an OpenRouter or Bright Data error — and those
 * carry provider detail, request ids, and occasionally a fragment of a key or
 * an account id. Two readers were getting it verbatim: `GET /api/run/[id]`
 * spreads `...(run.error ? { error: run.error } : {})` straight into a
 * production body, and the `ui:results` frame below puts it on the results
 * stream a browser is already watching. Neither can fix it, because by the time
 * either sees it `r.error` is a string and nothing about a string says who
 * wrote it. Here the Error object is still in hand, so `faultNotice` can ask
 * lib/api-error.ts whether the app authored it — which, for a sweep failure, it
 * never did. The reader gets the fixed sentence and a ref; `grep <ref>` on the
 * server has the provider's own words, on one line, with the run id beside them.
 *
 * WHY THE FRAME MOVED HERE from app/api/map/route.ts's catch. The frame and the
 * stored string are one fact rendered twice, and they were authored twice a
 * line apart — bounding one and not the other would leave the live panel
 * printing exactly what the polled endpoint refuses to. They cannot each call
 * `faultNotice` either: that mints a ref per call, and two refs for one failure
 * is a token that names nothing. The ordering settles where the single author
 * has to live: `SpanStream.stream()` returns as soon as `close()` wakes it, so
 * a frame emitted after the close reaches no attached reader — and the close is
 * this function's, so the last frame is this function's too.
 *
 * The log line comes out under `[api]`, not `[runs]`, because lib/api-error.ts
 * owns that format and a ref an operator has to grep two ways is worth less
 * than one they grep once.
 */
export async function failRun(id: string, error: unknown): Promise<void> {
  const r = runs.get(id)
  if (!r) return
  // A cancellation is not a crash. The sweep throws from its next checkpoint,
  // and everything it had already found is in the span table, so the reader is
  // told the run was stopped rather than that it broke.
  const cancelled = r.abort.signal.aborted
  r.error = cancelled ? STOPPED : faultNotice(error, `run ${id}`)
  // What the ROW keeps, which is MORE than what the reader sees. `r.error` is
  // bounded because a browser reads it; the column carries that sentence AND
  // the cause, because stderr holds the cause for as long as the host keeps
  // logs — hours, on a serverless box — while the row outlives that by years,
  // and this is the only durable record of why a run that spent real money
  // died. Both halves carry the same ref, so one grep joins them while the log
  // exists and the row still answers after it does not.
  //
  // The claim that used to justify not redacting the column — "GET
  // /api/run/[id]'s disk/DB branch omits `error` entirely" — expired the day a
  // failed row became a readable run. That branch now returns `error`, so the
  // split cannot be a convention any more: `errorColumn` writes the joint and
  // lib/store/supabase.ts's `toStored` is the only thing that reads across it,
  // handing a browser the notice and never the cause.
  const durable = cancelled ? STOPPED : db.errorColumn(r.error, error)
  r.status = "failed"
  r.endedAt = Date.now()
  // Emitted as well as recorded, so a browser that is watching sees the outcome
  // rather than a stream that simply stops. Before the close, never after.
  r.spans.emit({
    runId: r.id,
    agentId: "write",
    parentId: null,
    kind: "remember",
    name: "ui:results",
    argsDigest: JSON.stringify({ kind: "error", message: r.error }),
    ms: 0,
    ok: false,
    usd: 0,
  })
  r.spans.close()
  // A failed run is recorded, unlike the file path which drops it entirely.
  // It cost real money and its spans say exactly where it stopped. Awaited for
  // the same reason `finishRun`'s writes are: an ending nobody waits for is an
  // ending a serverless host is free to discard, and a failure that nobody can
  // read is the one this row exists to prevent.
  await settle(r, {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    status: "failed",
    started_at: new Date(r.startedAt).toISOString(),
    ended_at: new Date(r.endedAt).toISOString(),
    error: durable,
  })
}

function evict(): void {
  const finished = [...runs.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
    runs.delete(r.id)
  }
}

/* ------------------------------------------------------------------- on disk */

/**
 * Where the JSON goes.
 *
 * `next.config.ts` sets `OPENKB_RUNS_DIR` in the same Node process that then
 * serves every route, the same trick it already uses to read the repo-root
 * `.env`, so the normal path needs no guessing. The walk-up is the fallback
 * for anything that imports this module outside a Next server (a script, a
 * test), and `<cwd>/runs` is the last resort.
 *
 * The environment value is taken as written, with one exception, and the
 * exception is not a judgement about where runs belong: `/srv/data/openkb-runs`
 * is the operator's business and nothing here second-guesses it. A filesystem
 * root is refused because it is the one value `runsPath` cannot build a floor
 * under. `path.resolve` strips the trailing separator from every path except a
 * root, so for `/` the floor `dir + path.sep` is `//`, no resolved path begins
 * with that, and every id is refused as `outside runs/` — the legitimate ones
 * too. The CLI branch rethrows that outside its try on purpose, so it left the
 * module: `/kb/<id>` answered 500 with `outside runs/: sweep-<uuid>.json`,
 * naming the id for a mistake made in the environment. This is not a boundary,
 * it is the precondition of the boundary below, and since the only thing a
 * misconfigured operator can use is a sentence, the message is the whole fix.
 *
 * TWO branches can produce a root now, and both go through `checkedDir` for
 * it: this one, and `OPENKB_DEMO_MAPS_DIR` in `demoMapsDir` below. Every
 * fallback appends a component of its own (`runs`, or `demo/maps`) and so
 * cannot. The message names OPENKB_RUNS_DIR without hedging because it is
 * minted from the value that was actually read — see `checkedDir`.
 *
 * DEMO MODE TAKES NONE OF THIS PATH. `isDemo()` is the first line of the
 * function and it returns from `demoMapsDir`, which reads its own variable and
 * does its own walk. The reasoning for that split is written there; the short
 * version is that OPENKB_RUNS_DIR means "where new runs are written", a demo
 * writes none, and DEPLOY.md tells Vercel operators to point it at `/tmp`.
 */
function runsDir(): string {
  // ABOVE the OPENKB_RUNS_DIR read, and that ordering is a deliberate reversal
  // of the obvious one. See `demoMapsDir` for why the more specific variable
  // has to win here.
  if (isDemo()) return demoMapsDir()
  const fromEnv = process.env.OPENKB_RUNS_DIR
  if (fromEnv) return checkedDir(fromEnv)
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.join(dir, "runs")
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.resolve(process.cwd(), "runs")
}

/** The two components of the committed demo directory, spelled once. `demo/`
 *  is a peer of `runs/` at the repo root because that is what it is: a curated,
 *  committed `runs/` that survives a clone. */
const DEMO_DIR = ["demo", "maps"] as const

/**
 * Where the six committed maps are, found rather than configured.
 *
 * WHY THIS EXISTS WHEN `OPENKB_RUNS_DIR` IS RIGHT THERE. next.config.ts sets
 * that variable for demo mode, the same way it already sets it for `runs/`, and
 * on `next dev`, `next start` and the Dockerfile that is the whole story —
 * those three evaluate the config in the process that then serves every route.
 * A serverless host does not have to: Next records the resolved config at build
 * time and a function can boot from that record without re-running the file, in
 * which case the assignment never happens and no environment variable is set.
 * Every deployment target for this feature is exactly that kind of host, so the
 * demo cannot rest on a side effect in a config file — an unset variable would
 * drop through to the walk below it and answer with a `runs/` that a clone does
 * not have, and the gallery would say "Nothing mapped yet." over six maps that
 * shipped in the bundle.
 *
 * WHY THE WALK, and not a path resolved from this module. This file is bundled:
 * `import.meta.url` here is a chunk under `.next/server`, not `lib/runs.ts`, so
 * the `promptsRoot()` trick of walking up from the source file's own location
 * measures the wrong tree. The working directory is the one thing every layout
 * agrees on — it is the app directory under `next dev`, the repo root under the
 * Dockerfile, and the function root on a serverless host — and `demo/maps` sits
 * a fixed, short distance above all three. Six levels is the same bound the
 * `pnpm-workspace.yaml` walk uses, for the same reason: deep enough for every
 * layout this app has run in, shallow enough that a miss stays a miss instead
 * of climbing out of the deployment.
 *
 * WHY IT THROWS RATHER THAN GUESSING. Returning a plausible-but-absent path
 * makes `readdir` answer ENOENT, which this module correctly reads as "no runs
 * yet" and both list pages correctly render as "Nothing mapped yet." — which
 * would be this codebase's oldest lie (81bd308's, see TROUBLE) told about its
 * own demo. There is a remedy in the environment and it is one line, so the
 * fault names it.
 *
 * WHY ITS OWN VARIABLE, AND WHY `OPENKB_RUNS_DIR` DOES NOT REACH IT. Letting
 * the general variable win here reads as the respectful default — explicit
 * beats implicit — and it is wrong, because the two variables are answers to
 * different questions and the general one is already spoken for. DEPLOY.md
 * tells every Vercel operator to set `OPENKB_RUNS_DIR=/tmp/openkb-runs`, and it
 * is right to: that is where a LIVE deployment writes finished runs, since the
 * rest of the filesystem is read-only. A demo writes no runs at all, so under
 * the obvious ordering an operator who followed both instructions would point
 * the gallery at an empty scratch directory and get a demo with nothing in it —
 * silently, on the exact host this feature exists for, having done as they were
 * told. So demo mode reads a variable of its own. `OPENKB_DEMO_MAPS_DIR`
 * answers "which maps", `OPENKB_RUNS_DIR` answers "where do runs go", and
 * neither can quietly be mistaken for the other.
 */
function demoMapsDir(): string {
  // Through `checkedDir` like any other configured path: a filesystem root is
  // the one value `runsPath` cannot build a floor under, whichever variable
  // spelled it.
  const configured = process.env.OPENKB_DEMO_MAPS_DIR
  if (configured) return checkedDir(configured)
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ...DEMO_DIR)
    if (existsSync(candidate)) return candidate
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw namedFaults.demoMapsMissing(path.resolve(process.cwd()), DEMO_DIR.join("/"))
}

/** The last absolute value already cleared. `runsDir` runs on every read and
 *  every write — once per file during a listing — and the answer only changes
 *  when the variable does. Absolute only: a relative value resolves against
 *  `process.cwd()`, so whether it is a root is not a property of the string. */
let cleared: string | undefined

function checkedDir(value: string): string {
  if (value === cleared) return value
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) {
    // A NAMED fault, which is what earns it the right to be printed. `/kb` and
    // `/runs` catch this and render it, and they may only render a sentence
    // lib/api-error.ts wrote — so the text lives in that catalogue and this line
    // asks for it by name. Nothing else this module throws is on that shelf, and
    // nothing else belongs there: `outside runs/: <name>` and `not a run id:
    // <id>` both quote a caller's own input back at a page.
    throw namedFaults.runsDirIsRoot(value, resolved)
  }
  if (path.isAbsolute(value)) cleared = value
  // Verbatim, as before. Callers pass this to `readdir` and `mkdir` as well as
  // to `path.resolve`, and all three are happy with a relative dir.
  return value
}

const FILE_PREFIX = "run-"

/**
 * `scripts/sweep.ts` writes a bare `SweepResult` to `runs/sweep-<domain>.json` —
 * no envelope, no id, no timestamps, because a terminal does not need them.
 *
 * A run costing real money and half an hour of waiting should not be invisible in
 * the browser purely because of where it was started from, so the gallery adopts
 * those files too: the filename supplies the id, and the timings come from the
 * result the sweep already records. The two shapes stay distinct on disk, this
 * reads one as the other deliberately, rather than by accident.
 */
const CLI_PREFIX = "sweep-"
// The swarm's CLI writes the same shape under its own name; a run costing real
// money should not be invisible in the browser purely because of which engine
// produced it. Both prefixes adopt through the same reader.
const SWARM_PREFIX = "swarm-"

function adoptCliRun(filename: string, parsed: unknown): StoredRun | null {
  if (!parsed || typeof parsed !== "object") return null
  const r = parsed as Partial<SweepResult> & { stats?: Partial<SweepResult["stats"]> }
  // `anchor`, not `domain`, the sweep names the company it started from, and the
  // registry names the thing a run was asked about. Same value, different word.
  if (typeof r.anchor !== "string" || !Array.isArray(r.entities)) return null

  const prefix = filename.startsWith(SWARM_PREFIX) ? SWARM_PREFIX : CLI_PREFIX
  // A swarm run keeps its prefix in the id so the two engines' runs of one
  // anchor stay distinct in the gallery instead of colliding on the stamp.
  const id = filename.startsWith(SWARM_PREFIX)
    ? filename.slice(0, -".json".length)
    : filename.slice(prefix.length, -".json".length)
  const seconds = r.stats?.seconds ?? 0
  // The CLI stamps its filenames `<domain>-yyyymmddhhmmss`, so the run's real end
  // time is recoverable from the id and the gallery can order CLI runs against
  // each other honestly. Files written before the stamp existed fall back to
  // `Date.now()`: the CLI records a duration, not wall-clock instants, and an
  // undated run left at zero would sort to the beginning of time and read as the
  // oldest thing here.
  //
  // BOTH widths, and the optional pair is the whole point. The four writers were
  // minute-wide until minute-wide was measured one fast pair away from colliding
  // (scripts/sweep.ts has the arithmetic), and 53 files in `runs/` still carry
  // twelve digits. An absent seconds group defaults to `"00"`, which is exactly
  // what those twelve-digit names have always meant here — so the widening
  // reorders nothing that already exists, which matters more than the collision
  // being fixed did.
  //
  // A twelve-only pattern would not have thrown on the new names, it would have
  // stopped matching: no hyphen sits twelve-from-the-end of a fourteen-digit
  // stamp, so every new CLI run would quietly take `Date.now()` and date itself to
  // whenever the gallery was loaded. That silence is the failure the stamp exists
  // to prevent, arriving through the fix for it.
  //
  // The leading `-` and the `$` are what keep a slug out. An id is
  // `<slug>-<stamp>`, so digits can only be read off the tail, and fourteen cannot
  // be misread as twelve because the character twelve-from-the-end of a fourteen-
  // digit stamp is a digit, not the hyphen the pattern needs. No writer can
  // produce a false tail — all four append a stamp — so the only way to spell one
  // is by hand, and `Number.isNaN` answers that better than a stricter pattern
  // would: a tail that is digits but not a date (`-999999999999`, month 99) used
  // to hand `endedAt` a NaN that sorts nowhere and renders as "Invalid Date". It
  // now means what an absent stamp means. One fallback, one meaning.
  const stamped = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(id)
  const instant = stamped
    ? Date.parse(
        `${stamped[1]}-${stamped[2]}-${stamped[3]}T${stamped[4]}:${stamped[5]}:${stamped[6] ?? "00"}Z`,
      )
    : Number.NaN
  const endedAt = Number.isNaN(instant) ? Date.now() : instant
  return {
    id,
    domain: r.anchor,
    queries: r.stats?.queries ?? r.queries?.length ?? 0,
    startedAt: endedAt - Math.round(seconds * 1000),
    endedAt,
    status: "complete",
    result: r as SweepResult,
  }
}

/**
 * A browser-minted id has to look like the `crypto.randomUUID()` that minted it.
 *
 * It reaches the read side as a URL path segment, so anything outside the UUID
 * alphabet is refused rather than escaped: a traversal here would read an
 * arbitrary JSON file off the host and serve it as a knowledge base.
 *
 * The list goes through it too, via `isStoredRun`. It used not to, and the
 * mismatch was a live bug: a file whose id failed the check was still listed by
 * `listStoredRuns` (which only read the filename) and then 404'd when the
 * reader clicked it, a gallery card that opens onto nothing.
 *
 * What it has never covered is a CLI or swarm id — those are domain slugs and
 * stamps, so they fail this by design and always did. This comment used to say
 * the read as a whole was guarded, and that sentence was the hole: `getStoredRun`
 * swallowed `fileFor`'s throw and then built `sweep-<id>.json` out of the raw
 * segment, and `path.join` collapses `..`, so `/kb/../../../bait` addressed a
 * file outside `runs/` — three of them and not one, because `sweep-..` is a
 * literal directory name that absorbs the first. What kept that short of an
 * arbitrary file read was only the shape a hit had to have — parse as JSON, then
 * satisfy `adoptCliRun`'s `anchor` and `entities` — which still leaves an
 * arbitrary-JSON read and an existence oracle for every other path on the host.
 * `isCliRunId` is that branch's gate now, `runsPath` is the floor under both of
 * them, and `runs.test.ts` reads the bait back to prove the floor is there.
 */
function isRunId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
}

/**
 * And a CLI or swarm id has to look like a name the CLI could have written.
 *
 * `scripts/sweep.ts` and `scripts/swarm.ts` both build their filename as
 * `<prefix><domain.replace(/\W+/g, "-")>-<stamp>`, and `\W` is everything
 * outside `[A-Za-z0-9_]`, so the entire vocabulary is word characters joined by
 * dashes — plus the swarm's prefix, which `adoptCliRun` keeps in the id. The
 * stamp is optional because `runs/` still holds files from before it existed.
 *
 * Stated as what is allowed, not as what is feared. A `..` filter has to keep
 * guessing the next spelling — `%2e%2e`, `....//`, a backslash, a leading `/`,
 * a NUL smuggled in to truncate the name — whereas an alphabet with no dot, no
 * separator of either slant, no colon and no control character in it has
 * nowhere to put any of them, and a dot-segment cannot be spelled at all.
 *
 * The bound is set by the filesystem, not by taste. Both CLIs take the anchor
 * raw from argv, so a long URL pasted as the domain slugs into a long id — 126
 * characters for one real `grundfos.com` deep link — and a rail tighter than
 * what the CLI can successfully write reintroduces the bug this comment's
 * neighbour records: `listStoredRuns` reads the filename and lists it,
 * `getStoredRun` refuses it, and the gallery card opens onto nothing. A name
 * component caps at 255 bytes, `.json` and the longest prefix take eleven, so
 * nothing that exists on disk can exceed this. The alphabet is what makes a
 * traversal unspellable; the length only stops the reader being measured.
 */
function isCliRunId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,250}$/.test(id)
}

/**
 * Belt and braces: every file this module reads out of `runs/` resolves through
 * here, and anything landing outside the directory is refused.
 *
 * The alphabets above already make an escape unspellable. This is underneath
 * them because an alphabet is a claim about today's callers — widen one to
 * admit a dot for some future filename and the traversal is back, silently.
 * A containment check survives that edit; the regex is the one being edited.
 *
 * `path.resolve` is what makes the comparison meaningful: `OPENKB_RUNS_DIR` may
 * be relative, and resolving both sides collapses that and any `..` in `name`
 * into one absolute answer. The trailing separator is load-bearing — without it
 * `/srv/runs-evil/x.json` reads as inside `/srv/runs`.
 *
 * Lexical rather than `realpath`, and the reason is `persist`: this same
 * function resolves the path a run is about to be *written* to, and `realpath`
 * cannot answer for a file that does not exist yet. The cost of that choice is
 * exact — a symlink planted inside `runs/` is followed out of it, because a
 * lexical check never sees where a link points. That is not the traversal this
 * guards against: it needs an attacker who can already write into `runs/`, and
 * anyone who can do that can write a gallery entry directly and skip the link.
 */
function runsPath(name: string): string {
  const dir = path.resolve(runsDir())
  const full = path.resolve(dir, name)
  if (!full.startsWith(dir + path.sep)) throw new Error(`outside runs/: ${name}`)
  return full
}

function fileFor(id: string): string {
  if (!isRunId(id)) throw new Error(`not a run id: ${id}`)
  return runsPath(`${FILE_PREFIX}${id}.json`)
}

/* -------------------------------- what a failed read says about the directory */

/**
 * Which errnos mean "not there yet" and which mean "there and wrong".
 *
 * WHY THIS TABLE EXISTS. `listStoredRuns` wrapped `readdir` in a bare catch
 * under a comment naming ONE meaning — "no runs/ yet" — and every other way a
 * directory can fail fell into it. Measured on a production server:
 * OPENKB_RUNS_DIR pointed at a `chmod 000` directory, and at a regular file;
 * /kb and /runs both answered 200 with a tidy empty gallery and no banner. That
 * is the exact lie 81bd308 was written to end, surviving underneath the line
 * 81bd308 added. The refusal that got the attention there — a filesystem root —
 * is the rare one; EACCES and ENOTDIR are what actually happens to a deployment.
 *
 * WORKED OUT FROM THE SYSCALL, not from a guess, and measured on this platform:
 *
 *   ENOENT        the path is not there. THE ABSENCE, and the only one. A
 *                 missing parent gives ENOENT too, and so does a symlink whose
 *                 target does not exist — correctly, since what is being asked
 *                 about is the directory and there is no directory.
 *   EACCES/EPERM  it is there and refuses. A `chmod 000` runs/, or a server
 *                 running as a user the volume was not chowned to.
 *   ENOTDIR       the path is a file, or a component of it is.
 *   ELOOP         a symlink that leads back to itself.
 *   ENAMETOOLONG  a value no filesystem can turn into a name.
 *
 * THE DEFAULT FOR AN ERRNO NOT LISTED HERE IS TO THROW, and the two failure
 * modes it is chosen against are not symmetric.
 *
 * Swallowing by default is what the bug WAS: it turns every unfamiliar failure
 * into "nothing built yet", silently, for the next filesystem this runs on. That
 * set is open-ended and grows — a network mount answers ESTALE and EIO, a FUSE
 * layer answers whatever it likes — so a swallow-by-default rule is a promise to
 * re-tell this lie in a form nobody has seen yet.
 *
 * Throwing by default risks only one thing, and it is bounded: an absence
 * reported as an error would break CI on its first run, because `runs/` is
 * gitignored and a fresh clone — which is what a runner checks out — has none.
 * That risk is bounded precisely because absence is not an open-ended set. It is
 * ENOENT, on every POSIX platform and on Windows, where libuv maps both
 * ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND onto it. So the swallow set can
 * be enumerated and closed; the throw set cannot. The unknown belongs on the
 * side that is loud, and `runs.test.ts` pins the clone case from the other
 * direction so the enumeration stays honest.
 *
 * BEING IN THIS TABLE IS NOT THE SAME AS BEING THROWN. Everything not listed is
 * still thrown — as ITSELF, which `faultNotice` turns into the fixed sentence
 * and a grep-able ref. What the table decides is the narrower question of which
 * failures earn a NAMED fault instead, and the test is whether there is a remedy
 * in the environment: every entry here is fixed by changing a permission or a
 * path, and the sentence says which. A process out of file descriptors has no
 * such fix, so EMFILE is deliberately absent — a ref is the honest answer when
 * the operator has nothing to edit.
 */
const TROUBLE: Record<string, RunsDirTrouble | undefined> = {
  EACCES: "refused",
  EPERM: "refused",
  ENOTDIR: "notADirectory",
  ELOOP: "unnameable",
  ENAMETOOLONG: "unnameable",
}

/** The errno of a filesystem error, and `undefined` for anything that is not
 *  one — a `JSON.parse` SyntaxError, this module's own throws, a `NamedFault`
 *  already on its way out. Read off `code` rather than the numeric `errno`,
 *  which is platform-specific where the string is not. */
function errnoOf(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined
  const code = (e as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** Whether a failed read means the path is simply not there. */
function isAbsence(e: unknown): boolean {
  return errnoOf(e) === "ENOENT"
}

/** The named fault this errno deserves, or `undefined` when it deserves a ref. */
function troubleOf(e: unknown): RunsDirTrouble | undefined {
  return TROUBLE[errnoOf(e) ?? ""]
}

/**
 * What to throw for a read that failed: the shelf's sentence when the errno
 * names a directory an operator can fix, and the original error otherwise.
 *
 * The raw error never reaches the page in the first case, and that is the point
 * rather than a side effect. `EACCES: permission denied, scandir '/srv/…'` is
 * the operating system's prose, and a page may only print prose lib/api-error.ts
 * wrote — backlog 3h is open against two paths that forgot that, and this is new
 * code. So the errno is classified here, where the Error object still is, and
 * only the key travels.
 *
 * The resolved directory, not the configured spelling: this is the path the
 * syscall actually failed on, and a relative OPENKB_RUNS_DIR would otherwise
 * print as something the operator has to resolve in their head to act on.
 */
/** Whether the directory itself is readable and searchable, asked of the OS
 *  rather than guessed from a file's errno. The distinction it buys: one
 *  unopenable file among many is that file's problem; a directory that answers
 *  no here is everyone's. */
async function canRead(dir: string): Promise<boolean> {
  try {
    await access(dir, fsConstants.R_OK | fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function readFault(e: unknown, dir: string): unknown {
  const trouble = troubleOf(e)
  return trouble ? namedFaults.runsDirUnreadable(path.resolve(dir), trouble) : e
}

/** One file out of `runs/`, or `null` when it is simply not there. The whole
 *  value is in the middle case having somewhere to go: a miss is `null`, a
 *  refusal is a throw, and the caller no longer has to spell both as `catch`. */
async function readRunFile(file: string, dir: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8")
  } catch (e) {
    if (isAbsence(e)) return null
    throw readFault(e, dir)
  }
}

async function persist(r: RunRecord): Promise<void> {
  if (!r.result) return
  const stored: StoredRun = {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status,
    result: r.result,
  }
  await mkdir(runsDir(), { recursive: true })
  await writeFile(fileFor(r.id), JSON.stringify(stored, null, 2), "utf8")
}

/**
 * A live record as a readable run, or null while there is nothing to read.
 *
 * A run in flight is the null: it has neither a map nor an outcome, and a
 * gallery card for one opens onto a page that cannot be drawn.
 *
 * A FAILED record is readable, and it is the same decision `toStored` makes
 * about a failed ROW — stated twice because the two sources are independent and
 * a reader that got "this run failed" out of Postgres and "no such run" out of
 * the process holding it would be a worse bug than either half alone.
 * `isCompleted` is what keeps the KB surfaces off it.
 */
function storedFrom(r: RunRecord): StoredRun | null {
  if (r.status === "running") return null
  if (r.status === "complete" && !r.result) return null
  return {
    id: r.id,
    domain: r.domain,
    queries: r.queries,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status,
    ...(r.result ? { result: r.result } : {}),
    // Already the bounded sentence — `failRun` is the only writer, and it
    // writes `faultNotice`'s output here and the cause only into the column.
    ...(r.error ? { error: r.error } : {}),
  }
}

function isStoredRun(v: unknown): v is StoredRun {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  const result = o.result as Record<string, unknown> | undefined
  return (
    isRunId(o.id) &&
    typeof o.domain === "string" &&
    !!result &&
    typeof result.anchor === "string" &&
    Array.isArray(result.entities)
  )
}

/**
 * Every completed run, newest first.
 *
 * Memory wins over disk for the same id: the in-process record is the one a
 * just-finished run is readable from before its file has landed. A file that
 * does not parse is skipped and logged rather than thrown, one corrupt run
 * must not take the whole gallery down with it — a file that cannot be READ is
 * a fact about the directory rather than about that run, and is not skipped.
 */
export async function listStoredRuns(): Promise<StoredRun[]> {
  const byId = new Map<string, StoredRun>()

  // Resolved outside the try, which is the whole point of resolving it here.
  // The catch below means one specific thing — "no runs/ yet" — and a refused
  // directory is the opposite of that. Swallowed, it would render as a tidy
  // "Nothing mapped yet.", quieter than the 500 the refusal replaced and
  // therefore worse: the misconfiguration would become invisible. `/kb` prints
  // what this throws, and `/runs` now does too.
  //
  // Hoisting was only half of it, though, and the half that was left is the
  // reason the catch below now reads an errno: this line keeps ONE refusal out
  // of the swallow, and the swallow kept taking all the others.
  const dir = runsDir()

  /** A directory-level refusal, held rather than thrown — see the merge below. */
  let diskFault: unknown
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch (e) {
    // The catch now means what its comment always said. Hoisting `runsDir()`
    // above the try kept one refusal out of here; the swallow underneath took
    // every other one, and a `chmod 000` runs/ or a regular file passed as one
    // rendered as "Nothing mapped yet." — quieter than the fault it replaced and
    // therefore worse. ENOENT is the absence and nothing else is; see TROUBLE
    // for why the unrecognised errno goes this way rather than that one.
    if (!isAbsence(e)) diskFault = readFault(e, dir)
    names = [] // no runs/ yet — that is an empty gallery, not an error
  }
  /* Counted rather than decided per file, because neither extreme is right.
     Escalating on one file's errno blanked a healthy gallery over a single
     unreadable map — measured, 47 good sweeps lost to one. Escalating only when
     the DIRECTORY's own bits refuse misses the commoner shape: mode 755 over
     files that are all mode 000, where `readdir` succeeds, `access` succeeds,
     every read fails, and the page says "nothing mapped yet" over real maps.
     The honest signal is the ratio. One candidate refused is that file's
     problem; every candidate refused is a statement about the directory,
     whatever its own permission bits claim. */
  let candidates = 0
  let refused = 0
  let lastRefusal: unknown
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    if (!name.startsWith(FILE_PREFIX) && !name.startsWith(CLI_PREFIX) && !name.startsWith(SWARM_PREFIX)) continue
    candidates += 1
    try {
      const parsed: unknown = JSON.parse(await readFile(runsPath(name), "utf8"))
      const stored = isStoredRun(parsed) ? parsed : adoptCliRun(name, parsed)
      if (stored) byId.set(stored.id, stored)
    } catch (e) {
      // Skip-and-log stands for a file that does not PARSE, which is what it was
      // written for: the gallery is then complete minus one broken map, and the
      // reader loses nothing they could have had. A file that cannot be READ is a
      // different fact and gets the same treatment as the directory, because
      // `readdir` has just proved this name exists — a name the process can see
      // and cannot open is a permission statement, not a corrupt run. The case
      // that makes it worth the wider blast radius is mode `r--` on runs/:
      // measured, `readdir` succeeds and every file in it answers EACCES, so
      // without this the gallery is silently short by its entire contents with
      // only a log line per run to show for it. ENOENT stays a skip — that is a
      // file removed between the listing and the read, and a race is not a fault.
      // Escalate only when the DIRECTORY is the thing at fault, asked directly
      // rather than inferred from one file's errno. The first draft escalated on
      // the errno alone, and measured: one `chmod 000` file among 47 healthy
      // sweeps blanked the whole gallery under a sentence diagnosing the
      // directory — which was readable — and offering a remedy that would have
      // changed nothing. A file the process can see and cannot open is a fact
      // about that file until the directory says otherwise. The case this still
      // covers is the one it was written for, mode `r--` on runs/: there the
      // access check fails too, and every file failing is a directory
      // statement rather than 47 coincidences.
      if (troubleOf(e)) {
        refused += 1
        lastRefusal = e
      }
      console.error(`[runs] skipping unreadable ${name}:`, e)
    }
  }
  // Every candidate refused, and there was at least one: the directory is the
  // fault even though it let itself be listed. `canRead` cannot see this — it
  // asks about the directory's own bits, and those are fine here.
  if (!diskFault && candidates > 0 && refused === candidates) diskFault = readFault(lastRefusal, dir)

  // Postgres and the in-memory registry are asked even when the disk refused,
  // and that ordering is the fix for a regression the first draft shipped:
  // throwing at the `readdir` catch pre-empted both, so an unreadable
  // OPENKB_RUNS_DIR took a fully readable nine-map Postgres gallery to zero —
  // measured. The disk is one source of three, not a gate on the other two.
  //
  // ONE SOURCE IN DEMO MODE, AND THIS WAS MEASURED THE HARD WAY. A demo built
  // and started against this repo listed FIFTEEN maps, not six: the committed
  // directory plus nine runs out of the operator's own Supabase, because
  // next.config.ts loads the repo's `.env` and `SUPABASE_URL` is in it. Every
  // one of those nine was a real run of a real domain that nobody chose to
  // publish, on a URL whose entire purpose is being handed to strangers.
  //
  // The registry goes with it, though it cannot currently hold anything —
  // `createRun` is reachable only from the map route, which refuses first. It
  // is skipped anyway so the guarantee is structural rather than a coincidence
  // of today's call graph: a demo serves the directory it was given, and the
  // list of things it will not also serve is not a list anyone has to maintain.
  if (!isDemo()) {
    for (const stored of await db.listRuns()) byId.set(stored.id, stored)
    for (const r of runs.values()) {
      const s = storedFrom(r)
      if (s) byId.set(s.id, s)
    }
  }

  // Told only when the disk was the ONLY source. With runs from elsewhere the
  // honest answer is the runs, and the fault is on the log line above; with
  // nothing at all, "no maps yet" is the lie this item exists to end and the
  // sentence naming the directory is the whole point.
  if (diskFault && byId.size === 0) throw diskFault

  return [...byId.values()].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
}

/** One completed run. Memory first, a run that finished a moment ago is
 *  readable before its file lands. */
export async function getStoredRun(id: string): Promise<StoredRun | null> {
  // The same one-source rule the listing keeps, and it has to be kept in both
  // places or they disagree: a gallery of six over a reader that will still
  // serve a seventh to anyone who types its id. The store is the door that
  // matters — a demo pointed at a configured Supabase would hand over any run
  // in it, unlisted, to a guessed URL. See `listStoredRuns` for the fifteen
  // maps that were measured coming through it.
  const demo = isDemo()
  const live = demo ? undefined : runs.get(id)
  if (live) {
    const s = storedFrom(live)
    if (s) return s
  }
  // Below the memory branch and above every disk read, and it needs both halves
  // of that position. A run this process finished a moment ago is readable
  // whatever the filesystem is doing, so this cannot sit at the top; and the two
  // reads under it both have to name the directory in a refusal, so it cannot
  // sit inside either try. Same reason `listStoredRuns` hoists it.
  const dir = runsDir()

  // `isRunId` as a branch, where it used to be `fileFor`'s throw caught below.
  // The same refusal either way, but a catch cannot tell "this is a CLI id, try
  // the other shape" apart from "this directory cannot be read", and conflating
  // those is the whole item: /kb learning the truth while /kb/<id> answered "No
  // knowledge base called <id>" for a runs/ nobody could open.
  /* Held, not thrown, for the same reason `listStoredRuns` holds its own: the
     disk is one source of three and the store may well have the run. Throwing
     here made the two disagree — the gallery listed a Postgres-backed map over
     an unreadable disk, and every link it advertised answered 500, because this
     read the disk before it ever asked `db.getRunRow`. Measured. A refusal is
     only the answer once nothing else has one. */
  let diskFault: unknown
  const readOr = async (file: string): Promise<string | null> => {
    try {
      return await readRunFile(file, dir)
    } catch (e) {
      diskFault = e
      return null
    }
  }

  if (isRunId(id)) {
    const text = await readOr(fileFor(id))
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (isStoredRun(parsed)) return parsed
      } catch {
        // on disk and not JSON. `listStoredRuns` logs those with the filename in
        // hand; here the name came from the reader, so the miss is the message.
      }
    }
  }
  // The CLI branch, now gated. It used to run for whatever string arrived,
  // which is how a URL segment became a filename: the bare `catch {}` that used
  // to stand where the branch above stands had already eaten `fileFor`'s
  // refusal, so nothing was left checking anything.
  if (isCliRunId(id)) {
    const name = id.startsWith(SWARM_PREFIX) ? `${id}.json` : `${CLI_PREFIX}${id}.json`
    // Resolved outside the try deliberately. A containment failure means the
    // alphabet has grown a hole and should be loud, not swallowed as a miss —
    // swallowing it is the exact move that hid this for as long as it did.
    const file = runsPath(name)
    const text = await readOr(file)
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text)
        return adoptCliRun(name, parsed)
      } catch {
        // on disk but not JSON, fall through to the store
      }
    }
  }
  const row = demo ? null : await db.getRunRow(id)
  if (row) return row
  // Nothing anywhere, and the disk refused on the way past: that refusal is the
  // answer now, because "no such run" would be a claim this process cannot
  // make. With a row in hand it stays unspoken — the reader got what they asked
  // for and the fault is on the log line.
  if (diskFault) throw diskFault
  return null
}
