import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * spend-limits.ts:726-727's ternary — `claim.kind === "unconfigured" ? "spend
 * limits are on and no store is configured" : ...` — had never run.
 *
 * NOT REACHABLE THROUGH spendGate AS SHIPPED, and that is worth writing down
 * rather than guessing past. `spendGate` only calls `db.claimRun` when
 * `db.configured()` already read true (spend-limits.ts:697), and `claimRun`'s
 * own `{kind: "unconfigured"}` returns (store/supabase.ts:250, 268) both read
 * that exact same `configured()` synchronously, with no `await` between
 * spendGate's check and either of them — so on every call the two reads agree
 * and this ternary's left arm is dead code today, confirmed by grep: spendGate
 * is claimRun's only caller. It exists as a fail-closed backstop for a caller
 * that does not check `db.configured()` first, or a future one that races it
 * across an await — exactly the shape store/supabase.test.ts's own "unconfigured
 * without a round trip" test pins for claimRun in isolation, one layer down.
 *
 * So this test pins the OTHER layer: the sentence spendGate writes to the log
 * once a claim comes back "unconfigured", isolated by mocking db.claimRun to
 * return it directly — the only way to drive that arm without an actual race.
 */

const hoisted = vi.hoisted(() => ({ result: { kind: "unconfigured" as const } }))

vi.mock("./store/supabase", async (importOriginal) => {
  const real = await importOriginal<typeof import("./store/supabase")>()
  return {
    ...real,
    configured: () => true,
    claimRun: async () => hoisted.result,
  }
})

const { spendGate } = await import("./spend-limits")

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("spendGate fails closed with the right sentence when the store claims 'unconfigured'", () => {
  it("logs 'no store is configured', not the generic 'cannot claim a run' text", async () => {
    const verdict = await spendGate({
      id: "run-unconfigured",
      domain: "meterco.example",
      headers: new Headers({ "x-real-ip": "203.0.113.9" }),
      budgetQueries: 18,
      runWindowMs: 300_000,
      aboutSeconds: 250,
      now: Date.parse("2026-08-27T12:00:00Z"),
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.status).toBe(503)
    expect(verdict.log).toBe("spend limits are on and no store is configured")
    // The OTHER arm of the same ternary, so a change that flips the condition
    // would fail this test rather than just losing coverage of it.
    expect(verdict.log).not.toContain("cannot claim a run")
  })
})
