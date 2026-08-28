import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `UNDERSTAND_ASKS` (packages/sweep/src/sweep.ts:546) is computed once, at
 * module load, from `process.env.OPENKB_UNDERSTAND_ASKS` — and had never been
 * exercised under any value of that variable: `grep -rn "OPENKB_UNDERSTAND_ASKS\|UNDERSTAND_ASKS"
 * packages/sweep/tests/*.ts` before this file matched nothing, and the
 * comment right above it calls this the count that "the whole run descends
 * from" (`understandByCall` reads the company once, and everything downstream
 * of the pipeline works from what that call decided the company sells).
 *
 * A fresh import per case, same shape as `packages/web/lib/store/supabase.test.ts`'s
 * own `load()` — vitest caches modules, and this constant is read once at
 * import time, so the only way to see a second env value take effect is
 * `vi.resetModules()` before each re-import.
 *
 * The expression itself chains three guards whose interaction is not obvious
 * from reading it once: `Number(env ?? 3) || 3` treats an explicit "0" the
 * same as unset (0 is falsy, so the `|| 3` fires) rather than honouring it,
 * and `Math.max(1, ...)` floors a negative value up to 1 rather than letting
 * it disable the call entirely. Both are locked here rather than left to be
 * discovered the next time someone reads this line.
 */
async function loadUnderstandAsks() {
  vi.resetModules()
  const mod = await import("../src/sweep.js")
  return mod.UNDERSTAND_ASKS
}

const ENV_VAR = "OPENKB_UNDERSTAND_ASKS"

describe("UNDERSTAND_ASKS", () => {
  const original = process.env[ENV_VAR]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR]
    else process.env[ENV_VAR] = original
  })

  it("defaults to 3 when the variable is unset", async () => {
    delete process.env[ENV_VAR]
    expect(await loadUnderstandAsks()).toBe(3)
  })

  it("reads a plain integer", async () => {
    process.env[ENV_VAR] = "5"
    expect(await loadUnderstandAsks()).toBe(5)
  })

  it("floors a fractional value", async () => {
    process.env[ENV_VAR] = "2.9"
    expect(await loadUnderstandAsks()).toBe(2)
  })

  it("falls back to 3 on a non-numeric value", async () => {
    process.env[ENV_VAR] = "many"
    expect(await loadUnderstandAsks()).toBe(3)
  })

  it("falls back to 3 on an explicit \"0\" -- the `|| 3` guard reads it like unset, not like disabled", async () => {
    process.env[ENV_VAR] = "0"
    expect(await loadUnderstandAsks()).toBe(3)
  })

  it("clamps a negative value up to 1, never asking zero or fewer times", async () => {
    process.env[ENV_VAR] = "-5"
    expect(await loadUnderstandAsks()).toBe(1)
  })

  it("restores the old single-ask behaviour at 1, the value the comment names by hand", async () => {
    process.env[ENV_VAR] = "1"
    expect(await loadUnderstandAsks()).toBe(1)
  })
})
