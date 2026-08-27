import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LIMIT_VARS, noteRunEnded, resetLedger, spendGate } from "@/lib/spend-limits"

/**
 * `noteRunStarted` (via `spendGate`'s in-memory path) and `noteRunEnded` had no
 * direct test of their own: `app/api/map/limits.test.ts` drives them through
 * the real `POST /api/map` route with a fake engine, which proves the day cap
 * holds up end to end but never isolates the ledger pair itself. Found sweeping
 * D-scope ("areas nobody has swept" — this file — for a coverage gap), the same
 * class of gap as SELF-112's stream route test: other suites exercise the
 * surface around a function without ever pinning the function's own contract.
 *
 * The contract worth pinning: a running entry holds the FULL run cap against
 * the day budget (`count()`'s `spentUsd += capUsd ?? 0` for a `status:
 * "running"` row, in this same file), and `noteRunEnded` is what turns that
 * hold into the run's real, usually smaller, cost. Without a test calling
 * `noteRunEnded` directly, a change that stopped wiring it to the ledger (or
 * settled the wrong id) would leave every run permanently held at its cap and
 * only fail as an eventually-exhausted day budget in production.
 */
describe("a run reserves its ledger entry at the cap and settles it at cost", () => {
  const headers = new Headers({ "x-real-ip": "203.0.113.50" })
  const T0 = Date.parse("2026-08-27T12:00:00Z")

  beforeEach(() => {
    resetLedger()
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
    process.env[LIMIT_VARS.runCap] = "0.30"
    process.env[LIMIT_VARS.dayCap] = "0.35"
    process.env[LIMIT_VARS.perVisitor] = "off"
    process.env[LIMIT_VARS.atOnce] = "off"
  })

  afterEach(() => {
    delete process.env[LIMIT_VARS.runCap]
    delete process.env[LIMIT_VARS.dayCap]
    delete process.env[LIMIT_VARS.perVisitor]
    delete process.env[LIMIT_VARS.atOnce]
  })

  const claim = (id: string, now: number) =>
    spendGate({ id, domain: "meterco.example", headers, budgetQueries: 18, runWindowMs: 300_000, aboutSeconds: 250, now })

  it("holds a running claim at the full run cap, then frees it to the settled cost", async () => {
    const first = await claim("run-1", T0)
    expect(first.ok).toBe(true)

    // run-1 is still "running": count() charges its FULL $0.30 cap against the
    // $0.35 day budget, so a second concurrent claim has only $0.05 left — not
    // enough to reserve another $0.30 — and is refused.
    const whileRunning = await claim("run-2", T0 + 1_000)
    expect(whileRunning.ok).toBe(false)
    if (!whileRunning.ok) {
      expect(whileRunning.status).toBe(429)
      expect(whileRunning.log).toContain(LIMIT_VARS.dayCap)
    }

    // Settling run-1 at its real, much smaller cost frees the difference back
    // to the day budget: $0.05 (settled) + $0.30 (this claim's own reserve) =
    // $0.35, exactly at the cap.
    noteRunEnded("run-1", 0.05)
    const afterSettle = await claim("run-3", T0 + 2_000)
    expect(afterSettle.ok).toBe(true)
  })

  it("is a no-op for an id nothing reserved, rather than throwing or fabricating an entry", () => {
    expect(() => noteRunEnded("nobody-claimed-this-id", 0.05)).not.toThrow()
  })
})
