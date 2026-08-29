import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Five constants in `packages/sweep/src/sweep.ts` — `CALL_TIMEOUT_MS` (603),
 * `UNDERSTAND_CALL_TIMEOUT_MS` (629), `LINK_CALL_TIMEOUT_MS` (644),
 * `RANK_CALL_TIMEOUT_MS` (658) and `LANDING_GRACE_MS` (537) — are five
 * separate, hand-copied `Math.max(floor, Number(process.env.OPENKB_X ??
 * fallback) || fallback)` expressions, the same shape `UNDERSTAND_ASKS` and
 * `MODEL_HOST_IGNORE` already have dedicated tests for
 * (understand-asks-reads-its-own-env-var.test.ts,
 * model-host-ignore-reads-its-own-env-var.test.ts) but these five did not:
 * `grep -rn "OPENKB_CALL_TIMEOUT_MS\|OPENKB_UNDERSTAND_CALL_TIMEOUT_MS\|
 * OPENKB_LINK_CALL_TIMEOUT_MS\|OPENKB_RANK_CALL_TIMEOUT_MS\|
 * OPENKB_LANDING_GRACE_MS" packages/sweep/tests/*.ts` before this file
 * matched nothing, for any of the five. Coverage gap found sweeping
 * `packages/sweep/src/sweep.ts`'s own env-derived constants (D-scope: "areas
 * nobody has swept") once the OPENKB_ vocabulary already named in earlier
 * SELF items was cross-checked against `packages/sweep/tests/*.ts`.
 *
 * The four timeout constants gate the model calls a run makes by the
 * thousand (`RANK_CALL_TIMEOUT_MS`'s own comment: 1,531 rank calls on one
 * run) down to the one call nothing downstream can recover from
 * (`UNDERSTAND_CALL_TIMEOUT_MS`'s own comment: "the ONLY call with no
 * fail-open anywhere downstream"), so a broken parse here changes how long a
 * run waits on a hung socket everywhere in the pipeline at once, silently.
 *
 * Same two traps `scripts/spend-caps.ts` and `UNDERSTAND_ASKS`'s own test
 * already argue against, now pinned on all five instead of assumed to carry
 * over: `"0" || fallback` reads an explicit "0" as unset rather than as
 * "wait zero milliseconds", because 0 is falsy in JS; and a negative string
 * is truthy, so it reaches `Math.max` as a real number and clamps to the
 * floor rather than being refused. `LANDING_GRACE_MS`'s floor is 0, unlike
 * the four timeouts' shared 1_000 — its own comment allows "proceeds on
 * what it has" immediately — so the sub-floor-clamp case only applies to the
 * four with a positive floor.
 *
 * Fresh import per case, same shape as `understand-asks-reads-its-own-env-var.test.ts`:
 * vitest caches modules, and every one of these constants is read once at
 * import time, so `vi.resetModules()` before each re-import is the only way
 * to see a second env value take effect.
 */

const CONSTANTS = [
  { name: "CALL_TIMEOUT_MS", envVar: "OPENKB_CALL_TIMEOUT_MS", floor: 1_000, fallback: 60_000 },
  {
    name: "UNDERSTAND_CALL_TIMEOUT_MS",
    envVar: "OPENKB_UNDERSTAND_CALL_TIMEOUT_MS",
    floor: 1_000,
    fallback: 180_000,
  },
  { name: "LINK_CALL_TIMEOUT_MS", envVar: "OPENKB_LINK_CALL_TIMEOUT_MS", floor: 1_000, fallback: 60_000 },
  { name: "RANK_CALL_TIMEOUT_MS", envVar: "OPENKB_RANK_CALL_TIMEOUT_MS", floor: 1_000, fallback: 30_000 },
  { name: "LANDING_GRACE_MS", envVar: "OPENKB_LANDING_GRACE_MS", floor: 0, fallback: 45_000 },
] as const

async function load(name: (typeof CONSTANTS)[number]["name"]): Promise<number> {
  vi.resetModules()
  const mod = await import("../src/sweep.js")
  return mod[name] as number
}

describe.each(CONSTANTS)("$name reads $envVar", ({ name, envVar, floor, fallback }) => {
  const original = process.env[envVar]

  afterEach(() => {
    if (original === undefined) delete process.env[envVar]
    else process.env[envVar] = original
  })

  it(`defaults to ${fallback} when the variable is unset`, async () => {
    delete process.env[envVar]
    expect(await load(name)).toBe(fallback)
  })

  it("reads an explicit value that clears the floor", async () => {
    const value = fallback + 12_345
    process.env[envVar] = String(value)
    expect(await load(name)).toBe(value)
  })

  it(`falls back to ${fallback} on a non-numeric value, not to the floor`, async () => {
    process.env[envVar] = "many"
    expect(await load(name)).toBe(fallback)
  })

  it(`falls back to ${fallback} on an explicit "0" -- the \`|| fallback\` guard reads it like unset`, async () => {
    process.env[envVar] = "0"
    expect(await load(name)).toBe(fallback)
  })

  it(`clamps a negative value up to the ${floor} floor rather than refusing it`, async () => {
    process.env[envVar] = "-500"
    expect(await load(name)).toBe(floor)
  })

  if (floor > 0) {
    it(`clamps a positive value under the floor up to ${floor}`, async () => {
      process.env[envVar] = String(floor - 1)
      expect(await load(name)).toBe(floor)
    })
  }
})
