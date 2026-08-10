import { describe, it, expect } from "vitest"
import { runFixture, ANCHOR, HOSTS, LOGLENS_SPAN, type Harness } from "./fixture.js"
import type { EntityEdge } from "../src/sweep.js"

/**
 * WHAT A MENTION PROVES.
 *
 * The free naming pass asks one question of the text — does this page write
 * that company's name — and until now it answered a second one it never asked:
 * that a seller writing a name is a seller positioning against a rival. On
 * `runs/sweep-figma-com-20260810060843.json` that reading made `competitor`
 * 1,071 of 2,461 edges, among them `figma.com -[competitor]-> a Substack
 * newsletter` on the evidence that a page said "Design with AI".
 *
 * Replaying that pass over the ten biggest maps' stored SERP rows, with the
 * anchor-imposter and `relation: none` fixes already applied so this is only
 * what those left behind: its competitor edges fall 9,657 -> 4,117 across the
 * ten — 405 -> 233 on figma, 2,521 -> 648 on shopify, 1,016 -> 441 on stripe.
 * The suites below are the rules that did it, each one small enough to read.
 *
 * NOT A FREE CUT. Sampled forty at a time and adjudicated by the run's own
 * model, 4 of 40 demoted figma pairs and 12 of 40 demoted stripe pairs really
 * do compete. The bar is worth it because what it keeps is truer than what it
 * drops, not because what it drops is all wrong — see the argument at the
 * `mention` mapping in sweep.ts.
 *
 * The paid co-occurrence pass is deliberately switched off in every case here.
 * It was audited for the same fault and does not have it — it sees both
 * descriptions before it answers, and on figma only 6 of its 58 competitor
 * edges point at something that does not sell — so the bar belongs on the
 * string match, and these tests must not be measuring the model instead.
 */

const OFFLINE = { sweepOptions: { skipModelLinking: true } }

/** The naming pass writes exactly this sentence, and nothing else does. */
const named = (h: Harness): EntityEdge[] =>
  (h.result.edges ?? []).filter((e) => /^a page on \S+ names "/.test(e.why))

const edge = (h: Harness, from: string, to: string): EntityEdge | undefined =>
  named(h).find((e) => e.from === from && e.to === to)

const hit = (host: string, title: string, description: string) => ({
  url: `https://${host}/`,
  title,
  description,
})

/**
 * A market where grepstack's own snippets name every other host in the run.
 *
 * One namer and three named, so each test below changes only what the NAMED
 * host was judged to be and reads the relation back. The queries are the
 * fixture's own, because `FakeSearch` refuses one it was not given and the
 * catalog script asks for these by name.
 */
const serpWhereGrepstackNamesEveryone = (mentions: string) => ({
  "log search": [
    hit(HOSTS.grepstack, "Grepstack — hosted log search", mentions),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
  ],
  "log search alternatives": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search."),
    hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
  ],
  "uptime monitoring": [
    hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks."),
    hit(HOSTS.forum, "The Ops Forum", "Alert fatigue threads."),
  ],
})

const said = (name: string, kind: string, relation: string, what: string, span: string) => ({
  name,
  kind,
  what,
  relation,
  why: `stands this way to ${ANCHOR} on the evidence of its own front page`,
  spans: [span],
})

/** Spans are literal substrings of this fixture's own front pages, so the
 *  gate passes and `what` is the sentence written here rather than the
 *  "could not be tied to its page" fallback. A test reading a fallback would
 *  still pass and would be measuring nothing. */
const GREPSTACK = said(
  "Grepstack",
  "company",
  "competitor",
  "A hosted log search vendor.",
  "Grepstack sells hosted log search to platform teams",
)
const TAILWATCH_SPAN = "log search and uptime checks in one console"
const FORUM = said(
  "The Ops Forum",
  "community",
  "discusses",
  "A forum for on-call engineers.",
  "argue about retention windows and alert fatigue",
)

describe("a seller's mention is not a rivalry", () => {
  it("names a newsletter and does not compete with it", async () => {
    // Real: figma.com -[competitor]-> designwithai.substack.com, because a page
    // wrote "Design with AI". After the two fixes already landed today that
    // Substack still collects 2 competitor edges from sellers on the current
    // code, and it is a newsletter.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackNamesEveryone("Reviewed this week in Loglens, the log tooling newsletter."),
      script: {
        classify: (host) =>
          host === HOSTS.grepstack
            ? GREPSTACK
            : host === HOSTS.loglens
              ? said("Loglens", "publisher", "covers", "A newsletter about log tooling.", LOGLENS_SPAN)
              : host === HOSTS.tailwatch
                ? said("Tailwatch", "company", "competitor", "A log search vendor.", TAILWATCH_SPAN)
                : FORUM,
      },
    })
    const e = edge(h, HOSTS.grepstack, HOSTS.loglens)
    expect(e?.why).toContain('names "Loglens"')
    expect(e?.relation).toBe("discusses")
  })

  it("names something it plugs into and does not compete with it", async () => {
    // Real, and the biggest single slice: 45 of figma's 99 surviving demotions
    // are a seller naming something the anchor's own classify pass called an
    // integration — the React it is built on, the Slack it ships into, the MCP
    // spec it implements. `handoff.com` alone collected six of them.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackNamesEveryone("Ships logs straight into Tailwatch dashboards."),
      script: {
        classify: (host) =>
          host === HOSTS.grepstack
            ? GREPSTACK
            : host === HOSTS.tailwatch
              ? said("Tailwatch", "company", "integration", "A console Grepstack ships into.", TAILWATCH_SPAN)
              : host === HOSTS.loglens
                ? said("Loglens", "company", "substitute", "A retention service.", LOGLENS_SPAN)
                : FORUM,
      },
    })
    expect(edge(h, HOSTS.grepstack, HOSTS.tailwatch)?.relation).toBe("discusses")
  })

  it("still calls a rival a rival", async () => {
    // The bar has to keep something. A rule that demoted every seller mention
    // would take figma's competitor count to zero and the map with it; this is
    // the case that must survive, and 233 of figma's 405 do.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackNamesEveryone("Buyers weigh us against Tailwatch on price per gigabyte."),
      script: {
        classify: (host) =>
          host === HOSTS.grepstack
            ? GREPSTACK
            : host === HOSTS.tailwatch
              ? said("Tailwatch", "company", "competitor", "A rival log search vendor.", TAILWATCH_SPAN)
              : host === HOSTS.loglens
                ? said("Loglens", "company", "substitute", "A retention service.", LOGLENS_SPAN)
                : FORUM,
      },
    })
    expect(edge(h, HOSTS.grepstack, HOSTS.tailwatch)?.relation).toBe("competitor")
  })

  it("asks the same of the namer — a dependency naming a rival is still a mention", async () => {
    // The rule is symmetric because the measurement said so. Of figma's 279
    // competitor edges surviving the target-side rule, 46 run FROM a host this
    // market placed as a dependency, integration or shaper; the run's own model
    // called 4 of 40 sampled there real rivalries, against 19 of 40 from the
    // 233 that run between two members of the rival set.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackNamesEveryone("Runs on top of Tailwatch storage."),
      script: {
        classify: (host) =>
          host === HOSTS.grepstack
            ? said("Grepstack", "company", "dependency", "Something this market builds on.", GREPSTACK.spans[0]!)
            : host === HOSTS.tailwatch
              ? said("Tailwatch", "company", "competitor", "A rival log search vendor.", TAILWATCH_SPAN)
              : host === HOSTS.loglens
                ? said("Loglens", "company", "substitute", "A retention service.", LOGLENS_SPAN)
                : FORUM,
      },
    })
    expect(edge(h, HOSTS.grepstack, HOSTS.tailwatch)?.relation).toBe("discusses")
  })

  it("leaves the channel kinds alone — covering is what a publication does", async () => {
    // A publisher naming a vendor genuinely covers it, and a forum genuinely
    // discusses one. The seller branch was the only one that did not follow
    // from the match, so it is the only one that moved.
    const h = await runFixture({
      ...OFFLINE,
      serp: {
        ...serpWhereGrepstackNamesEveryone("Hosted log search."),
        "uptime monitoring": [
          hit(HOSTS.forum, "The Ops Forum", "Long thread comparing Tailwatch retention settings."),
          hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks."),
        ],
      },
      script: {
        classify: (host) =>
          host === HOSTS.grepstack
            ? GREPSTACK
            : host === HOSTS.tailwatch
              ? said("Tailwatch", "company", "integration", "A console.", TAILWATCH_SPAN)
              : host === HOSTS.loglens
                ? said("Loglens", "company", "substitute", "A retention service.", LOGLENS_SPAN)
                : FORUM,
      },
    })
    expect(edge(h, HOSTS.forum, HOSTS.tailwatch)?.relation).toBe("discusses")
  })
})

describe("a spelling two entities answer to", () => {
  it("buys one edge, to the host that spells it", async () => {
    // Real: 10 spellings on figma's map are claimed twice, and they were paying
    // for 71 edges. "React" reached both react.dev and legacy.reactjs.org;
    // "zeroheight" both zeroheight.com and report.zeroheight.com. The pass had
    // no way to say which one the page meant, so it said both.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackNamesEveryone("Compared against Loglens on price per ingested gigabyte."),
      script: {
        classify: (host) =>
          host === HOSTS.grepstack
            ? GREPSTACK
            : host === HOSTS.loglens
              ? said("Loglens", "company", "competitor", "A retention service.", LOGLENS_SPAN)
              : host === HOSTS.tailwatch
                ? // The same name on a second host, which is how the archive
                  // domain and the apex both answer to one brand.
                  said("Loglens", "company", "competitor", "A mirror of the same service.", TAILWATCH_SPAN)
                : FORUM,
      },
    })
    const quoting = named(h).filter((e) => e.from === HOSTS.grepstack && e.why.includes('names "Loglens"'))
    expect(quoting).toHaveLength(1)
    expect(quoting[0]!.to).toBe(HOSTS.loglens)
  })
})

describe("the anchor, which is in its own market by construction", () => {
  it("competes with a rival it names, instead of being demoted to discussing it", async () => {
    // THE ONE EDGE CLASS A MARKET MAP EXISTS TO PUBLISH.
    //
    // `isRival` reads the relation classify wrote, and every relation is stated
    // FROM THE ANCHOR OUTWARD — so the anchor's own row can never say
    // `competitor`, because nothing competes with itself. figma.com's row says
    // `shaper`. With the predicate asked of both ends and the anchor failing
    // it, every anchor-touching edge was demoted: 309 of figma.com's 2,461,
    // each one "figma.com competes with X" rewritten as "figma.com discusses X".
    const h = await runFixture({
      ...OFFLINE,
      serp: {
        "log search": [
          hit(ANCHOR, "Pellucid — log search", "Teams switch to Pellucid from Tailwatch every week."),
          hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
        ],
        "log search alternatives": [
          hit(ANCHOR, "Pellucid", "Hosted log search."),
          hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
        ],
        "uptime monitoring": [
          hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks."),
          hit(HOSTS.forum, "The Ops Forum", "Alert fatigue threads."),
        ],
      },
      script: {
        classify: (host) =>
          host === HOSTS.tailwatch
            ? said("Tailwatch", "company", "competitor", "A log search vendor.", TAILWATCH_SPAN)
            : host === HOSTS.loglens
              ? said("Loglens", "publisher", "covers", "A newsletter about log tooling.", LOGLENS_SPAN)
              : FORUM,
      },
    })
    const e = edge(h, ANCHOR, HOSTS.tailwatch)
    expect(e, "the anchor named a rival and no naming edge was written").toBeDefined()
    expect(e?.relation).toBe("competitor")
  })

  it("still does not compete with a newsletter it names", async () => {
    // The anchor is admitted to the rival set, not exempted from the rule: the
    // OTHER end still has to be a seller placed against this market.
    const h = await runFixture({
      ...OFFLINE,
      serp: {
        "log search": [
          hit(ANCHOR, "Pellucid — log search", "Reviewed this week in Loglens, the log tooling newsletter."),
          hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
        ],
        "log search alternatives": [
          hit(ANCHOR, "Pellucid", "Hosted log search."),
          hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
        ],
        "uptime monitoring": [
          hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks."),
          hit(HOSTS.forum, "The Ops Forum", "Alert fatigue threads."),
        ],
      },
      script: {
        classify: (host) =>
          host === HOSTS.loglens
            ? said("Loglens", "publisher", "covers", "A newsletter about log tooling.", LOGLENS_SPAN)
            : host === HOSTS.tailwatch
              ? said("Tailwatch", "company", "competitor", "A log search vendor.", TAILWATCH_SPAN)
              : FORUM,
      },
    })
    expect(edge(h, ANCHOR, HOSTS.loglens)?.relation).toBe("discusses")
  })
})
