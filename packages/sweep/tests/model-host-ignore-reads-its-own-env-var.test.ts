import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `MODEL_HOST_IGNORE` (packages/sweep/src/sweep.ts:583) is computed once, at
 * module load, from `process.env.OPENKB_MODEL_HOST_IGNORE` — and had never
 * been exercised under any value of that variable: `grep -rn
 * "OPENKB_MODEL_HOST_IGNORE\|MODEL_HOST_IGNORE" packages/sweep/tests/*.ts`
 * before this file matched nothing. The comment above it calls out that
 * Wafer alone collapsed a fifty-product `understandByCall` answer to one
 * ("14, then 1, then 19" across three identical asks), and Baidu answered
 * 3 of 6 valid on the real catalog call — this is the list `openrouterOpts`
 * feeds the provider as `ignore`, so a broken split/trim/lowercase here
 * would silently stop excluding a host measured to corrupt answers.
 *
 * Same fresh-import-per-case shape as
 * `understand-asks-reads-its-own-env-var.test.ts`: vitest caches modules,
 * and this constant is read once at import time, so `vi.resetModules()`
 * before each re-import is the only way to see a second env value take
 * effect.
 */
async function loadModelHostIgnore() {
  vi.resetModules()
  const mod = await import("../src/sweep.js")
  return mod.MODEL_HOST_IGNORE
}

const ENV_VAR = "OPENKB_MODEL_HOST_IGNORE"

describe("MODEL_HOST_IGNORE", () => {
  const original = process.env[ENV_VAR]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR]
    else process.env[ENV_VAR] = original
  })

  it("defaults to baidu and wafer when the variable is unset", async () => {
    delete process.env[ENV_VAR]
    expect(await loadModelHostIgnore()).toEqual(["baidu", "wafer"])
  })

  it("reads a single replacement host", async () => {
    process.env[ENV_VAR] = "groq"
    expect(await loadModelHostIgnore()).toEqual(["groq"])
  })

  it("splits a comma-separated list", async () => {
    process.env[ENV_VAR] = "groq,mistral,cerebras"
    expect(await loadModelHostIgnore()).toEqual(["groq", "mistral", "cerebras"])
  })

  it("trims whitespace around each entry", async () => {
    process.env[ENV_VAR] = " groq , mistral "
    expect(await loadModelHostIgnore()).toEqual(["groq", "mistral"])
  })

  it("lowercases every entry, so an operator's casing can't create a silent miss", async () => {
    process.env[ENV_VAR] = "Baidu,WAFER"
    expect(await loadModelHostIgnore()).toEqual(["baidu", "wafer"])
  })

  it("drops empty entries from a trailing comma or blank segment", async () => {
    process.env[ENV_VAR] = "groq,,mistral,"
    expect(await loadModelHostIgnore()).toEqual(["groq", "mistral"])
  })

  it("empty string clears the list rather than falling back to the default", async () => {
    // Unlike UNDERSTAND_ASKS's `?? 3`, this reads `?? "baidu,wafer"` — only
    // an UNSET variable falls back. An explicit empty string is a real
    // value that reaches `.split(",")`, and `filter(Boolean)` then drops
    // the one resulting empty segment, so the operator's "ignore nobody"
    // is honoured rather than silently reverting to the two defaults.
    process.env[ENV_VAR] = ""
    expect(await loadModelHostIgnore()).toEqual([])
  })
})
