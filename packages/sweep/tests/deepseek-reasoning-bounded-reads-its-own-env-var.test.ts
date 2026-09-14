import { afterEach, describe, expect, it } from "vitest"
import { runFixture } from "./fixture.js"

/**
 * `reasoningFor` (sweep.ts:1989) has three outcomes, chosen by `modelId` and
 * `OPENKB_DEEPSEEK_REASONING`: non-DeepSeek gets `{ effort }`, DeepSeek gets
 * `{ enabled: false }` UNLESS the env var reads exactly `"bounded"`, which
 * swaps in `{ max_tokens: 200 }` — "the bake-off's contestant" the comment
 * beside it names but never runs anywhere.
 *
 * `modelId` defaults to `"fixture/mock"` in every other test in this suite
 * (`fixture.ts`'s own `runFixture`), so the whole `modelId.startsWith
 * ("deepseek/")` branch reads as dead from inside packages/sweep/tests alone.
 * It is not: `packages/web/app/api/map/budget.test.ts` and `limits.test.ts`
 * run the real engine through the route's own default modelId
 * (`"deepseek/deepseek-v4-flash"`, route.ts:494), which is how `{ enabled:
 * false }` already has 195 hits in a whole-suite coverage pass — but neither
 * file, nor anything else, ever sets `OPENKB_DEEPSEEK_REASONING`, so
 * `{ max_tokens: 200 }` had zero.
 *
 * Confirmed with a scoped v8 coverage run
 * (`npx vitest run --coverage --coverage.include=packages/sweep/src/sweep.ts
 * --coverage.reporter=json`, @vitest/coverage-v8@3.2.7 as a temporary local
 * devDependency, reverted after): line 1997 (`{ max_tokens: 200 }`) at 0 hits
 * against 2573 total `reasoningFor` calls across the whole suite; line 1998
 * (`{ enabled: false }`) at 195 of those, all with the var unset.
 *
 * Reached here through the full engine rather than by exporting the closure:
 * `modelId` and the env var are both free variables `call()` closes over, so
 * there is no seam to call `reasoningFor` directly, only what actually
 * reached the model — which is why `fixture.ts`'s mock now records
 * `providerOptions.openrouter` per call.
 */
describe("reasoningFor's DeepSeek 'bounded' branch", () => {
  const ENV_VAR = "OPENKB_DEEPSEEK_REASONING"
  const original = process.env[ENV_VAR]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR]
    else process.env[ENV_VAR] = original
  })

  it("caps reasoning at 200 tokens when the var reads 'bounded'", async () => {
    process.env[ENV_VAR] = "bounded"
    const h = await runFixture({ sweepOptions: { modelId: "deepseek/deepseek-v4-flash-0731" } })
    const understand = h.calls.find((c) => c.phase === "understand")
    expect(understand?.providerOptions?.reasoning).toEqual({ max_tokens: 200 })
  })

  it("still turns reasoning off outright when the var is unset — the branch this file's own comment says is the only one otherwise reached", async () => {
    delete process.env[ENV_VAR]
    const h = await runFixture({ sweepOptions: { modelId: "deepseek/deepseek-v4-flash-0731" } })
    const understand = h.calls.find((c) => c.phase === "understand")
    expect(understand?.providerOptions?.reasoning).toEqual({ enabled: false })
  })

  it("a non-DeepSeek model ignores the var entirely, even set to 'bounded'", async () => {
    process.env[ENV_VAR] = "bounded"
    const h = await runFixture({ sweepOptions: { modelId: "fixture/mock" } })
    const understand = h.calls.find((c) => c.phase === "understand")
    // understandOnce() (sweep.ts:2784) asks with `think: "medium"`, which
    // reasoningFor's non-DeepSeek arm passes straight through as `effort`.
    expect(understand?.providerOptions?.reasoning).toEqual({ effort: "medium" })
  })
})
