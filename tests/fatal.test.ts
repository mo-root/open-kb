import { describe, it, expect, vi, afterEach } from "vitest"
// Relative, not "@open-kb/core": the root package.json declares no dependency on
// either workspace package, so a bare specifier from here does not resolve — the
// same reason tests/export-target.test.ts imports scripts/ this way.
import { fatal, EXIT } from "../scripts/fatal.js"

/**
 * `fatal()` was written because a real run — `pnpm sweep posthog.com` — died with
 * 47 lines of `AI_APICallError` and the one sentence that mattered, "Insufficient
 * credits", buried on line 39 inside a `responseBody` string. It has never had a
 * test of its own: `classify()`'s branching (credits / auth / backoff / brightdata
 * / other) is exactly the logic that turns a wall of stack trace into that one
 * sentence, and until now nothing pinned which phrase lands in which bucket.
 *
 * `fatal()` calls `process.exit`, which vitest's own process cannot survive, so
 * every case here stubs `process.exit` and `console.error` rather than calling
 * through them — the same shape a caller in `scripts/sweep.ts` or
 * `scripts/swarm.ts` sees, minus the actual exit.
 */

function callFatal(e: unknown, what = "sweep"): { code: number | undefined; lines: string[] } {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
  fatal(e, what)
  const code = exitSpy.mock.calls[0]?.[0] as number | undefined
  const lines = errorSpy.mock.calls.map((c) => String(c[0]))
  return { code, lines }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env["OPENKB_TRACE"]
})

describe("fatal", () => {
  it("classifies a 402 as out of credit, by status code alone", () => {
    const { code, lines } = callFatal({ message: "Bad Request", statusCode: 402 })
    expect(code).toBe(EXIT.credits)
    expect(lines[0]).toContain("out of credit")
    expect(lines.join("\n")).toContain("OPENROUTER_API_KEY")
  })

  it("classifies a provider's own 'insufficient credits' wording with no status code", () => {
    // The measured bug: the AI SDK wraps the upstream response, so the status can
    // live only inside a `responseBody` string and never reach `.statusCode`.
    const { code, lines } = callFatal({ message: 'upstream said "Insufficient credits" for this account' })
    expect(code).toBe(EXIT.credits)
    expect(lines[0]).toContain("out of credit")
  })

  it("classifies OpenAI-shaped quota wording the same as credits", () => {
    expect(callFatal({ message: "You exceeded your current quota" }).code).toBe(EXIT.credits)
    expect(callFatal({ message: "insufficient_quota" }).code).toBe(EXIT.credits)
  })

  it("classifies a 401 or 403 as a rejected key, and names the fix", () => {
    const { code, lines } = callFatal({ message: "Forbidden", statusCode: 403 })
    expect(code).toBe(EXIT.auth)
    expect(lines[0]).toContain("rejected the key")
    expect(lines.join("\n")).toContain("OPENROUTER_API_KEY")

    expect(callFatal({ message: "Unauthorized", statusCode: 401 }).code).toBe(EXIT.auth)
    expect(callFatal({ message: "No auth credentials found" }).code).toBe(EXIT.auth)
    expect(callFatal({ message: "Invalid API key provided" }).code).toBe(EXIT.auth)
  })

  it("classifies a 429 or overload wording as backoff, not auth or credits", () => {
    const { code, lines } = callFatal({ message: "Too Many Requests", statusCode: 429 })
    expect(code).toBe(EXIT.backoff)
    expect(lines[0]).toContain("rate limiting or overloaded")
    expect(lines.join("\n")).toContain("OPENKB_RANK_CONCURRENCY")

    expect(callFatal({ message: "model is temporarily unavailable" }).code).toBe(EXIT.backoff)
  })

  it("classifies a Bright Data zone failure as web access, distinct from a model failure", () => {
    const { code, lines } = callFatal({ message: "x-brd-error: zone 'kb_unlocker' not found" })
    expect(code).toBe(EXIT.other)
    expect(lines[0]).toContain("web access failed")
    expect(lines.join("\n")).toContain("BRIGHTDATA_API_TOKEN")
  })

  it("falls back to a bare 'the run failed' for anything unrecognized, with no remedy line", () => {
    const { code, lines } = callFatal({ message: "ECONNRESET" })
    expect(code).toBe(EXIT.other)
    expect(lines[0]).toContain("the run failed")
    // No remedy paragraph: headline line, message line, and the trace hint only.
    expect(lines).toHaveLength(3)
  })

  it("names the caller in the headline, so a swarm failure doesn't read as a sweep failure", () => {
    const { lines } = callFatal({ message: "ECONNRESET" }, "swarm")
    expect(lines[0]).toBe("\nswarm stopped: the run failed.")
  })

  it("prints only the first line of the message, truncated to 300 chars", () => {
    const long = "x".repeat(400)
    const { lines } = callFatal({ message: `${long}\nsecond line never wanted here` })
    expect(lines[1]).toBe(`  ${"x".repeat(300)}`)
    expect(lines.join("\n")).not.toContain("second line")
  })

  it("handles a thrown value with no .message — a raw string or object — via String(e)", () => {
    const { code, lines } = callFatal("plain string throw")
    expect(code).toBe(EXIT.other)
    expect(lines[1]).toBe("  plain string throw")
  })

  it("hides the full error behind OPENKB_TRACE by default, and names the flag", () => {
    const { lines } = callFatal({ message: "ECONNRESET" })
    expect(lines.join("\n")).toContain("Re-run with OPENKB_TRACE=1")
    expect(lines.join("\n")).not.toContain("--- full error")
  })

  it("prints the full error when OPENKB_TRACE is set", () => {
    process.env["OPENKB_TRACE"] = "1"
    const { lines } = callFatal({ message: "ECONNRESET" })
    expect(lines.join("\n")).toContain("--- full error (OPENKB_TRACE set) ---")
    expect(lines.join("\n")).not.toContain("Re-run with OPENKB_TRACE=1")
  })
})
