/**
 * Many maps, unattended.
 *
 * Usage:  set -a && . ./.env && set +a && npx tsx scripts/batch.ts scripts/gallery-domains.txt
 *         npx tsx scripts/batch.ts list.txt --concurrency 2 --queries 60 --timeout 1800
 *         npx tsx scripts/batch.ts list.txt --resume runs/batch-20260810T151102.jsonl
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

interface Outcome {
  anchor: string
  ok: boolean
  /** Why it failed, in one line, or the run file it wrote. */
  detail: string
  seconds: number
  usd: number | null
  attempt: number
  at: string
}

/** `min` is 1 for the flags where zero is meaningless — no concurrency is no
 *  work, no timeout is an instant kill — and 0 for `--retries`, where "do not
 *  retry" is a real thing to ask for and was refused by a blanket `n <= 0`. */
function flag(name: string, fallback: number, min = 1): number {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const raw = process.argv[at + 1]
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || !Number.isInteger(n)) {
    console.error(
      `--${name} needs a whole number ${min === 0 ? "of 0 or more" : "of 1 or more"}, got ${JSON.stringify(raw ?? "")}`,
    )
    process.exit(2)
  }
  return n
}

function stringFlag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : (process.argv[at + 1] ?? null)
}

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
const QUERIES = stringFlag("queries")

/**
 * The outer wall clock, per run, in seconds.
 *
 * Thirty minutes. The slowest sweep in `runs/` finished at 1,599 seconds
 * (shopify.com, 4,251 entities) and the median is about 500, so this clears the
 * worst real run by roughly 12%. It is a backstop for a process that stopped
 * making progress, not a budget: a run killed here has already spent its money
 * and produced nothing, which is exactly why it is set above the slowest thing
 * that has ever legitimately finished rather than at a round number.
 */
const TIMEOUT_S = flag("timeout", 1800)

const RETRIES = flag("retries", 1, 0)

const anchors = readFileSync(listPath, "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)

if (!anchors.length) {
  console.error(`${listPath} has no domains in it`)
  process.exit(2)
}

const seen = new Set<string>()
const queue = anchors.filter((a) => (seen.has(a) ? false : (seen.add(a), true)))
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
const resumeFrom = stringFlag("resume")
const alreadyDone = new Set<string>()
if (resumeFrom) {
  if (!existsSync(resumeFrom)) {
    console.error(`no such manifest: ${resumeFrom}`)
    process.exit(2)
  }
  for (const line of readFileSync(resumeFrom, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Outcome
      if (o.ok) alreadyDone.add(o.anchor)
    } catch {
      // A half-written last line is what a killed batch leaves. Skip it rather
      // than refusing to resume over one truncated record.
    }
  }
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")
const manifest = resumeFrom ?? `runs/batch-${stamp}.jsonl`

const todo = queue.filter((a) => !alreadyDone.has(a))
console.log(
  `${todo.length} to build` +
    (alreadyDone.size ? `, ${alreadyDone.size} already done` : "") +
    ` · ${CONCURRENCY} at a time · ${TIMEOUT_S}s cap each · manifest ${manifest}`,
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

      let usd: number | null = null
      if (mine) {
        try {
          const d = JSON.parse(readFileSync(`runs/${mine}`, "utf8")) as { stats?: { usd?: number } }
          usd = typeof d.stats?.usd === "number" ? d.stats.usd : null
        } catch {
          // A truncated file is a failed run wearing a filename. Left null, and
          // `ok` below is false because there is no readable map.
        }
      }

      // WROTE A READABLE MAP, not "exited zero". A sweep that throws after
      // writing is still a map, and one that exits zero having written nothing
      // is not — the second is what a killed process looks like from here.
      const ok = Boolean(mine) && usd !== null
      resolve({
        anchor,
        ok,
        detail: ok
          ? `runs/${mine}`
          : killed
            ? `killed at the ${TIMEOUT_S}s cap`
            : `exit ${code}${tail.trim() ? ` — ${tail.trim().split("\n").slice(-3).join(" / ")}` : ""}`,
        seconds,
        usd,
        attempt,
        at: new Date().toISOString(),
      })
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

async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++
    if (i >= todo.length) return
    const anchor = todo[i]!
    let out = await runOne(anchor, 1)
    for (let attempt = 2; !out.ok && attempt <= RETRIES + 1; attempt++) {
      console.log(`  ${anchor} failed (${out.detail}) — retry ${attempt - 1} of ${RETRIES}`)
      out = await runOne(anchor, attempt)
    }
    outcomes.push(out)
    spent += out.usd ?? 0
    appendFileSync(manifest, `${JSON.stringify(out)}\n`)
    const n = outcomes.length
    const failed = outcomes.filter((o) => !o.ok).length
    console.log(
      `[${n}/${todo.length}] ${out.ok ? "ok  " : "FAIL"} ${anchor.padEnd(24)} ` +
        `${String(out.seconds).padStart(5)}s ${out.usd === null ? "     —" : `$${out.usd.toFixed(3)}`}` +
        `  ·  $${spent.toFixed(2)} spent, ${failed} failed`,
    )
  }
}

const startedAt = Date.now()
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()))

const failed = outcomes.filter((o) => !o.ok)
console.log(`\n${"=".repeat(78)}`)
console.log(
  `${outcomes.length - failed.length}/${outcomes.length} built · $${spent.toFixed(2)} · ` +
    `${Math.round((Date.now() - startedAt) / 60000)} minutes`,
)
if (failed.length) {
  console.log(`\n${failed.length} failed:`)
  for (const f of failed) console.log(`  ${f.anchor.padEnd(24)} ${f.detail}`)
  console.log(`\nresume with:  npx tsx scripts/batch.ts ${listPath} --resume ${manifest}`)
}
// Non-zero when anything failed, so a wrapper or a cron job can tell.
process.exit(failed.length ? 1 : 0)
