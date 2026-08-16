import { describe, it, expect } from "vitest"
import { runFixture, defaultScript, ANCHOR, COINAGE, type Harness } from "./fixture.js"

/**
 * THE ONE SENTENCE THE STRIP NEEDS, COMPUTED AND THROWN AWAY.
 *
 * `understand`'s schema asks for `products[].does` — "what this product does,
 * stripped of the company's own naming" — and the catalog call, whose whole job
 * is to turn a product into the terms a buyer types, was handed the
 * CAPABILITY's one-liner instead. Every sibling in a group therefore arrived
 * with the same description of itself, so a capability covering three products
 * asked one question three times and paid for it three times.
 *
 * The fix is a lookup, and the tests below are the three cases it has: a
 * product that carries its own line gets it, a product that carries none falls
 * back to its capability's, and a `covers` entry that shouts the product's name
 * still finds the product.
 */

const understand = (
  products: { name: string; does: string }[],
  covers: string[],
) => () => ({
  sells: "hosted log search and uptime alerts for small platform teams",
  buyer: "a platform team of five to fifty engineers who have just had an incident",
  brand: "Pellucid",
  products: products.map((p) => ({ ...p, foundAt: `https://${ANCHOR}/` })),
  capabilities: [
    {
      name: "log search",
      does: "answers a question about production",
      covers,
      centrality: "core",
    },
  ],
  coinages: [COINAGE],
})

const catalog = () => ({ terms: ["log search"], generic: true, queries: [] })

/** `    the job       searches application logs` — the catalog prompt's own
 *  layout, read back out of the rendered template. */
const jobOf = (h: Harness, product: string): string => {
  const call = h.calls.find((c) => c.phase === "catalog" && c.subject === product)
  if (!call) throw new Error(`no catalog call for ${product}: ${h.calls.map((c) => c.subject).join(", ")}`)
  return /the job\s{2,}(.+)/.exec(call.prompt)?.[1]?.trim() ?? ""
}

/** The capability's line — what every product in the group used to be handed. */
const MARKET_DOES = "answers a question about production"

describe("two products in one market", () => {
  it("are each described by their own job, not by the market's", async () => {
    // The measured shape: siblings under one capability. Before the lookup both
    // of these read `answers a question about production`, so the call that
    // exists to tell them apart could not.
    const h = await runFixture({
      script: {
        understand: understand(
          [
            { name: "Log Search Cloud", does: "searches application logs" },
            { name: "Trace Explorer", does: "follows one request across a hundred containers" },
          ],
          ["Log Search Cloud", "Trace Explorer"],
        ),
        catalog,
      },
    })
    expect(jobOf(h, "Log Search Cloud")).toBe("searches application logs")
    expect(jobOf(h, "Trace Explorer")).toBe(
      "follows one request across a hundred containers",
    )
    expect(jobOf(h, "Log Search Cloud")).not.toBe(MARKET_DOES)
  }, 30_000)

  it("fall back to the market's line when the product carries none", async () => {
    // A product row with an empty `does` is a real answer, not a bug: the model
    // found the name and nothing to say about it. The capability's line is then
    // the best sentence the run has, and it is better than an empty one.
    const h = await runFixture({
      script: {
        understand: understand(
          [{ name: "Log Search Cloud", does: "" }],
          ["Log Search Cloud"],
        ),
        catalog,
      },
    })
    expect(jobOf(h, "Log Search Cloud")).toBe(MARKET_DOES)
  }, 30_000)

  it("are found even when the covers entry shouts the name back", async () => {
    // `covers` is the model quoting its own product list, and a quote that came
    // back in another case used to cost the product both its job line and its
    // `foundAt`. Matched case-folded in one place, so both recover together.
    const h = await runFixture({
      script: {
        understand: understand(
          [{ name: "Log Search Cloud", does: "searches application logs" }],
          ["LOG SEARCH CLOUD"],
        ),
        catalog,
      },
    })
    expect(jobOf(h, "LOG SEARCH CLOUD")).toBe("searches application logs")
    const strips = h.result.report.strips as { product: string; foundAt: string }[]
    expect(strips[0]!.foundAt).toBe(`https://${ANCHOR}/`)
  }, 30_000)
})

describe("a capability funded under its own name", () => {
  it("keeps the market's line, because there is no product row to find", async () => {
    // `covers` empty is the case the queues fall back on: the capability funds
    // itself. Nothing in `products` is named `log search`, so the lookup misses
    // and the capability's own job is the honest thing to strip.
    const h = await runFixture({
      script: {
        understand: understand(
          [{ name: "Log Search Cloud", does: "searches application logs" }],
          [],
        ),
        catalog,
      },
    })
    expect(jobOf(h, "log search")).toBe(MARKET_DOES)
    // And the product itself is still asked about — under its own name, with
    // its own line, because nothing claimed it.
    expect(jobOf(h, "Log Search Cloud")).toBe("searches application logs")
  }, 30_000)
})

describe("a coinage that is the market's own term leaves the ban", () => {
  /**
   * The first live agent run listed "Email API" among resend's coinages — a
   * product name on that site, and the exact term the strip returns for its
   * core market. Banning it kills the plain family for that market.
   */
  it("keeps the plain family alive when a coinage collides with a strip term", async () => {
    const h = await runFixture({
      script: {
        understand: () => ({
          ...(defaultScript().understand("") as Record<string, unknown>),
          // The model lists the core market's own term as a coinage.
          coinages: ["Lumen", "log search"],
        }),
      },
    })
    // "log search" (the bare term) and "log search alternatives" are the
    // plain family's openers; they must still fire.
    expect(h.asked).toContain("log search")
    expect(h.asked).toContain("log search alternatives")
    // The real coinage still bans: no fired query names Lumen.
    expect(h.asked.every((q) => !/lumen/i.test(q))).toBe(true)
  })
})
