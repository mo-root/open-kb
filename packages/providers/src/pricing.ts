/**
 * What each model charges, by OpenRouter id. This is the table — there is one.
 *
 * It lives at the vendor layer because that is what it is: a fact about a
 * vendor's price list, not about the engine. Core cannot host it even if that
 * were wanted — `scripts/check-core-purity.mjs` refuses the string "gemini"
 * anywhere in `packages/core`, and rightly, since the whole point of the
 * `ModelPricing` shape core declares is that the engine never learns whose
 * model it is running. Everything that needs a price already imports this
 * package for its Bright Data ports, so one home costs no new dependency
 * edge. Three copies cost a bill that is wrong by a factor of twenty.
 */
import type { ModelPricing } from "@open-kb/core"

/**
 * $/M tokens by OpenRouter id, every row re-checked against
 * `GET https://openrouter.ai/api/v1/models` on **2026-08-12**. All four rows
 * that existed on 2026-08-08 still read exactly what they read then; the
 * dated-snapshot row below is the only addition.
 *
 * Two rows were wrong when this table was consolidated, and wrong in the
 * direction nobody notices: the 2026-08-06 figures had deepseek-v4-flash at
 * 0.088/0.176 against a live 0.14/0.28, and gemini-3.1-flash-lite at 0.1/0.4
 * against a live 0.25/1.5. Making this the single source of truth would have
 * broadcast a bill ~37% UNDER the real one to every caller at once — which is
 * the worse half of the defect this module was written to fix, since a spend
 * ceiling that under-counts is a ceiling that does not hold.
 *
 * So: a date on this comment is a claim, and a claim decays. Re-check the rows
 * before trusting them, and move the date when you do.
 */
export const MODEL_PRICES: Record<string, ModelPricing> = {
  "deepseek/deepseek-v4-flash": { inUsdPerM: 0.14, outUsdPerM: 0.28 },
  /**
   * The dated snapshot behind the floating alias above, and cheaper than it:
   * 0.08/0.18 against 0.14/0.28, i.e. 43% off input and 36% off output for
   * what the provider serves as the same model.
   *
   * IT IS HERE BECAUSE THE ALIAS MOVES. A run published as evidence has to be
   * reproducible, and `deepseek-v4-flash` is a pointer the vendor can
   * repoint under a map that is already on the web claiming what it cost.
   * Pinning the date fixes both the behaviour and the bill.
   *
   * Adding the row is not optional once the id is used: `priceForModel` prices
   * an unknown id at the pessimistic floor, 1.5/9.0, which is 19x this row's
   * input and 50x its output. A run on an unlisted id does not merely report a
   * wrong bill — the per-run cap in packages/web/lib/spend-limits.ts is
   * enforced against that number, so the run is stopped for spending money it
   * never spent.
   */
  "deepseek/deepseek-v4-flash-0731": { inUsdPerM: 0.08, outUsdPerM: 0.18 },
  "google/gemini-3-flash-preview": { inUsdPerM: 0.5, outUsdPerM: 3.0 },
  "google/gemini-3.1-flash-lite": { inUsdPerM: 0.25, outUsdPerM: 1.5 },
  "google/gemini-3.5-flash": { inUsdPerM: 1.5, outUsdPerM: 9.0 },
}

/**
 * An id this table does not know prices at the dearest number in every column
 * — the meter must never flatter a model it has not met. That is a decision,
 * not a number nobody got round to updating: over-reporting is the safe
 * direction for a spend ceiling, and the one model whose price nobody has
 * checked is exactly the one to be pessimistic about. Do not "fix" it
 * downward, and never to zero; a run that looks free is worse than a run that
 * looks expensive.
 *
 * Column-wise off the table so it rises automatically when a dearer row is
 * added — but floored independently, because taking the max ALONE quietly made
 * the table able to lower it. Retire the dearest row (preview and superseded
 * ids do get delisted) and the pessimistic price for every unknown model drops
 * with it: dropping gemini-3.5-flash today would take the fallback from
 * 1.5/9.0 to 0.5/3.0, a threefold cut nobody asked for and no test would catch.
 * The floor is a number this module asserts on its own, so the fallback can
 * only ever be raised by the table, never lowered by it.
 */
const FLOOR: ModelPricing = { inUsdPerM: 1.5, outUsdPerM: 9.0 }
const rows = Object.values(MODEL_PRICES)
const DEFAULT_PRICING: ModelPricing = {
  inUsdPerM: Math.max(FLOOR.inUsdPerM, ...rows.map((r) => r.inUsdPerM)),
  outUsdPerM: Math.max(FLOOR.outUsdPerM, ...rows.map((r) => r.outUsdPerM)),
}

/** The only way to turn a model id into money. Callers pass the id they are
 *  actually about to send to the provider, never a price of their own. */
export function priceForModel(id: string): ModelPricing {
  return MODEL_PRICES[id] ?? DEFAULT_PRICING
}
