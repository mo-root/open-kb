import { describe, it, expect, beforeAll } from "vitest"
import { HOSTS, SERP, costOf, defaultScript, lineOf, runFixture, type Harness } from "./fixture.js"

/**
 * WHAT THE ENGINE PROMISED ITS PORTS, AND WHAT IT PROMISED THE RUN.
 *
 * `SearchPort` says a per-query failure is reported inside that query's own row
 * and must never reject the batch. That is a contract with two ends, and only
 * the port's end has ever been tested: `@open-kb/providers` proves it RETURNS
 * `ok: false` on one row, and nothing proved the engine SURVIVES receiving one.
 * On a live sweep the difference is a whole run — every query already bought,
 * every page already read, discarded because one SERP call came back refused.
 *
 * The same shape one layer up: a classify call that throws must cost its host a
 * downgrade and nothing else, because a rank pool that rejects takes every
 * entity already judged with it.
 *
 * And the promise in the other direction: every fetch the run makes carries the
 * run's `AbortSignal`. `fetch-signal.test.ts` beside this file pins that by
 * reading the call sites, and says in as many words that it is a source pin
 * because "reaching `sweep()`'s fetches at runtime means standing up a model,
 * four prompts and a whole wave". That is what the fixture does, so the runtime
 * half exists now — and it reaches the rank phase's fetches, which the source
 * grep counts but no running test had ever exercised.
 */

describe("one refused query does not sink the wave", () => {
  let h: Harness
  const REFUSED = "log search"

  beforeAll(async () => {
    h = await runFixture({ failing: [REFUSED] })
  }, 30_000)

  it("finishes the run, and keeps every host the other queries found", () => {
    expect(h.result.entities.length).toBeGreaterThan(0)
    // The refused query was the only route to `walled.example`, so its absence
    // is the proof the refusal was real rather than quietly retried.
    expect(h.result.entities.map((e) => e.domain)).not.toContain(HOSTS.walled)
    for (const host of [HOSTS.grepstack, HOSTS.tailwatch, HOSTS.loglens, HOSTS.forum]) {
      expect(h.result.entities.map((e) => e.domain)).toContain(host)
    }
    // Every hit from every query except the refused one.
    const expected = h.asked
      .filter((q) => q !== REFUSED)
      .reduce((n, q) => n + (SERP[q]?.length ?? 0), 0)
    expect(h.result.report.results).toBe(expected)
  })

  it("bills the refusal as a failure, at nothing, and still counts the request", () => {
    const serp = lineOf(costOf(h.result).byKind, "serp")
    expect(serp.failures).toBe(1)
    expect(serp.calls).toBe(h.asked.length)
    // A SERP call that never reached the provider carries `usd: 0`. This is
    // exactly why the total may not be re-derived as `serpCalls × price`: that
    // arithmetic charges the run for a request nobody served.
    expect(serp.usd).toBeCloseTo((h.asked.length - 1) * 0.001, 9)
    expect(h.result.stats.serpCalls).toBe(h.asked.length * 2)
  })

  it("puts the refusal on the trace, named, so it is not merely a smaller number", () => {
    const refused = h.spans.filter((s) => s.kind === "search" && !s.ok)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.argsDigest).toBe(REFUSED)
    expect(refused[0]!.error).toBeTruthy()
    expect(refused[0]!.usd).toBe(0)
  })
})

describe("one host's model call throwing does not lose the pool", () => {
  let h: Harness

  beforeAll(async () => {
    const base = defaultScript()
    h = await runFixture({
      script: {
        classify: (host, prompt) => {
          if (host === HOSTS.tailwatch) throw new Error("the provider hung up")
          return base.classify(host, prompt)
        },
      },
    })
  }, 30_000)

  it("keeps the host, wearing the refusal, and keeps every host judged beside it", () => {
    const t = h.result.entities.find((e) => e.domain === HOSTS.tailwatch)
    expect(t).toBeDefined()
    // Downgraded, not deleted. A reader can finish an unknown and cannot
    // correct a host that silently vanished.
    expect(t!.kind).toBe("unknown")
    expect(t!.relation).toBe("unknown")
    expect(t!.because).toContain("the model call failed")
    expect(t!.settledBy).toBe("model")
    // The other four still landed with real judgements.
    expect(h.result.entities.filter((e) => e.settledBy === "model" && e.kind !== "unknown")).toHaveLength(4)
  })

  it("bills the failed call as a failure at nothing", () => {
    const rank = lineOf(costOf(h.result).byAgent, "rank")
    expect(rank.failures).toBeGreaterThanOrEqual(1)
    const failed = h.spans.filter((s) => s.kind === "model" && !s.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.usd).toBe(0)
    expect(failed[0]!.argsDigest).toBe(`classify ${HOSTS.tailwatch}`)
  })
})

describe("the fetches the run makes", () => {
  let h: Harness

  beforeAll(async () => {
    h = await runFixture()
  }, 30_000)

  it("every one of them carries the run's own signal, the rank pool's included", () => {
    // The source pin next door counts two call sites in `sweep.ts`. This counts
    // the calls, which is a larger set: the anchor's surfaces, the sitemap and
    // nav probes, the product pages, and one front page per candidate host —
    // that last group goes through `judgeHosts`, which the grep cannot see into
    // at all. A signal dropped anywhere on that path leaves a paid fetch
    // answering to nothing when the run is cancelled.
    expect(h.fetch.calls.length).toBeGreaterThan(8)
    for (const c of h.fetch.calls) expect(c.signal).toBeInstanceOf(AbortSignal)
    expect(h.fetch.calls.length).toBeGreaterThan(0)
    expect(h.fetch.calls.every((c) => c.signal!.aborted === false)).toBe(true)
  })

  it("never reaches for the unlocker while a direct read is answering", () => {
    // ~$0.008 and 13-16 seconds each. The unlocked path is a fallback for a
    // site that refuses an anonymous GET, and this anchor does not.
    expect(h.fetch.calls.length).toBeGreaterThan(0)
    expect(h.fetch.calls.every((c) => c.mode === "direct")).toBe(true)
    expect(h.result.stats.unlockerCalls).toBe(0)
  })

  it("settles an unreadable host by predicate, for nothing, without asking a model", () => {
    // `walled.example` has no row in the fetch table, so its front page 404s.
    // A host the run cannot read is a fact about the host, and paying a model
    // to look at an empty string would be paying for an invention.
    const walled = h.result.entities.find((e) => e.domain === HOSTS.walled)
    expect(walled!.settledBy).toBe("predicate")
    expect(walled!.unreadableReason).toBe("http-404")
    expect(h.calls.some((c) => c.phase === "classify" && c.subject === HOSTS.walled)).toBe(false)
    const kernel = h.result.report.kernel as { settledFree: number; modelJudged: number; unreadable: number }
    expect(kernel.settledFree).toBe(1)
    expect(kernel.unreadable).toBe(1)
    expect(kernel.modelJudged).toBe(5)
  })
})
