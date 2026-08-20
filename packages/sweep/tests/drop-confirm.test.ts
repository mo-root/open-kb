import { describe, it, expect } from "vitest"
import { runFixture, defaultScript, HOSTS } from "./fixture.js"

/**
 * The drop-confirm stage: a second, batched opinion on every model-settled
 * `relation: "none"` host, asked from stored evidence alone — no re-fetch.
 * Its contract is triage's and the second look's, re-worn: off unless asked
 * for, rescue (or a confirmed drop) is its only power, and every failure
 * fails open — each sentence gets its case below.
 *
 * The default market already gives this stage a real candidate for free:
 * `adtrash.example` is classified `noise`/`none` by the fixture's own default
 * script (fixture.ts's CLASSIFY table), settled by the model, exactly the
 * shape this stage exists to re-ask about.
 */

describe("drop-confirm", () => {
  it("does not exist unless asked for", async () => {
    const h = await runFixture()
    expect(h.calls.filter((c) => c.phase === "drop-confirm")).toEqual([])
    expect((h.result.report as { dropConfirm?: unknown }).dropConfirm).toBeNull()
    // The first verdict stands, untouched.
    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.kind).toBe("noise")
    expect(e.relation).toBe("none")
  })

  it("rescues a model-settled none host in place, from its own stored what/why/roads", async () => {
    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      script: {
        dropConfirm: (hosts) => ({
          placements: hosts.map((host) =>
            host === HOSTS.adtrash
              ? {
                  host,
                  kind: "directory",
                  relation: "lists",
                  what: "A deals site that also indexes discounts on monitoring tools.",
                  why: "indexes vendor discounts, including this market's",
                  // A literal substring of the CONTEXT this call was handed —
                  // `classified()`'s fixed why sentence, the only text on
                  // record for a host this stage never re-fetches.
                  spans: ["the evidence of its own front page"],
                }
              : { host, kind: "noise", relation: "none", what: "", why: "confirmed unrelated", spans: [] },
          ),
        }),
      },
    })

    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.kind).toBe("directory")
    expect(e.relation).toBe("lists")
    expect(e.what).toBe("A deals site that also indexes discounts on monitoring tools.")
    expect(e.spans).toEqual(["the evidence of its own front page"])
    expect(e.because).toContain("drop-confirmed:")
    expect(e.because).toContain("indexes vendor discounts")

    expect((h.result.report as { dropConfirm: unknown }).dropConfirm).toEqual({
      asked: 1,
      rescued: 1,
      confirmed: 0,
    })
    expect(h.says.some((s) => s.includes("drop-confirm rescued 1 of 1"))).toBe(true)
  })

  it("a rescue whose spans do not verify against the stored record does not stand", async () => {
    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      script: {
        dropConfirm: (hosts) => ({
          placements: hosts.map((host) => ({
            host,
            kind: "directory",
            relation: "lists",
            what: "A deals site that also indexes discounts on monitoring tools.",
            why: "indexes vendor discounts",
            // Not a substring of anything this call was handed.
            spans: ["a sentence invented out of nowhere for this test"],
          })),
        }),
      },
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.kind).toBe("noise")
    expect(e.relation).toBe("none")
    expect((h.result.report as { dropConfirm: unknown }).dropConfirm).toEqual({
      asked: 1,
      rescued: 0,
      confirmed: 0,
    })
  })

  it("fails open: a thrown call leaves every first verdict in it standing", async () => {
    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      script: {
        dropConfirm: () => {
          throw new Error("the model is down")
        },
      },
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.kind).toBe("noise")
    expect(e.relation).toBe("none")
    expect(e.because ?? "").not.toContain("drop-confirmed")
    expect((h.result.report as { dropConfirm: unknown }).dropConfirm).toEqual({
      asked: 1,
      rescued: 0,
      confirmed: 0,
    })
    expect(h.says.some((s) => s.includes("a drop-confirm call failed"))).toBe(true)
  })

  it("verifies a span that includes the label text the model was actually shown", async () => {
    // blockFor renders "  why: <value>" — a quote spanning into that label
    // is real text the model was handed, and must verify against the SAME
    // string, not a separately-reconstructed one that dropped the labels.
    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      script: {
        dropConfirm: (hosts) => ({
          placements: hosts.map((host) => ({
            host,
            kind: "directory",
            relation: "lists",
            what: "A deals site that also indexes discounts.",
            why: "indexes vendor discounts",
            spans: ["why: stands this way to"],
          })),
        }),
      },
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.relation).toBe("lists")
    expect((h.result.report as { dropConfirm: unknown }).dropConfirm).toEqual({
      asked: 1,
      rescued: 1,
      confirmed: 0,
    })
  })

  it("clears a rescued entity's stale reasoning/relationSpan rather than leaving them describing the overwritten verdict", async () => {
    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      script: {
        classify: (host, prompt) =>
          host === HOSTS.adtrash
            ? {
                // The default adtrash verdict, plus the two fields under
                // test — everything else stays the fixed template so the
                // rescue's own quote (below) still verifies against it.
                ...(defaultScript().classify(host, prompt) as object),
                reasoning: "purely a coupon aggregator, no market connection",
                relationSpan: "the evidence of its own front page",
              }
            : defaultScript().classify(host, prompt),
        dropConfirm: (hosts) => ({
          placements: hosts.map((host) => ({
            host,
            kind: "directory",
            relation: "lists",
            what: "A deals site that also indexes discounts.",
            why: "indexes vendor discounts",
            spans: ["the evidence of its own front page"],
          })),
        }),
      },
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.relation).toBe("lists")
    expect(e.reasoning).toBeUndefined()
    expect(e.relationSpan).toBeUndefined()
    expect(e.relationGrounded).toBeUndefined()
  })

  it("a genuinely confirmed drop stays dropped, wearing the checked reason", async () => {
    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      script: {
        dropConfirm: (hosts) => ({
          placements: hosts.map((host) => ({
            host,
            kind: "noise",
            relation: "none",
            what: "",
            why: "still nothing here connects to this market, checked again",
            spans: [],
          })),
        }),
      },
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.adtrash)!
    expect(e.kind).toBe("noise")
    expect(e.relation).toBe("none")
    expect(e.because).toContain("drop-confirmed: still nothing here connects")
    expect((h.result.report as { dropConfirm: unknown }).dropConfirm).toEqual({
      asked: 1,
      rescued: 0,
      confirmed: 1,
    })
  })
})
