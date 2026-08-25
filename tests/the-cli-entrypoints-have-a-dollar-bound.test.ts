import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SpanStream, tripAtUsd, withSpendCap, type Span, type SpendTrip } from "../packages/core/src/index.js"
import { EXIT } from "../scripts/fatal.js"
import {
  CLI_LIMIT_VARS,
  DEFAULT_LIST_CAP_USD,
  DEFAULT_RUN_CAP_USD,
  SWARM_CAP_HEADROOM,
  cappedReason,
  capUsdOrExit,
  listRoom,
  readCapUsd,
  stoppedRun,
} from "../scripts/spend-caps.js"

/**
 * THE THREE CLI ENTRYPOINTS ENFORCE A DOLLAR BOUND, and it is the right one.
 *
 * The web route has metered what it spends for a while: a per-run cap enforced
 * during the run, plus day, visitor and concurrency limits claimed in one
 * transaction. `scripts/` enforced NOTHING. The sweep said so in its own
 * comment — "There is no live ceiling here… the CLI has nothing like it at all"
 * — the swarm froze a ceiling into a ledger and never compared realized spend to
 * it, and the batch multiplied both by the length of a list.
 *
 * `packages/core/tests/a-cap-nobody-watches-is-not-a-cap.test.ts` proves the
 * watchdog stops a run and records it. This file is about the numbers that get
 * handed to it, which is where a cap is usually wrong: too tight and it fires on
 * healthy work, at which point the operator turns it off and there is no cap at
 * all.
 */

const RUNS = {
  /** The measured median CLI run at the current model and engine shape. */
  median: 1.386,
  /** The most expensive complete map on disk at the current model: shopify.com,
   *  251 queries, 1,599 seconds. */
  worst: 3.736,
  /** A cloudflare-shaped run projected forward past the product-funding fix. */
  projected: 5.37,
  /** The worst run on disk: brightdata.com, 63 queries, on a dear model. */
  worstEver: 6.8326,
  /** The other dear-model outlier: brightdata.com again, 4,195 seconds. */
  dearModelOutlier: 5.1512,
} as const

afterEach(() => {
  delete process.env[CLI_LIMIT_VARS.runCap]
  delete process.env[CLI_LIMIT_VARS.listCap]
})

describe("the per-run default clears every healthy run and still catches a runaway", () => {
  it("does not fire on any run this repo has actually completed", () => {
    // The trip point is what a run is stopped AT, so it is the number that has
    // to clear a healthy run — not the cap.
    const trip = tripAtUsd(DEFAULT_RUN_CAP_USD)
    expect(trip).toBeGreaterThan(RUNS.median)
    expect(trip).toBeGreaterThan(RUNS.worst)
    // With room: 61% above the worst real map.
    expect(trip / RUNS.worst).toBeGreaterThan(1.5)
  })

  it("does not fire on the biggest run the current engine is expected to produce", () => {
    // The measured runs are all from before every product the run finds started
    // getting asked about. A cap sized only against history would fire on the
    // first big market after the change — a healthy run killed at 90%, which
    // costs the map AND the money.
    expect(tripAtUsd(DEFAULT_RUN_CAP_USD)).toBeGreaterThan(RUNS.projected)
  })

  it("catches the worst run on disk before it finishes", () => {
    expect(tripAtUsd(DEFAULT_RUN_CAP_USD)).toBeLessThan(RUNS.worstEver)
  })

  it("does NOT catch the other dear-model outlier, and the comment says so", () => {
    // Pinned deliberately, because it is the limit of what this default can
    // claim — and the reason is not that $8 was chosen badly. That run cost
    // LESS than a healthy big-market run is projected to cost ($5.15 against
    // $5.37), so no dollar figure can separate the two: by the only measure this
    // watchdog has, a dear model spending $5.15 and the current model doing real
    // work are the same run. What separates them is the price per call, which is
    // why `OPENKB_CLI_RUN_CAP_USD` exists and why the comment defending this
    // default tells a dear-model operator to raise it.
    expect(tripAtUsd(DEFAULT_RUN_CAP_USD)).toBeGreaterThan(RUNS.dearModelOutlier)
    expect(RUNS.dearModelOutlier).toBeLessThan(RUNS.projected)
    expect(RUNS.dearModelOutlier).toBeLessThan(RUNS.worstEver)
  })

  it("is not the web route's number, and could not be", () => {
    // The web route caps a run at twice its expected cost, because `maxDuration`
    // tells it how big the run will be. Nothing tells the CLI: the engine deals
    // its own hand, and the runs on disk range from 6 to 324 queries. Twice the
    // median here would stop the worst healthy run at 74% done.
    expect(2 * RUNS.median).toBeLessThan(RUNS.worst)
  })

  it("gives the swarm a cap above its own ledger ceiling, not below it", () => {
    // The ledger is SUPPOSED to spend the whole ceiling — that is what a ceiling
    // is. A cap at or under it would fire on a run working exactly as designed,
    // which is the one thing a default must never do.
    for (const ceiling of [0.5, 1.5, 5]) {
      const cap = SWARM_CAP_HEADROOM * ceiling
      expect(tripAtUsd(cap)).toBeGreaterThan(ceiling)
    }
  })
})

describe("a cap an operator cannot act on is refused rather than ignored", () => {
  it("takes the default when nothing is set", () => {
    expect(readCapUsd(CLI_LIMIT_VARS.runCap, DEFAULT_RUN_CAP_USD)).toEqual({
      ok: true,
      capUsd: DEFAULT_RUN_CAP_USD,
    })
  })

  it("reads a number, and reads whitespace as nothing said", () => {
    process.env[CLI_LIMIT_VARS.runCap] = "12.5"
    expect(readCapUsd(CLI_LIMIT_VARS.runCap, 8)).toEqual({ ok: true, capUsd: 12.5 })
    // `Number(" ")` is 0, which as a cap means "abort on the first span". A stray
    // space in a shell profile must read as an operator who said nothing.
    process.env[CLI_LIMIT_VARS.runCap] = "  "
    expect(readCapUsd(CLI_LIMIT_VARS.runCap, 8)).toEqual({ ok: true, capUsd: 8 })
  })

  it("turns off only for a word, never for a number", () => {
    process.env[CLI_LIMIT_VARS.runCap] = "off"
    expect(readCapUsd(CLI_LIMIT_VARS.runCap, 8)).toEqual({ ok: true, capUsd: null })
    process.env[CLI_LIMIT_VARS.runCap] = "OFF"
    expect(readCapUsd(CLI_LIMIT_VARS.runCap, 8)).toEqual({ ok: true, capUsd: null })
  })

  it("refuses a value that is not a number, instead of silently having no cap", () => {
    // `Number("$5")` is NaN, and NaN fails every comparison — so the obvious
    // guard written against it waves the run through while the operator believes
    // they set a limit. That is not hypothetical: it is what `OPENKB_CEILING_USD`
    // did, and the reason this returns a refusal rather than a number.
    for (const bad of ["$5", "five", "5,00", "-3", "0"]) {
      process.env[CLI_LIMIT_VARS.runCap] = bad
      const reading = readCapUsd(CLI_LIMIT_VARS.runCap, 8)
      expect(reading.ok).toBe(false)
      if (!reading.ok) {
        expect(reading.why).toContain(CLI_LIMIT_VARS.runCap)
        // Their own value, quoted back, and the two ways out.
        expect(reading.why).toContain(JSON.stringify(bad))
        expect(reading.why).toContain('"off"')
      }
    }
  })
})

/**
 * `capUsdOrExit` is the ONLY caller of `readCapUsd` in all three CLI
 * entrypoints (`sweep.ts:155`, `swarm.ts:208`, `batch.ts:167-168`) — every
 * real run's dollar bound is decided by this function at module load, before
 * a single query fires. It had zero direct test coverage: the "three
 * entrypoints are actually wired to it" describe below only greps the
 * scripts' source for the call, which pins that the wiring exists but proves
 * nothing about what the function does when the reading it wraps is refused.
 * Coverage gap found sweeping `scripts/*.ts beyond sweep.ts` (D-scope: "areas
 * nobody has swept"). Same `spy process.exit and console.error` shape
 * `tests/fatal.test.ts` uses for the other CLI function that calls
 * `process.exit` directly, for the same reason: vitest's own process cannot
 * survive a real exit.
 */
describe("capUsdOrExit turns a refusal into the exit code a shell script can check", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the cap without touching process.exit when the reading is ok", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    process.env[CLI_LIMIT_VARS.runCap] = "12.5"
    expect(capUsdOrExit(CLI_LIMIT_VARS.runCap, 8)).toBe(12.5)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("returns the fallback, unmodified, when nothing is set", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    expect(capUsdOrExit(CLI_LIMIT_VARS.runCap, DEFAULT_RUN_CAP_USD)).toBe(DEFAULT_RUN_CAP_USD)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("returns null for the word that turns the cap off", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    process.env[CLI_LIMIT_VARS.runCap] = "off"
    expect(capUsdOrExit(CLI_LIMIT_VARS.runCap, 8)).toBeNull()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("exits 2 and prints readCapUsd's own refusal, verbatim, on an unreadable value", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    process.env[CLI_LIMIT_VARS.runCap] = "$5"

    capUsdOrExit(CLI_LIMIT_VARS.runCap, 8)

    expect(exitSpy).toHaveBeenCalledWith(2)
    const reading = readCapUsd(CLI_LIMIT_VARS.runCap, 8)
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(errorSpy).toHaveBeenCalledWith(reading.why)
  })
})

describe("the list cap counts the runs in flight, so it is a ceiling and not a hope", () => {
  const cap = { runCapUsd: DEFAULT_RUN_CAP_USD, listCapUsd: DEFAULT_LIST_CAP_USD }

  it("lets an empty list start", () => {
    expect(listRoom({ settledUsd: 0, inFlight: 0, ...cap }).ok).toBe(true)
  })

  it("holds a running domain at its cap rather than at zero", () => {
    // The failure this closes: two workers start, both read a spend of $0, and
    // the budget is committed twice over while every reading is individually
    // correct.
    // Room for one more run but not for two: the only thing that decides it is
    // whether the run already going is counted at zero or at what it may become.
    const settledUsd = DEFAULT_LIST_CAP_USD - 1.5 * DEFAULT_RUN_CAP_USD
    expect(listRoom({ settledUsd, inFlight: 0, ...cap }).ok).toBe(true)
    expect(listRoom({ settledUsd, inFlight: 1, ...cap }).ok).toBe(false)
  })

  it("stops a fifty-domain list before it spends a hundred dollars", () => {
    // The exposure, walked: fifty domains at the measured median is $69, and
    // nothing in the old file compared `spent` to anything.
    let settledUsd = 0
    let started = 0
    for (let i = 0; i < 50; i++) {
      if (!listRoom({ settledUsd, inFlight: 0, ...cap }).ok) break
      started++
      settledUsd += RUNS.median
    }
    expect(started).toBeLessThan(50)
    expect(settledUsd).toBeLessThanOrEqual(DEFAULT_LIST_CAP_USD)
    // And it got real work done first — this is a budget, not a refusal to run.
    expect(started).toBeGreaterThan(20)
  })

  it("never lets the settled total pass the cap, even at the worst run size", () => {
    let settledUsd = 0
    for (let i = 0; i < 200; i++) {
      if (!listRoom({ settledUsd, inFlight: 0, ...cap }).ok) break
      settledUsd += RUNS.worst
    }
    expect(settledUsd).toBeLessThanOrEqual(DEFAULT_LIST_CAP_USD)
  })

  it("holds the line with two workers interleaving, which is the default", async () => {
    // THE CASE THE RESERVATION EXISTS FOR. Two workers finish and start at
    // different moments, so there is always a window where one has committed
    // money that no reading can see yet. This mirrors the shape of the loop in
    // batch.ts — check, start, settle — and runs it against run costs that swing
    // between the cheapest and the dearest maps on disk.
    const costs = [0.0742, RUNS.worst, RUNS.median, 0.2829, RUNS.worst, RUNS.worst, 1.0566, RUNS.median]
    let settledUsd = 0
    let inFlight = 0
    let cursor = 0
    let stopped = false
    const done: number[] = []

    const worker = async () => {
      for (;;) {
        if (stopped || cursor >= 60) return
        if (!listRoom({ settledUsd, inFlight, ...cap }).ok) {
          stopped = true
          return
        }
        const cost = costs[cursor % costs.length]!
        cursor++
        inFlight++
        // The run: a real await, so the other worker gets to make its own
        // decision while this one is outstanding and uncounted.
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        settledUsd += cost
        done.push(cost)
      }
    }
    await Promise.all([worker(), worker()])

    expect(settledUsd).toBeLessThanOrEqual(DEFAULT_LIST_CAP_USD)
    expect(done.length).toBeGreaterThan(10)
    // The reservation is pessimistic by design — it holds two runs at $8 against
    // a list whose runs average nearer $2 — so it stops with money unspent. That
    // is the price of being a ceiling rather than a guess, and it is bounded:
    // never more than one whole reservation per worker.
    expect(DEFAULT_LIST_CAP_USD - settledUsd).toBeLessThanOrEqual(2 * DEFAULT_RUN_CAP_USD)
  })

  it("reports what is committed, so the operator is told why it stopped", () => {
    const room = listRoom({ settledUsd: 45, inFlight: 1, ...cap })
    expect(room.ok).toBe(false)
    if (!room.ok) expect(room.committedUsd).toBe(45 + DEFAULT_RUN_CAP_USD)
  })

  it("is off when it is off, and degrades honestly when the run cap is", () => {
    expect(listRoom({ settledUsd: 10_000, inFlight: 9, runCapUsd: 8, listCapUsd: null }).ok).toBe(true)
    // With no run cap there is nothing to reserve, so the list cap becomes a
    // check between domains rather than a ceiling — it still bounds, it just
    // cannot account for what is already running.
    expect(listRoom({ settledUsd: 49, inFlight: 5, runCapUsd: null, listCapUsd: 50 }).ok).toBe(true)
    expect(listRoom({ settledUsd: 51, inFlight: 0, runCapUsd: null, listCapUsd: 50 }).ok).toBe(false)
  })
})

describe("a run stopped at its cap is written down, not lost", () => {
  /** The composition both CLI entrypoints use: an engine that throws when it is
   *  aborted, the watchdog around it, and the record written once the engine has
   *  unwound and every span is in hand. */
  async function stoppedSweep(capUsd: number) {
    const spans = new SpanStream()
    const abort = new AbortController()
    const capStop: { trip: SpendTrip | null } = { trip: null }
    const engine = { running: true }

    const task = (async () => {
      for (let i = 0; i < 500; i++) {
        if (abort.signal.aborted) throw new Error("aborted")
        spans.emit({
          runId: "r",
          agentId: "rank",
          parentId: null,
          kind: "search",
          name: "serp",
          argsDigest: `q${i}`,
          ms: 1,
          ok: true,
          usd: 0.0086,
        })
        await new Promise((r) => setTimeout(r, 0))
      }
      return "a map"
    })()

    const out = await withSpendCap(
      task.finally(() => {
        engine.running = false
      }),
      {
        spans,
        capUsd,
        abort,
        stillRunning: () => engine.running,
        record: (trip) => {
          capStop.trip = trip
        },
      },
    ).catch(() => null)

    spans.close()
    const rows: Span[] = []
    for await (const s of spans.stream()) rows.push(s)
    return { out, capStop, spans, rows }
  }

  it("keeps the spans, the cost and a reason that names the cap", async () => {
    const { out, capStop, spans, rows } = await stoppedSweep(1)
    expect(out).toBeNull()
    expect(capStop.trip).not.toBeNull()

    const record = stoppedRun({
      engine: "sweep",
      domain: "resend.com",
      trip: capStop.trip!,
      finalUsd: spans.totalUsd(),
      seconds: 42,
      spans: rows,
    })

    // THE SPANS ARE THE POINT. They are the only record of what the money was
    // actually spent on, and a stop that dropped them would leave a bill with no
    // itemisation.
    expect(record.spans.length).toBe(rows.length)
    expect(record.spans.length).toBeGreaterThan(0)
    expect(record.stats.usd).toBeCloseTo(spans.totalUsd(), 10)

    // THE REASON NAMES THE CAP, what was spent, and the one setting that changes
    // the outcome — the same three things the web route puts in front of a
    // visitor.
    expect(record.stopped.by).toBe("run-cap")
    expect(record.stopped.reason).toContain("$1.00")
    expect(record.stopped.reason).toContain(CLI_LIMIT_VARS.runCap)
    expect(record.stopped.setting).toBe(CLI_LIMIT_VARS.runCap)
    expect(record.stopped.reason).toContain("the cap is deliberate")
    expect(record.domain).toBe("resend.com")
  })

  it("says the total, including what landed after the line was crossed", async () => {
    const { capStop, spans, rows } = await stoppedSweep(1)
    const record = stoppedRun({
      engine: "sweep",
      domain: "resend.com",
      trip: capStop.trip!,
      finalUsd: spans.totalUsd(),
      seconds: 1,
      spans: rows,
    })
    // `stopped.spentUsd` is the total at the trip; `stats.usd` is the final one.
    // Conflating them would understate the bill by whatever was in flight, which
    // is the exact quantity the reserve exists to cover.
    expect(record.stats.usd).toBeGreaterThanOrEqual(record.stopped.spentUsd)
    expect(record.stats.usd).toBeLessThanOrEqual(record.stopped.capUsd)
  })

  it("is not shaped like a map, so no reader adopts it as one", () => {
    // `adoptCliRun` in packages/web/lib/runs.ts turns any runs/*.json carrying an
    // `anchor` and an `entities` array into a gallery row. A stopped run has
    // neither, on purpose: an empty map of a market is a claim about the market.
    const record = stoppedRun({
      engine: "swarm",
      domain: "resend.com",
      trip: { capUsd: 3, tripUsd: 2.25, heldBackUsd: 0.75, spentUsd: 2.3 },
      finalUsd: 2.4,
      seconds: 10,
      spans: [],
    })
    expect(record).not.toHaveProperty("anchor")
    expect(record).not.toHaveProperty("entities")
  })

  it("keeps the swarm's own ending, which is the most useful thing it produces", () => {
    // `abortedEnd()` closes the books before it rejects and attaches a
    // `SwarmEnding` to the error: nodes, edges, realized spend, and the full
    // residue — precisely what would have been done next, ranked.
    const ending = { kind: "terminated", reason: "aborted", nodes: 12, residue: [1, 2, 3] }
    const record = stoppedRun({
      engine: "swarm",
      domain: "resend.com",
      trip: { capUsd: 3, tripUsd: 2.25, heldBackUsd: 0.75, spentUsd: 2.3 },
      finalUsd: 2.4,
      seconds: 10,
      spans: [],
      ending,
    })
    expect(record.ending).toEqual(ending)
  })

  it("survives the round trip through JSON, because that is how it is read", () => {
    const record = stoppedRun({
      engine: "sweep",
      domain: "resend.com",
      trip: { capUsd: 8, tripUsd: 6, heldBackUsd: 2, spentUsd: 6.02 },
      finalUsd: 6.1,
      seconds: 10,
      spans: [],
    })
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })

  it("reads the same for a swarm as for a sweep, naming the engine that stopped", () => {
    const trip = { capUsd: 3, tripUsd: 2.25, heldBackUsd: 0.75, spentUsd: 2.3 }
    expect(cappedReason(trip, "sweep")).toContain("the sweep was stopped")
    expect(cappedReason(trip, "swarm")).toContain("the swarm was stopped")
  })
})

describe("the three entrypoints are actually wired to it", () => {
  // A guard, not a proof. Each of these files does its work at module scope
  // against live credentials, so nothing here can import and drive them — and
  // the failure worth catching is not subtle logic but the wiring being removed
  // while the helper it calls stays behind, green and unreferenced. That is
  // exactly what `runs.test.ts` already does for the filename stamp these four
  // scripts share.
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), "utf8")

  it("caps a sweep run", () => {
    const src = source("sweep.ts")
    expect(src).toContain("withSpendCap(")
    expect(src).toContain("capUsd: RUN_CAP_USD")
    expect(src).toContain(`capUsdOrExit(CLI_LIMIT_VARS.runCap, DEFAULT_RUN_CAP_USD)`)
    // And ends the way a deliberate stop ends: a record on disk, then an exit
    // code that says "capped" rather than "broke".
    expect(src).toContain("stoppedRun({")
    expect(src).toContain("EXIT.capped")
  })

  it("caps a swarm run against its own ceiling", () => {
    const src = source("swarm.ts")
    expect(src).toContain("withSpendCap(")
    expect(src).toContain("capUsd: RUN_CAP_USD")
    expect(src).toContain("SWARM_CAP_HEADROOM * ceilingUsd")
    expect(src).toContain("stoppedRun({")
    expect(src).toContain("EXIT.capped")
  })

  it("caps a batch both per run and per list", () => {
    const src = source("batch.ts")
    // The per-run cap is the child's, inherited through the environment.
    expect(src).toContain("capUsdOrExit(CLI_LIMIT_VARS.runCap, DEFAULT_RUN_CAP_USD)")
    expect(src).toContain("capUsdOrExit(CLI_LIMIT_VARS.listCap, DEFAULT_LIST_CAP_USD)")
    // The per-list cap is this file's own, checked BEFORE a run is started.
    expect(src).toContain("listRoom({")
    // And a capped child is never retried: the retry costs another whole cap to
    // reach the same place.
    expect(src).toContain("!out.capped")
    expect(src).toContain("EXIT.capped")
  })

  it("agrees with the sweep about what a capped exit code is", () => {
    // The contract is a number crossing a process boundary, so it has to be the
    // same number on both sides and it must not collide with a real failure.
    expect(EXIT.capped).toBe(6)
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length)
  })
})
