/**
 * What a CLI prints when the run dies, instead of a stack trace into node_modules.
 *
 * Measured, on a real run: `pnpm sweep posthog.com` read the company's own site
 * for $0.000, hit the first model call, and exited with 47 lines of
 * `AI_APICallError` pointing at `@ai-sdk/provider-utils/src/response-handler.ts`.
 * The actual sentence — "Insufficient credits" — was on line 39 of the dump,
 * inside a `responseBody` string. Everything a reader needed was there and
 * nothing was findable.
 *
 * This is not error handling. The engine already handles these: `sweep.ts`
 * bills the failed call, writes a `model` span carrying `error`, and rethrows.
 * This is only the last step — turning what escaped into a sentence, and
 * choosing an exit code a script can branch on.
 *
 * It deliberately does NOT catch and continue. A run that cannot reach the
 * model has nothing to say, and `overnight.ts` already refuses to start a run
 * that might be cut off mid-flight for exactly this reason: "a sweep cut off by
 * a 402 wastes everything it already bought."
 */

/** Exit codes a caller can branch on, rather than parsing the message. */
export const EXIT = {
  /** The provider refused for a reason spending money would fix. */
  credits: 3,
  /** The key is wrong, missing, or not entitled to the model. */
  auth: 4,
  /** Rate limited or overloaded — the same run might work later. */
  backoff: 5,
  /**
   * The run cost what one run is allowed to cost and was stopped at it. Not a
   * failure of the provider, the market or the code, and — unlike every other
   * code here — NOT SOMETHING TO RETRY: the next attempt spends the same cap to
   * reach the same place. `scripts/batch.ts` branches on exactly this to skip
   * its retry, which is why it is a code and not a message.
   */
  capped: 6,
  /** Anything else. */
  other: 1,
} as const

interface Known {
  code: number
  headline: string
  remedy?: string
}

/**
 * Match on the provider's own words, not on a status code we may not be handed.
 *
 * The AI SDK wraps the upstream response, so by the time it reaches here the
 * status may live in `.statusCode`, in `.data.error.code`, or only inside the
 * `responseBody` string. The message is the one field that survives every
 * wrapping, so it is what the patterns read — and each pattern is a phrase a
 * provider actually returns, not a guess at one.
 */
function classify(message: string, statusCode: number | undefined): Known {
  const m = message.toLowerCase()

  if (statusCode === 402 || m.includes("insufficient credits") || m.includes("insufficient_quota") || m.includes("exceeded your current quota")) {
    return {
      code: EXIT.credits,
      headline: "the model provider is out of credit",
      remedy: "Top up the account behind OPENROUTER_API_KEY, then run this again. Nothing was written; web fetches before the first model call are free.",
    }
  }
  if (statusCode === 401 || statusCode === 403 || m.includes("no auth credentials") || m.includes("invalid api key") || m.includes("unauthorized")) {
    return {
      code: EXIT.auth,
      headline: "the model provider rejected the key",
      remedy: "Check OPENROUTER_API_KEY is set and entitled to this model. The CLI reads it from the shell: `set -a && source .env && set +a`.",
    }
  }
  if (statusCode === 429 || m.includes("rate limit") || m.includes("overloaded") || m.includes("temporarily unavailable")) {
    return {
      code: EXIT.backoff,
      headline: "the model provider is rate limiting or overloaded",
      remedy: "The same run may work shortly. If it persists, lower OPENKB_RANK_CONCURRENCY.",
    }
  }
  if (m.includes("brightdata") || m.includes("zone") || m.includes("x-brd-error")) {
    return {
      code: EXIT.other,
      headline: "web access failed",
      remedy: "Check BRIGHTDATA_API_TOKEN and that both zones exist on the same account.",
    }
  }
  return { code: EXIT.other, headline: "the run failed" }
}

/**
 * Print the failure and exit. Never returns.
 *
 * The full error still reaches the operator, on stderr and behind a flag,
 * because a summary that hides the only copy of a novel failure is worse than
 * the stack trace it replaced.
 */
export function fatal(e: unknown, what: string): never {
  const err = e as { message?: string; statusCode?: number; cause?: unknown }
  const message = typeof err?.message === "string" ? err.message : String(e)
  const { code, headline, remedy } = classify(message, err?.statusCode)

  console.error(`\n${what} stopped: ${headline}.`)
  console.error(`  ${message.split("\n")[0]!.slice(0, 300)}`)
  if (remedy) console.error(`\n  ${remedy}`)
  if (process.env["OPENKB_TRACE"]) {
    console.error("\n--- full error (OPENKB_TRACE set) ---")
    console.error(e)
  } else {
    console.error("\n  Re-run with OPENKB_TRACE=1 for the full error.")
  }
  process.exit(code)
}
