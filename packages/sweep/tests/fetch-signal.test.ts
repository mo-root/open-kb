import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Every fetch the sweep makes hears the run's cancel.
 *
 * The fetch port bounds a request by the signal its CALLER hands over — the
 * unlocked path has no deadline of its own beyond a two-minute backstop,
 * because 33-60s is a legitimate unlocked fetch. So a caller that drops the
 * signal is a caller whose paid fetches answer to nothing: the sweep checks
 * `signal?.aborted` at four checkpoints and on every model call, but a
 * checkpoint only stops the NEXT thing. The unlocker call already in flight
 * kept its socket, and its charge, until it finished on its own. That is the
 * gap `web/lib/runs.ts` names in as many words: "cancel and destroy were the
 * same button".
 *
 * This is a SOURCE pin rather than a behavioural one, deliberately. Reaching
 * `sweep()`'s fetches at runtime means standing up a model, four prompts and a
 * whole wave; the property being defended is one line wide and lives at a call
 * site, so the call site is what gets read. It fails the moment someone adds a
 * fetch without a signal, which is exactly how the two here were written.
 */
function sweepSource(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const p = join(dir, "src", "sweep.ts")
    try {
      return readFileSync(p, "utf8")
    } catch {
      dir = dirname(dir)
    }
  }
  throw new Error("no sweep.ts")
}

describe("the sweep's fetches carry the run's signal", () => {
  it("passes a signal at every call into the fetch port", () => {
    const src = sweepSource()
    // `[^)]*` stops at the first `)`, which is the call's own — the argument
    // lists here are urls, string literals and an options object, none of which
    // contain one.
    const callSites = [...src.matchAll(/fetcher\.get\(([^)]*)\)/g)].map((m) => m[1]!)
    // If this drops to zero the pin has stopped watching anything, which is a
    // worse failure than a missed signal because it is silent.
    expect(callSites.length).toBeGreaterThanOrEqual(2)
    for (const args of callSites) expect(args).toContain("signal")
  })

  it("takes that signal from the run, not from a fresh controller of its own", () => {
    // A cancel is the caller's to trigger. A signal the sweep minted itself
    // would satisfy the pin above and stop nothing.
    const src = sweepSource()
    expect(src).not.toMatch(/new AbortController\(\)/)
    expect(src).toMatch(/^\s*signal\?:\s*AbortSignal/m)
  })
})
