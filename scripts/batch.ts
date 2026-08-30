/**
 * Many maps, unattended.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/batch.ts scripts/gallery-domains.txt
 *         npx tsx scripts/batch.ts list.txt --concurrency 2 --queries 60 --timeout 1800
 *         npx tsx scripts/batch.ts list.txt --resume runs/batch-20260810T151102.jsonl
 *         OPENKB_BATCH_CAP_USD=310 npx tsx scripts/batch.ts scripts/gallery-domains.txt
 *         npx tsx scripts/batch.ts list.txt --retries 0
 *
 * The list stops itself at $50.00 and each run inside it at $8.00; both are
 * argued in `scripts/spend-caps.ts`, and the fourth form above is what the
 * 79-domain gallery list wants if it is to finish in one go. Every non-capped
 * failure is retried once by default (`readFlag`'s own fallback for
 * `--retries` is 1); the fifth form above turns that off, for a list where a
 * second attempt is not worth doubling the cost of every real failure.
 *
 * WHY THIS IS NOT A SHELL LOOP. Building a gallery means fifty sweeps back to
 * back — about ten hours and eighty dollars at the rates in `runs/`. Three
 * things that are survivable once are not survivable fifty times:
 *
 *   a run that hangs      one unanswered model call held a figma.com sweep for
 *                         13 minutes at 0.1% CPU before it was killed by hand.
 *                         packages/sweep now bounds every model call, and this
 *                         adds the outer wall clock the engine cannot set for
 *                         itself, because a process wedged below the engine
 *                         (DNS, a socket, the runtime) never reaches that code.
 *   a run that dies       a shell loop with `&&` stops; one with `;` carries on
 *                         and tells you nothing. Each sweep here is a CHILD
 *                         PROCESS, so a crash, an OOM or a throw costs one
 *                         domain instead of the night.
 *   the batch dying       at domain 37 of 50, thirty-six paid-for maps must not
 *                         be rebuilt. Every outcome is appended to a manifest
 *                         as it happens, and `--resume` reads it back.
 *
 * A CHILD PER SWEEP, deliberately, rather than importing `sweep()` and awaiting
 * it in a pool. In-process is cheaper and gives up the two properties that
 * matter here: a throw inside one sweep cannot be contained well enough to
 * guarantee the other nine keep going, and there is no way to stop a wedged one
 * — `AbortController` only reaches code that checks it. A killed PID always
 * stops. It also means this file runs exactly what a person runs by hand, so
 * the gallery is reproducible with one command per row.
 */
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { EXIT } from "./fatal.js"
import {
  CLI_LIMIT_VARS,
  DEFAULT_LIST_CAP_USD,
  DEFAULT_RUN_CAP_USD,
  capUsdOrExit,
  listRoom,
} from "./spend-caps.js"

export interface Outcome {
  anchor: string
  ok: boolean
  /** Why it failed, in one line, or the run file it wrote. */
  detail: string
  seconds: number
  usd: number | null
  /** The child stopped itself at the per-run cap. Not a failure and not a
   *  success: the money was spent, the map was not finished, and retrying would
   *  spend the same cap to reach the same place. */
  capped?: true
  attempt: number
  at: string
}

/**
 * `min` is 1 for the flags where zero is meaningless — no concurrency is no
 * work, no timeout is an instant kill — and 0 for `--retries`, where "do not
 * retry" is a real thing to ask for and was refused by a blanket `n <= 0`.
 *
 * Split from `flag` below the same way `readCapUsd`/`capUsdOrExit` split in
 * scripts/spend-caps.ts, so the parsing itself is reachable without a
 * `process.exit(2)` in the way: this whole file used to run at import time
 * (argv, `mkdirSync`, `spawn`), so nothing in it — including this arithmetic
 * — had a test that did not shell out to a real subprocess.
 */
export function readFlag(
  argv: string[],
  name: string,
  fallback: number,
  min = 1,
): { ok: true; n: number } | { ok: false; why: string } {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return { ok: true, n: fallback }
  const raw = argv[at + 1]
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || !Number.isInteger(n)) {
    return {
      ok: false,
      why: `--${name} needs a whole number ${min === 0 ? "of 0 or more" : "of 1 or more"}, got ${JSON.stringify(raw ?? "")}`,
    }
  }
  return { ok: true, n }
}

function flag(name: string, fallback: number, min = 1): number {
  const reading = readFlag(process.argv, name, fallback, min)
  if (!reading.ok) {
    console.error(reading.why)
    process.exit(2)
  }
  return reading.n
}

export function stringFlag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? null : (argv[at + 1] ?? null)
}

/** The domains a list names, once each — in first-seen order, so a resumed
 *  batch's manifest still lines up with the list it was given. */
export function dedupeAnchors(anchors: string[]): string[] {
  const seen = new Set<string>()
  return anchors.filter((a) => (seen.has(a) ? false : (seen.add(a), true)))
}

/**
 * The anchors a resume manifest already finished, read back from its JSONL.
 *
 * A half-written last line is what a killed batch leaves — skipped rather
 * than refusing to resume over one truncated record, same as the inline
 * `try`/`catch` this was pulled out of.
 */
export function doneAnchorsFromManifest(text: string): Set<string> {
  const done = new Set<string>()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Outcome
      if (o.ok) done.add(o.anchor)
    } catch {
      // see above
    }
  }
  return done
}

/**
 * What one sweep attempt's own exit tells the batch about it — pulled out of
 * `runOne`'s `finish` closure, which is where every branch below used to live
 * unreachable from a test process (it only runs once a real child process
 * has exited). Disk reads (locating `mine`/`stopFile` and pricing them via
 * `costOf`) stay in the closure; this is pure decision-making over what they
 * found.
 */
export interface OutcomeInputs {
  anchor: string
  attempt: number
  /** The child's exit code, or null if it never reported one (killed, or a
   *  spawn failure). */
  code: number | null
  /** Killed by the outer wall-clock timer, as opposed to exiting on its own. */
  killed: boolean
  /** The last few lines of the child's combined stdout/stderr. */
  tail: string
  /** The run file this attempt is believed to have written, if any. */
  mine: string | undefined
  mineUsd: number | null
  /** The `stopped-*.json` a capped run wrote, if one was found. */
  stopFile: string | undefined
  stopFileUsd: number | null
  timeoutS: number
  runCapUsd: number | null
  seconds: number
  at: string
}

export function computeOutcome(i: OutcomeInputs): Outcome {
  // STOPPED AT ITS OWN CAP, and this is read from the EXIT CODE rather than
  // from the files, because it is the one outcome the files cannot tell
  // apart. A capped sweep writes `runs/stopped-<anchor>-<stamp>.json`, whose
  // name begins with neither prefix the caller looks for and whose shape is
  // deliberately not a map. Without this branch the domain would land in the
  // manifest as `exit 6` — a mystery — and be retried, which spends the same
  // cap a second time to reach the same place.
  const capped = i.code === EXIT.capped

  // The stopped record carries the real total, in-flight overrun and all. If
  // it cannot be read, the run is charged at its cap: the money is gone
  // either way, and the list's budget must not be told a stopped run was
  // free. Same pessimism `count()` in lib/spend-limits.ts applies to a run
  // whose ending was lost.
  let usd: number | null = i.mine ? i.mineUsd : null
  if (capped && usd === null) usd = (i.stopFile ? i.stopFileUsd : null) ?? i.runCapUsd

  // WROTE A READABLE MAP, not "exited zero". A sweep that throws after
  // writing is still a map, and one that exits zero having written nothing
  // is not — the second is what a killed process looks like from here.
  //
  // A CAPPED RUN THAT WROTE A MAP IS STILL A MAP. The cap can fire during the
  // link phase, which skips instead of throwing, and the sweep then writes a
  // complete map with fewer edges and exits `capped` anyway. There is
  // nothing to retry and nothing to mourn: the row says `ok`, and the detail
  // says the cap is why the edges are thin.
  const ok = Boolean(i.mine) && usd !== null

  return {
    anchor: i.anchor,
    ok,
    ...(capped ? { capped: true as const } : {}),
    detail: ok
      ? capped
        ? `runs/${i.mine} — stopped at the run cap while linking`
        : `runs/${i.mine}`
      : capped
        ? `stopped at the $${(i.runCapUsd ?? 0).toFixed(2)} run cap${i.stopFile ? ` — runs/${i.stopFile}` : ""}`
        : i.killed
          ? `killed at the ${i.timeoutS}s cap`
          : `exit ${i.code}${i.tail.trim() ? ` — ${i.tail.trim().split("\n").slice(-3).join(" / ")}` : ""}`,
    seconds: i.seconds,
    usd,
    attempt: i.attempt,
    at: i.at,
  }
}

/* --------------------------------------------------------------------- main */

// Body left un-indented after the `invokedDirectly` guard, the same choice
// bench.ts/bakeoff.ts made wrapping a pre-existing body: re-indenting the
// whole thing would bury this diff's real change (the extraction above)
// under a column shift on every line.
const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {

const listPath = process.argv[2]
if (!listPath || listPath.startsWith("--")) {
  console.error("usage: tsx scripts/batch.ts <domains.txt> [--concurrency N] [--queries N] [--timeout SECONDS] [--resume manifest.jsonl]")
  process.exit(2)
}
if (!existsSync(listPath)) {
  console.error(`no such list: ${listPath}`)
  process.exit(2)
}

/**
 * TWO AT A TIME by default.
 *
 * Not a CPU limit — a sweep is almost entirely waiting on Bright Data and
 * OpenRouter. It is a rate limit. One sweep already runs its search wave 20
 * wide and its rank pool 8 wide, and the SERP zone answers a burst with 429s
 * and a pacing backoff (`noteThrottle` in packages/providers/src/brightdata.ts),
 * so stacking sweeps buys throttling rather than throughput past a point.
 * Two roughly halves a fifty-map night without pushing into that. Raise it if
 * your zone has the headroom; the adapter will not lose data either way, it
 * will just slow down.
 */
const CONCURRENCY = flag("concurrency", 2)

/** Passed through to the sweep as its query target. Left unset, the engine
 *  deals its own hand per product, which is the normal path. */
const QUERIES = stringFlag(process.argv, "queries")

/**
 * The outer wall clock, per run, in seconds.
 *
 * One hour, raised from thirty minutes, and the raise is the interesting part.
 * Thirty was set against the 58 sweeps then in `runs/` — median 211s, p90
 * 1,052s, slowest legitimate finish 1,599s — and it was already wrong when it
 * was written: figma.com went on to finish normally at 1,973 seconds, having
 * paid $1.69 and produced 1,979 entities and 2,074 edges. Under a 1,800s cap
 * that map is killed at 91% done and recorded as a FAILURE, having spent every
 * dollar of it. That is the worst outcome this file can produce, and it is
 * strictly worse than waiting on a wedged run: a cap that is too high costs one
 * worker slot for an extra half hour, a cap that is too low costs the map.
 *
 * The distribution also shifts UNDER us. Fixing the classifier so that sellers
 * come back as one kind took figma from 6 company rows to 1,147, and the link
 * phase is quadratic-ish in that count — so every historical duration here was
 * measured on an engine that had less to link than the current one does. An
 * hour clears the slowest real finish by 82% and still catches a true wedge,
 * which is all a backstop is for.
 */
const TIMEOUT_S = flag("timeout", 3600)

const RETRIES = flag("retries", 1, 0)

/**
 * TWO CAPS, BECAUSE THIS FILE MULTIPLIES.
 *
 * The three things this file was built to survive — a run that hangs, a run that
 * dies, the batch itself dying — are all about TIME, and every one of them was
 * closed. Money was not: `spent` below was printed after every domain and
 * compared to nothing, so a 50-domain list projected to $69 at the measured
 * median run and $187 at the worst, and nothing in this file could stop it. It
 * is the largest single exposure in the repo, because it is the only entrypoint
 * a person deliberately walks away from.
 *
 *   per run    enforced by the CHILD, not here. Each sweep is its own process
 *              and `scripts/sweep.ts` now caps itself against its own span
 *              stream, which is the only place that can see a run's spending as
 *              it happens — this process sees a domain's cost once, when the
 *              child has already exited and the money is gone. `process.env` is
 *              inherited by every child (see `spawn` below), so an operator's
 *              `OPENKB_CLI_RUN_CAP_USD` reaches all of them, and the default
 *              applies when they set nothing. Read here only so the arithmetic
 *              below can reserve against it and so the header line can quote it.
 *   per list   enforced here, and it is the one that matters: no single run cap
 *              bounds fifty runs.
 *
 * `scripts/spend-caps.ts` chooses both defaults and defends them — including why
 * the per-list default is deliberately TIGHT where the per-run one is loose:
 * stopping a list costs nothing, because `--resume` picks up exactly what is
 * still owed, while stopping a run costs the run.
 */
const RUN_CAP_USD = capUsdOrExit(CLI_LIMIT_VARS.runCap, DEFAULT_RUN_CAP_USD)
const LIST_CAP_USD = capUsdOrExit(CLI_LIMIT_VARS.listCap, DEFAULT_LIST_CAP_USD)

const anchors = readFileSync(listPath, "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)

if (!anchors.length) {
  console.error(`${listPath} has no domains in it`)
  process.exit(2)
}

const queue = dedupeAnchors(anchors)
if (queue.length !== anchors.length) {
  console.log(`${anchors.length - queue.length} duplicate ${anchors.length - queue.length === 1 ? "domain" : "domains"} dropped`)
}

mkdirSync("runs", { recursive: true })

/**
 * RESUME READS OUTCOMES, NOT THE RUNS DIRECTORY.
 *
 * Scanning `runs/` for a matching filename would skip a domain whose last
 * attempt FAILED, since a failed sweep can still leave nothing behind and a
 * successful older one is indistinguishable from a fresh one by name. The
 * manifest records what this batch decided, so a resume retries exactly what is
 * still owed.
 */
const resumeFrom = stringFlag(process.argv, "resume")
let alreadyDone = new Set<string>()
if (resumeFrom) {
  if (!existsSync(resumeFrom)) {
    console.error(`no such manifest: ${resumeFrom}`)
    process.exit(2)
  }
  alreadyDone = doneAnchorsFromManifest(readFileSync(resumeFrom, "utf8"))
}

// The one spelling every stamped writer in scripts/ uses, asserted by
// packages/web/lib/runs.test.ts. This file wrote `/[-:]/g` at first, which
// leaves the `T` in and made `batch-20260810T122018.jsonl` — a fifth spelling
// of the same idea, which is the drift that test exists to stop.
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
const manifest = resumeFrom ?? `runs/batch-${stamp}.jsonl`

const todo = queue.filter((a) => !alreadyDone.has(a))
const money =
  (LIST_CAP_USD === null ? `no list cap (${CLI_LIMIT_VARS.listCap} is off)` : `$${LIST_CAP_USD.toFixed(2)} for the list`) +
  " · " +
  (RUN_CAP_USD === null ? `no run cap (${CLI_LIMIT_VARS.runCap} is off)` : `$${RUN_CAP_USD.toFixed(2)} a run`)
console.log(
  `${todo.length} to build` +
    (alreadyDone.size ? `, ${alreadyDone.size} already done` : "") +
    ` · ${CONCURRENCY} at a time · ${TIMEOUT_S}s cap each · manifest ${manifest}`,
)
// Said before anything is spent, and said in dollars. The projection is the
// point: the measured median run is $1.386 and the worst is $3.736, so a reader
// can see whether their list fits inside the cap before it stops halfway. Left
// off an empty list, where "$0-$0" is arithmetic nobody asked for.
console.log(
  money +
    (todo.length
      ? ` · this list projects to $${(todo.length * 1.386).toFixed(0)}-$${(todo.length * 3.736).toFixed(0)} ` +
        `at the measured median and worst run`
      : ""),
)
if (!todo.length) {
  console.log("nothing left to do")
  process.exit(0)
}

/** What `runs/` holds now, so a run's own output file can be identified after
 *  the child exits. The sweep stamps its filename with the wall clock, so the
 *  only reliable attribution is "the file that was not there before". */
const before = new Set(readdirSync("runs").filter((f) => f.endsWith(".json")))

function runOne(anchor: string, attempt: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now()
    const args = ["tsx", "scripts/sweep.ts", anchor, ...(QUERIES ? [QUERIES] : [])]
    const child = spawn("npx", args, {
      // Inherited, so the credentials the caller sourced reach the child. This
      // script never reads a secret itself and never prints the environment.
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // ITS OWN PROCESS GROUP, and the cap does not work without it.
      //
      // `npx` is not the sweep; it execs tsx, which runs node. Measured: a
      // `--timeout 8` run finished normally at 109 seconds and was recorded as
      // a success. `child.kill()` signals npx alone, the node grandchild is
      // orphaned and goes on spending, and `close` does not fire while that
      // orphan still holds the inherited stdio pipe — so the batch waited for
      // the very run it had just tried to stop, and got a map out of it.
      //
      // `detached` makes the child a group leader, so `process.kill(-pid)`
      // reaches everything it spawned. Not `unref()`d: the parent still waits
      // on it, it is only the SIGNALLING that needed the group.
      detached: true,
    })

    let tail = ""
    const keep = (buf: Buffer) => {
      // The last few lines only. A sweep prints hundreds and the manifest wants
      // the reason it stopped, not its transcript.
      tail = (tail + buf.toString()).split("\n").slice(-12).join("\n")
    }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)

    let killed = false
    const timer = setTimeout(() => {
      killed = true
      // The GROUP, by negative pid, so tsx and node die with npx. Falling back
      // to the bare child covers the window before the group exists and any
      // platform that refuses the negative form; killing an already-dead
      // process throws ESRCH, which is the outcome we wanted anyway.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        /* already gone, or no group — the fallback below is the whole remedy */
      }
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }, TIMEOUT_S * 1000)

    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - started) / 1000)
      const after = readdirSync("runs").filter((f) => f.endsWith(".json"))
      const mine = after.find((f) => !before.has(f) && f.startsWith(`sweep-${anchor.replace(/\W+/g, "-")}-`))
      if (mine) before.add(mine)

      // A capped sweep writes `runs/stopped-<anchor>-<stamp>.json` instead of a
      // map; only looked for once the exit code says the run was capped, same
      // test `computeOutcome` makes internally off the same `code`.
      const stopFile =
        code === EXIT.capped
          ? after.find((f) => !before.has(f) && f.startsWith(`stopped-${anchor.replace(/\W+/g, "-")}-`))
          : undefined
      if (stopFile) before.add(stopFile)

      const costOf = (file: string): number | null => {
        try {
          const d = JSON.parse(readFileSync(`runs/${file}`, "utf8")) as { stats?: { usd?: number } }
          return typeof d.stats?.usd === "number" ? d.stats.usd : null
        } catch {
          // A truncated file is a failed run wearing a filename. Left null, and
          // `computeOutcome`'s `ok` is false because there is no readable map.
          return null
        }
      }

      resolve(
        computeOutcome({
          anchor,
          attempt,
          code,
          killed,
          tail,
          mine,
          mineUsd: mine ? costOf(mine) : null,
          stopFile,
          stopFileUsd: stopFile ? costOf(stopFile) : null,
          timeoutS: TIMEOUT_S,
          runCapUsd: RUN_CAP_USD,
          seconds,
          at: new Date().toISOString(),
        }),
      )
    }

    // BOTH EVENTS, because they answer different questions and either can be
    // the last one. `close` fires when every stdio stream is done and is the
    // one that gives the child's own output time to arrive; `exit` fires when
    // the process dies and is the only one that arrives if a survivor is
    // holding a pipe open. Guarded by `settled` so the first wins.
    child.on("close", finish)
    child.on("exit", (code) => {
      // A small grace so a normal exit still lets `close` deliver the tail.
      setTimeout(() => finish(code), 500)
    })
    child.on("error", (err) => {
      tail = `${tail}\nspawn failed: ${err instanceof Error ? err.message : String(err)}`
      finish(null)
    })
  })
}

const outcomes: Outcome[] = []
let cursor = 0
let spent = 0
/** Runs started and not yet settled. Held against the budget at a whole run cap
 *  each, which is what makes the list cap a ceiling rather than a hope —
 *  `listRoom` in scripts/spend-caps.ts argues it. */
let inFlight = 0
/** Set once the budget refuses another run. A flag rather than a list: both
 *  workers can reach the check, and which domain each was holding at that
 *  instant is an interleaving detail. What is still owed is read off the
 *  outcomes at the end, where it is the same answer every time. */
let budgetStopped = false

async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++
    if (i >= todo.length) return
    const anchor = todo[i]!

    // THE CHECK THAT DID NOT EXIST. `spent` was printed on every line below and
    // compared to nothing, so this loop would start the fiftieth domain exactly
    // as readily as the first. It is made BEFORE the run rather than after,
    // because after is a reading taken when the money is already gone.
    //
    // Nothing in flight is killed. A sweep 20 minutes in has spent nearly all of
    // what it will spend and is about to write a map for it; killing it converts
    // money into nothing, which is the outcome this whole file is arranged to
    // avoid. The budget stops the NEXT run, and the reservation above is what
    // keeps that honest.
    const room = listRoom({ settledUsd: spent, inFlight, runCapUsd: RUN_CAP_USD, listCapUsd: LIST_CAP_USD })
    if (!room.ok) {
      // Said once, by whichever worker gets here first. The other reaches the
      // same conclusion a moment later and has nothing to add.
      if (!budgetStopped) {
        console.log(
          `\nstopping: $${room.committedUsd.toFixed(2)} of the $${(LIST_CAP_USD ?? 0).toFixed(2)} list budget is ` +
            `committed` +
            (inFlight ? ` (${inFlight} still running, held at $${(RUN_CAP_USD ?? 0).toFixed(2)} each)` : "") +
            `, which leaves no room for another run. Nothing is lost — every map built is on disk and the ` +
            `manifest knows what is owed.`,
        )
      }
      budgetStopped = true
      cursor = todo.length
      return
    }

    inFlight++
    let out: Outcome
    try {
      out = await runOne(anchor, 1)
      // A CAPPED RUN IS NOT RETRIED. Every other failure here is worth another
      // attempt because it might not happen twice; this one will, and it costs a
      // full cap to find out. See `EXIT.capped`.
      for (let attempt = 2; !out.ok && !out.capped && attempt <= RETRIES + 1; attempt++) {
        console.log(`  ${anchor} failed (${out.detail}) — retry ${attempt - 1} of ${RETRIES}`)
        out = await runOne(anchor, attempt)
      }
    } finally {
      inFlight--
    }
    outcomes.push(out)
    spent += out.usd ?? 0
    appendFileSync(manifest, `${JSON.stringify(out)}\n`)
    const n = outcomes.length
    const failed = outcomes.filter((o) => !o.ok).length
    console.log(
      `[${n}/${todo.length}] ${out.ok ? "ok  " : out.capped ? "CAP " : "FAIL"} ${anchor.padEnd(24)} ` +
        `${String(out.seconds).padStart(5)}s ${out.usd === null ? "     —" : `$${out.usd.toFixed(3)}`}` +
        `  ·  $${spent.toFixed(2)} spent, ${failed} failed`,
    )
  }
}

const startedAt = Date.now()
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()))

const failed = outcomes.filter((o) => !o.ok)
const capped = outcomes.filter((o) => o.capped)
/** What the budget left undone, in list order — read off the outcomes rather
 *  than accumulated by the workers, so two workers stopping at once cannot
 *  reorder it or drop the domain one of them was holding. */
const attempted = new Set(outcomes.map((o) => o.anchor))
const unstarted = budgetStopped ? todo.filter((a) => !attempted.has(a)) : []
console.log(`\n${"=".repeat(78)}`)
console.log(
  `${outcomes.length - failed.length}/${outcomes.length} built · $${spent.toFixed(2)}` +
    (LIST_CAP_USD === null ? "" : ` of $${LIST_CAP_USD.toFixed(2)}`) +
    ` · ${Math.round((Date.now() - startedAt) / 60000)} minutes`,
)
if (capped.length) {
  console.log(
    `\n${capped.length} ${capped.length === 1 ? "domain" : "domains"} stopped at the ` +
      `$${(RUN_CAP_USD ?? 0).toFixed(2)} run cap. A resume will run ${capped.length === 1 ? "it" : "them"} ` +
      `again under whatever ${CLI_LIMIT_VARS.runCap} is set to then; under the same cap ` +
      `${capped.length === 1 ? "it" : "they"} will stop in the same place.`,
  )
}
if (failed.length) {
  console.log(`\n${failed.length} failed:`)
  for (const f of failed) console.log(`  ${f.anchor.padEnd(24)} ${f.detail}`)
}
// THE RESUME LINE IS NOT ONLY FOR FAILURES. A list stopped by its own budget has
// nothing in `failed` and everything still to do, and the whole argument for a
// tight default list cap is that stopping costs nothing BECAUSE this line exists.
// It used to print only when something had failed, which is exactly when a
// budget-stopped batch would not have shown it.
if (failed.length || unstarted.length) {
  if (unstarted.length) {
    console.log(
      `\n${unstarted.length} not started: ${unstarted.slice(0, 6).join(", ")}` +
        (unstarted.length > 6 ? `, and ${unstarted.length - 6} more` : "") +
        `\nRaise ${CLI_LIMIT_VARS.listCap} — this list wants about ` +
        `$${Math.ceil(todo.length * 3.736 + CONCURRENCY * (RUN_CAP_USD ?? 0))} to be sure of finishing in one ` +
        `go — or just resume, as often as it takes.`,
    )
  }
  console.log(`\nresume with:  npx tsx scripts/batch.ts ${listPath} --resume ${manifest}`)
}
// Non-zero when anything failed, so a wrapper or a cron job can tell.
//
// A DOMAIN THAT WAS NEVER STARTED IS NOT A FAILURE. A batch that stopped at its
// own budget did exactly what it was told to do, and its unstarted domains are
// not in `failed` — so a nightly wrapper is not paged for a limit working. A
// domain that STARTED and hit the per-run cap without producing a map is
// counted, because from here that domain has no map, which is the question this
// exit code answers.
process.exit(failed.length ? 1 : 0)

}
