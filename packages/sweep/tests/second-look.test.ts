import { describe, it, expect } from "vitest"
import { mostCorroboratedFirst, SECOND_LOOK_CAP } from "../src/sweep.js"
import type { SearchHit } from "@open-kb/core"
import {
  runFixture,
  defaultScript,
  HOSTS,
  SERP,
  USD_PER_MODEL_CALL,
  costOf,
  lineOf,
  type Script,
} from "./fixture.js"

/**
 * The second look: one more free fetch for each host the judge left `unknown`,
 * on a page the search itself surfaced (`topHit`), and the SAME classify call
 * against it. Its contract is the triage stage's, re-worn: defaults ON (its
 * A/B survived, see `SweepOptions.secondLook`), rescue is its only power, and
 * every failure fails open — each sentence gets its case below.
 *
 * The market is bent in one place to give the stage something real to do: every
 * grepstack SERP hit points at a PRICING page rather than the front door, so
 * `topHit` (the first hit's URL out of `byHost`) is a deeper page than the one
 * the judge read — which is exactly the measured shape the stage exists for.
 */

/** The deeper page the search surfaced: every grepstack hit lands here. */
const DEEP = `https://${HOSTS.grepstack}/pricing`

const SERP_DEEP = Object.fromEntries(
  Object.entries(SERP).map(([q, hits]) => [
    q,
    hits.map((h) => (h.url === `https://${HOSTS.grepstack}/` ? { ...h, url: DEEP } : h)),
  ]),
)

/** The sentence the rescue quotes back. A literal substring of the pricing
 *  page's condensed text, because the second look re-verifies quotes in code
 *  and an unverifiable span must leave the first judgement standing. */
const DEEP_SPAN = "Grepstack prices hosted log search per ingested gigabyte for platform teams"

/** Padded past core's THIN_TEXT floor (200 extracted chars) so `sniff()` calls
 *  it `found` — the same trick the fixture's own `page()` helper plays. */
const DEEP_PAGE =
  `<html><head><title>Grepstack pricing</title></head><body><h1>Grepstack pricing</h1>` +
  `<p>${DEEP_SPAN}, with a retention window their auditors accept and no per-seat line item.</p>` +
  `<p>Teams land here from shortlist posts comparing hosted log search vendors on what a year ` +
  `of logs actually costs, and leave with a number instead of a call with sales.</p></body></html>`

/** What the front page earns: an honest refusal, model-settled. The span does
 *  not appear on any page, so the ledger reads {verified: 0, claimed: 1}. */
const UNPLACED = {
  name: HOSTS.grepstack,
  kind: "unknown",
  what: "",
  relation: "unknown",
  why: "",
  spans: ["nothing on this page says what it sells"],
}

/** What the pricing page earns: a placed verdict whose quote verifies. */
const RESCUED = {
  name: "Grepstack",
  kind: "company",
  what: "A hosted log search vendor priced on ingested volume.",
  relation: "competitor",
  why: "sells the same log search capability to the same platform teams",
  spans: [DEEP_SPAN],
}

/**
 * The fixture's classify script is keyed by host, so first-vs-second is told
 * apart by call order: the judge's front-page call is grepstack's first, the
 * second look's is its second (and, under the SDK's own retries, any later).
 */
const rescueScript = (second: () => unknown): Script => {
  let grepstackCalls = 0
  return {
    classify: (host, prompt) => {
      if (host !== HOSTS.grepstack) return defaultScript().classify(host, prompt)
      grepstackCalls += 1
      return grepstackCalls === 1 ? UNPLACED : second()
    },
  }
}

const fetchTable = { [DEEP]: { httpStatus: 200, contentType: "text/html", body: DEEP_PAGE } }

describe("second look", () => {
  it("rescues an unplaced host in place, from the page the search surfaced", async () => {
    const h = await runFixture({
      serp: SERP_DEEP,
      fetchTable,
      sweepOptions: { secondLook: true },
      script: rescueScript(() => RESCUED),
    })

    // Two classify calls, in order: the front page first, then the topHit —
    // and the second one's {{page}} carries the header naming the URL and the
    // first judgement's refusal.
    const looks = h.calls.filter((c) => c.phase === "classify" && c.subject === HOSTS.grepstack)
    expect(looks).toHaveLength(2)
    expect(looks[0]!.prompt).not.toContain("second look at")
    expect(looks[1]!.prompt).toContain(`second look at ${DEEP}`)
    expect(looks[1]!.prompt).toContain("left this host unplaced")

    // The fetch was the topHit, direct, on the run's own signal — not the
    // front page again, and not an unlocker escalation.
    const deepFetches = h.fetch.calls.filter((c) => c.url === DEEP)
    expect(deepFetches).toHaveLength(1)
    expect(deepFetches[0]!.mode).toBe("direct")
    expect(deepFetches[0]!.signal).toBeDefined()

    // Replaced IN PLACE: same entity row, new verdict, wearing the trail.
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.kind).toBe("company")
    expect(e.relation).toBe("competitor")
    expect(e.what).toBe(RESCUED.what)
    expect(e.why).toBe(RESCUED.why)
    expect(e.spans).toEqual([DEEP_SPAN])
    expect(e.descSpans).toEqual({ verified: 1, claimed: 1 })
    expect(e.because).toContain(`second look at ${DEEP}`)
    expect(e.settledBy).toBe("model")

    // The census, and the bill: the re-judgement is booked under its own
    // label, not smuggled into the rank line.
    expect((h.result.report as { secondLook: unknown }).secondLook).toEqual({ unplaced: 1, asked: 1, rescued: 1, failed: 0, unlocked: 0 })
    expect(lineOf(costOf(h.result).byAgent, "second-look").usd).toBe(USD_PER_MODEL_CALL)
    expect(h.says.some((s) => s.includes("second look rescued 1 of 1"))).toBe(true)
  })

  it("runs by default, with no flag needed", async () => {
    const h = await runFixture({
      serp: SERP_DEEP,
      fetchTable,
      script: rescueScript(() => RESCUED),
    })
    const looks = h.calls.filter((c) => c.phase === "classify" && c.subject === HOSTS.grepstack)
    expect(looks).toHaveLength(2)
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.kind).toBe("company")
    expect((h.result.report as { secondLook: unknown }).secondLook).toEqual({ unplaced: 1, asked: 1, rescued: 1, failed: 0, unlocked: 0 })
  })

  it("does not exist when explicitly disabled", async () => {
    // The same bent market, the same script — everything but the flag.
    const h = await runFixture({
      serp: SERP_DEEP,
      fetchTable,
      sweepOptions: { secondLook: false },
      script: rescueScript(() => RESCUED),
    })
    // One classify call per host, no second: the counter never reached two.
    const looks = h.calls.filter((c) => c.phase === "classify" && c.subject === HOSTS.grepstack)
    expect(looks).toHaveLength(1)
    // The topHit was never bought, and the refusal ships as judged.
    expect(h.fetch.calls.map((c) => c.url)).not.toContain(DEEP)
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.kind).toBe("unknown")
    expect(e.relation).toBe("unknown")
    expect((h.result.report as { secondLook?: unknown }).secondLook).toBeNull()
  })

  it("fails open: a second call that throws leaves the first judgement standing", async () => {
    const h = await runFixture({
      serp: SERP_DEEP,
      fetchTable,
      sweepOptions: { secondLook: true },
      script: rescueScript(() => {
        throw new Error("the model is down")
      }),
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.kind).toBe("unknown")
    expect(e.relation).toBe("unknown")
    expect(e.because ?? "").not.toContain("second look")
    // The attempt is still counted — the report reconciles with the bill.
    expect((h.result.report as { secondLook: unknown }).secondLook).toEqual({ unplaced: 1, asked: 1, rescued: 0, failed: 1, unlocked: 0 })
  })

  it("a second look that still says unknown changes nothing", async () => {
    const h = await runFixture({
      serp: SERP_DEEP,
      fetchTable,
      sweepOptions: { secondLook: true },
      script: rescueScript(() => UNPLACED),
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.kind).toBe("unknown")
    expect(e.relation).toBe("unknown")
    expect(e.because ?? "").not.toContain("second look")
    expect((h.result.report as { secondLook: unknown }).secondLook).toEqual({ unplaced: 1, asked: 1, rescued: 0, failed: 0, unlocked: 0 })
  })

  it("escalates through the unlocker when the search-surfaced page is also walled", async () => {
    // Grepstack is corroborated in 3 queries (SERP's own comment) — well past
    // the seenIn>=2 bar — so a blocked pricing page earns one unlocker retry
    // rather than failing open on the spot.
    const h = await runFixture({
      serp: SERP_DEEP,
      fetchTable: {
        [DEEP]: {
          httpStatus: 403,
          body: "",
          unlocked: { httpStatus: 200, contentType: "text/html", body: DEEP_PAGE },
        },
      },
      sweepOptions: { secondLook: true },
      script: rescueScript(() => RESCUED),
    })

    // Both modes hit the SAME url, in order: the direct read first, the
    // unlocker only once it came back blocked.
    const deepFetches = h.fetch.calls.filter((c) => c.url === DEEP)
    expect(deepFetches.map((c) => c.mode)).toEqual(["direct", "unlocked"])

    // Rescued exactly as the direct-success case is — the unlocked page,
    // not the blocked one, is what the classify call actually reads.
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.kind).toBe("company")
    expect(e.relation).toBe("competitor")
    expect(e.because).toContain(`second look at ${DEEP}`)

    expect((h.result.report as { secondLook: unknown }).secondLook).toEqual({
      unplaced: 1,
      asked: 1,
      rescued: 1,
      failed: 0,
      unlocked: 1,
    })
    expect(h.says.some((s) => s.includes("1 escalated through the unlocker"))).toBe(true)
  })

  it("does not spend an unlocker retry on a host the search barely corroborated", async () => {
    // A deliberately sparse SERP, not the fixture's usual one: Loglens named
    // in exactly one query and carrying no rank at all (fixture hits never
    // set one) — under BOTH bars (`seenIn>=2`, `bestRank<=5`) at once, to
    // prove the gate holds when neither condition is met.
    const SPARSE_DEEP = `https://${HOSTS.loglens}/pricing`
    const SPARSE_SERP = {
      "log search": [
        { url: `https://${HOSTS.loglens}/pricing`, title: "Loglens", description: "Priced on ingest." },
      ],
    }
    const h = await runFixture({
      serp: SPARSE_SERP,
      fetchTable: {
        [SPARSE_DEEP]: {
          httpStatus: 403,
          body: "",
          unlocked: { httpStatus: 200, contentType: "text/html", body: DEEP_PAGE },
        },
      },
      sweepOptions: { secondLook: true },
      script: {
        classify: (host) =>
          host === HOSTS.loglens
            ? UNPLACED
            : defaultScript().classify(host, ""),
      },
    })

    // Only the direct read was spent — the unlocker never fires for a host
    // that earned neither bar.
    const sparseFetches = h.fetch.calls.filter((c) => c.url === SPARSE_DEEP)
    expect(sparseFetches.map((c) => c.mode)).toEqual(["direct"])
    expect((h.result.report as { secondLook: unknown }).secondLook).toEqual({
      unplaced: 1,
      asked: 1,
      rescued: 0,
      failed: 1,
      unlocked: 0,
    })
  })

  it("SECOND_LOOK_CAP caps how many unplaced hosts one run re-reads a page for", async () => {
    // SECOND_LOOK_CAP (sweep.ts:432) had zero grep hits in any test — the
    // `.slice(0, SECOND_LOOK_CAP)` at sweep.ts:5717 that bounds `lookAt` was
    // never exercised past whatever a plain fixture run leaves unplaced,
    // which is 0: every one of HOSTS.grepstack/tailwatch/loglens/forum/
    // adtrash classifies with a real relation, and HOSTS.walled never
    // reaches the model at all (its front page 404s, settled by predicate).
    //
    // 65 fresh hosts, folded onto "log search alternatives" the same way
    // DROP_CONFIRM_CAP's test folds extra rows onto that query — each given
    // a real fetchable FRONT page (so it reaches classify rather than
    // 404ing into a predicate settlement) and left OUT of CLASSIFY, so the
    // fixture's own `unknownHost()` default answers `kind:"unknown",
    // relation:"unknown"` — exactly the shape `unplaced` filters for. Each
    // hit's url points at a `/pricing` page rather than the front door, so
    // `topHit` is a distinct page and `frontDoorAgain` does not exclude it
    // from the ranked population (the second look never fetches this deep
    // page here — it 404s too — which is fine: `secondLookAsked` counts the
    // attempt, not the outcome). 65 hosts is five past SECOND_LOOK_CAP (60),
    // so the slice has to actually cut something.
    const fillerFrontPage = (i: number) =>
      `<html><head><title>Second Look Cap Filler ${i}</title></head><body><h1>Second Look Cap Filler ${i}</h1>` +
      `<p>A page with nothing to do with log search or uptime monitoring, kept only to push the ` +
      `second-look candidate pool past SECOND_LOOK_CAP so the cap has something real to cut.</p>` +
      `</body></html>`
    const extra: SearchHit[] = Array.from({ length: 65 }, (_, i) => ({
      url: `https://second-look-cap-filler-${i}.example/pricing`,
      title: `Second Look Cap Filler ${i}`,
      description: "Unrelated to log search or uptime alerts.",
    }))
    const fetchTable = Object.fromEntries(
      extra.map((h, i) => [
        `https://second-look-cap-filler-${i}.example/`,
        { httpStatus: 200, contentType: "text/html", body: fillerFrontPage(i) },
      ]),
    )

    const h = await runFixture({
      sweepOptions: { secondLook: true },
      serp: { ...SERP, "log search alternatives": [...SERP["log search alternatives"]!, ...extra] },
      fetchTable,
    })

    const unplacedEntities = h.result.entities.filter(
      (e) => e.settledBy === "model" && e.relation === "unknown",
    )
    expect(unplacedEntities.length).toBe(65)
    expect(
      (h.result.report as { secondLook: { unplaced: number; asked: number } }).secondLook.unplaced,
    ).toBe(65)
    expect(
      (h.result.report as { secondLook: { asked: number } }).secondLook.asked,
    ).toBe(SECOND_LOOK_CAP)
  }, 30_000)
})

/**
 * WHICH hosts fill the cap.
 *
 * The cap binds on every run since the snippet gate — more unplaced hosts than
 * looks to spend — so the order is the whole decision. It used to be whatever
 * order `entities` happened to be in, and that order was measurably
 * anti-correlated with merit: on the run where the cap bound hardest the 60
 * hosts it looked at averaged seenIn 1.08 while the 43 it skipped averaged 4.07.
 *
 * That is a property of the array, not of the second look: mean `seenIn`
 * rises monotonically across its five fifths on every anchor measured. Both
 * capped stages read it, so both take this order.
 */
describe("mostCorroboratedFirst — the order every capped stage spends in", () => {
  const row = (seenIn: number, bestRank: number | undefined, tag: string) => ({ seenIn, bestRank, tag })

  it("puts the most corroborated host first", () => {
    const out = mostCorroboratedFirst([row(1, 3, "once"), row(4, 30, "four times"), row(2, 1, "twice")])
    expect(out.map((r) => r.tag)).toEqual(["four times", "twice", "once"])
  })

  it("breaks a tie on the best rank any query gave the host", () => {
    const out = mostCorroboratedFirst([row(2, 9, "ninth"), row(2, 2, "second"), row(2, 40, "fortieth")])
    expect(out.map((r) => r.tag)).toEqual(["second", "ninth", "fortieth"])
  })

  it("sorts a host no query ranked last, rather than letting undefined win by accident", () => {
    const out = mostCorroboratedFirst([row(2, undefined, "unranked"), row(2, 50, "fiftieth")])
    expect(out.map((r) => r.tag)).toEqual(["fiftieth", "unranked"])
  })

  it("does not mutate what it was given", () => {
    const rows = [row(1, 1, "a"), row(9, 1, "b")]
    mostCorroboratedFirst(rows)
    expect(rows.map((r) => r.tag)).toEqual(["a", "b"])
  })
})
