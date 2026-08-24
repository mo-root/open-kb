import { describe, it, expect } from "vitest"
import { runFixture, SERP, HOSTS, type Harness } from "./fixture.js"
import type { EntityEdge } from "../src/sweep.js"

/**
 * WHY PROVED DISCOVERY, NOT MECHANISM.
 *
 * The free naming pass wrote `why: 'a page on X names "Y"'` for every edge it
 * found, whether the naming row said nothing beyond the name or spent a whole
 * sentence on how the two relate. That sentence is a fact a reader can act on
 * or correct — "reviewed alongside Loglens, the retention-priced alternative"
 * says something "a page on grepstack.example names Loglens" does not — and
 * the pass already has that text in hand, in `rows`, before it writes `why`.
 *
 * The paid link pass had the opposite problem in the other direction:
 * link.md already tells the model "'Both in web scraping' is worth nothing",
 * but nothing checked that instruction against anything, the way the classify
 * pass's `relationSpan` is checked against the page it was drawn from. A model
 * free to assert a mechanism is a model free to assert a generic one.
 */

const named = (h: Harness): EntityEdge[] =>
  (h.result.edges ?? []).filter((e) => /^a page on \S+ names "/.test(e.why))

describe("the free naming pass", () => {
  it("quotes the naming row's own text when it says more than the bare name", async () => {
    const h = await runFixture({
      sweepOptions: { skipModelLinking: true },
      serp: {
        ...SERP,
        "log search": [
          {
            url: `https://${HOSTS.grepstack}/`,
            title: "Grepstack — hosted log search",
            description:
              "Reviewed this week alongside Loglens, the retention-priced alternative.",
          },
          ...SERP["log search"]!.slice(1),
        ],
      },
    })
    const e = named(h).find((x) => x.from === HOSTS.grepstack && x.to === HOSTS.loglens)
    expect(e, "grepstack's own row named loglens and no naming edge was written").toBeDefined()
    // The prefix a reader (and the older test suite) already relies on is
    // untouched — only the mechanism is new, appended after it.
    expect(e!.why).toBe(
      `a page on ${HOSTS.grepstack} names "Loglens": ` +
        `"Reviewed this week alongside Loglens, the retention-priced alternative."`,
    )
  })

  it("never quotes a sentence that does not contain the name it is evidence for", async () => {
    /**
     * `namesIt` was checked against title and description JOINED and then the
     * description alone was quoted, so a row whose TITLE carried the name
     * shipped a quote that did not. Measured on two real runs: 92 of 1,329
     * quoted edges on shopify (6.9%) and 124 of 1,407 on cloudflare (8.8%).
     * Three competitor edges out of squareup.com all carried "Learn why
     * thousands of businesses choose Square every year", which names none of
     * the three companies it was offered as evidence about.
     */
    const h = await runFixture({
      serp: {
        ...SERP,
        "log search": [
          {
            url: `https://${HOSTS.grepstack}/`,
            // The TITLE names Loglens; the description is generic marketing
            // that does not. Only the title may be quoted here.
            title: `Grepstack vs ${HOSTS.loglens} — hosted log search`,
            description: "Learn why thousands of teams choose Grepstack every year to search their logs.",
          },
          ...SERP["log search"]!.slice(1),
        ],
      },
    })
    const e = named(h).find((x) => x.from === HOSTS.grepstack && x.to === HOSTS.loglens)
    expect(e, "grepstack's own row named loglens and no naming edge was written").toBeDefined()
    // Whatever it quotes, the quote must contain the name. The generic
    // description is longer and would have won the old "longest wins" contest.
    const quoted = /names "[^"]+": "([\s\S]*)"$/.exec(e!.why)?.[1]
    if (quoted) expect(quoted.toLowerCase()).toContain(HOSTS.loglens.toLowerCase())
    expect(e!.why).not.toContain("thousands of teams choose Grepstack")
  }, 30_000)

  it("falls back to the bare discovery sentence when the row says nothing more", async () => {
    const h = await runFixture({
      sweepOptions: { skipModelLinking: true },
      serp: {
        ...SERP,
        // The row carries nothing beyond the name itself — deliberately
        // minimal, to prove the fallback rather than the common case above.
        "log search": [
          { url: `https://${HOSTS.grepstack}/`, title: "Loglens", description: "" },
          ...SERP["log search"]!.slice(1),
        ],
      },
    })
    const e = named(h).find((x) => x.from === HOSTS.grepstack && x.to === HOSTS.loglens)
    expect(e).toBeDefined()
    expect(e!.why).toBe(`a page on ${HOSTS.grepstack} names "Loglens"`)
  })

  it("prefers the richest of every row that names the target, not just the first", async () => {
    // A host turns up in `rows` once per query that surfaced it. The bare
    // row here — same shape as the fallback case above — used to be picked
    // whenever `.find()` reached it first, even though a second query's row
    // for the same host said something real a paragraph later.
    const h = await runFixture({
      sweepOptions: { skipModelLinking: true },
      serp: {
        ...SERP,
        "log search": [
          { url: `https://${HOSTS.grepstack}/`, title: "Loglens", description: "" },
          ...SERP["log search"]!.slice(1),
        ],
        "log search alternatives": [
          {
            url: `https://${HOSTS.grepstack}/`,
            title: "Grepstack vs Loglens",
            description:
              "Reviewed this week alongside Loglens, the retention-priced alternative.",
          },
          ...SERP["log search alternatives"]!.slice(1),
        ],
      },
    })
    const e = named(h).find((x) => x.from === HOSTS.grepstack && x.to === HOSTS.loglens)
    expect(e, "grepstack's own rows never named loglens").toBeDefined()
    expect(e!.why).toBe(
      `a page on ${HOSTS.grepstack} names "Loglens": ` +
        `"Reviewed this week alongside Loglens, the retention-priced alternative."`,
    )
  })
})

describe("the paid link pass", () => {
  it("marks a why backed by a real quote grounded, and an invented one not — without dropping either", async () => {
    const h = await runFixture({
      script: {
        link: (pairs) => ({
          edges: pairs.map((p) => ({
            from: p.a,
            to: p.b,
            relation: "competitor" as const,
            confidence: "inferred" as const,
            why: "argued from what each does",
            whySpan:
              p.a === HOSTS.tailwatch || p.b === HOSTS.tailwatch
                ? // A literal substring of tailwatch's own `what`, the exact
                  // text `describe()` put in front of the model.
                  "A vendor selling log search and uptime checks in one console."
                : // No description in this pair says anything like this —
                  // the shape a model free to assert without a check produces.
                  "a claim no description in this pair actually makes",
          })),
        }),
      },
    })
    const edges = (h.result.edges ?? []).filter((e) => e.confidence === "inferred")
    const isPair = (e: EntityEdge, a: string, b: string) =>
      (e.from === a && e.to === b) || (e.from === b && e.to === a)

    const grounded = edges.find((e) => isPair(e, HOSTS.grepstack, HOSTS.tailwatch))
    expect(grounded, "grepstack/tailwatch never reached the paid pass").toBeDefined()
    expect(grounded!.whyGrounded).toBe(true)

    const ungrounded = edges.find((e) => isPair(e, HOSTS.grepstack, HOSTS.loglens))
    expect(ungrounded, "grepstack/loglens never reached the paid pass").toBeDefined()
    expect(ungrounded!.whyGrounded).toBe(false)
  })
})
