/**
 * What a model costs, in dollars per million tokens.
 *
 * One concept, one spelling. The engines and core's own options used to spell
 * these two fields differently, so every caller crossing that seam had to
 * translate. Two of them did not translate — they retyped the numbers on the
 * far side instead, and the numbers drifted, which is how a run that cost
 * three cents came to print a bill near seventy. An adapter would have made
 * the seam survivable; naming the shape once removes it.
 *
 * Core declares the shape and never fills it. Who charges what is a fact about
 * a vendor, so the table lives at the vendor layer (`@open-kb/providers`) and
 * arrives here as a parameter — the engine must not know which vendor it is
 * talking to, and the purity gate enforces that it cannot even name one.
 */
export interface ModelPricing {
  /** Dollars per million input tokens. */
  inUsdPerM: number
  /** Dollars per million output tokens. */
  outUsdPerM: number
}
