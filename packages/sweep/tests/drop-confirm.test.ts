import { describe, it, expect } from "vitest"
import { runFixture, defaultScript, HOSTS, SERP } from "./fixture.js"
import { DROP_CONFIRM_CAP } from "../src/sweep.js"
import type { SearchHit } from "@open-kb/core"

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

  it("DROP_CONFIRM_CAP caps how many model-settled none hosts one run re-asks about", async () => {
    // DROP_CONFIRM_CAP (sweep.ts) had zero grep hits in any test — the
    // `.slice(0, DROP_CONFIRM_CAP)` at sweep.ts:6019 that bounds `candidates`
    // was never exercised past the plain fixture's own single candidate
    // (adtrash.example, confirmed by the describe-block comment above and by
    // this suite's other cases, all of which see exactly one). Sixty-one
    // hosts under the cap is nothing this fixture has ever produced.
    //
    // 65 fresh hosts, folded onto "log search alternatives" the same way
    // TRIAGE_BATCH's test folds extra rows onto that query (one of the
    // rival-family templates fired from Log Search Cloud's own terms, no
    // sweepOptions override needed) — each given a real fetchable page so it
    // reaches classify rather than 404ing into a predicate settlement, and a
    // classify override that judges it `noise`/`none`, the same shape
    // adtrash's own default verdict already wears. Together with adtrash that
    // is 66 model-settled `none` candidates, six past DROP_CONFIRM_CAP (60),
    // so the slice has to actually cut something.
    const fillerPage = (i: number) =>
      `<html><head><title>Drop Cap Filler ${i}</title></head><body><h1>Drop Cap Filler ${i}</h1>` +
      `<p>A page with nothing to do with log search or uptime monitoring, kept only to push the ` +
      `drop-confirm candidate pool past DROP_CONFIRM_CAP so the cap has something real to cut.</p>` +
      `</body></html>`
    const extra: SearchHit[] = Array.from({ length: 65 }, (_, i) => ({
      url: `https://drop-cap-filler-${i}.example/`,
      title: `Drop Cap Filler ${i}`,
      description: "Unrelated to log search or uptime alerts.",
    }))
    const fetchTable = Object.fromEntries(
      extra.map((h, i) => [h.url, { httpStatus: 200, contentType: "text/html", body: fillerPage(i) }]),
    )

    const h = await runFixture({
      sweepOptions: { dropConfirm: true },
      serp: { ...SERP, "log search alternatives": [...SERP["log search alternatives"]!, ...extra] },
      fetchTable,
      script: {
        // Only the cap is under test, so every filler host settles the same
        // way adtrash already does by default — `defaultScript().classify`
        // covers every other host unchanged.
        classify: (host, prompt) =>
          host.startsWith("drop-cap-filler-")
            ? {
                name: host,
                kind: "noise",
                what: "",
                relation: "none",
                why: "no connection to this market",
                spans: ["nothing to do with log search or uptime monitoring"],
              }
            : defaultScript().classify(host, prompt),
      },
    })

    const noneSettled = h.result.entities.filter((e) => e.settledBy === "model" && e.relation === "none")
    expect(noneSettled.length).toBe(66)
    expect((h.result.report as { dropConfirm: { asked: number } }).dropConfirm.asked).toBe(DROP_CONFIRM_CAP)
  }, 30_000)
})
