import { describe, it, expect } from "vitest"
import { runFixture, HOSTS, LOGLENS_SPAN, type Harness } from "./fixture.js"
import type { EntityEdge } from "../src/sweep.js"

/**
 * A NAME STORED IN CAPITALS IS NOT A LICENCE TO MATCH THE WORD.
 *
 * `namesIt` asks one question of a page — does it write this company's name —
 * and answered it case-insensitively, which is right for "figma" and wrong for
 * a name the classify pass stored shouted. On
 * `runs/sweep-figma-com-20260810173400.json` the entity `user.com.sg`, a
 * Singapore UX agency named "USER", collected 141 edges — second only to the
 * anchor's 251 — from reddit, medium, youtube and g2, every one of them a page
 * saying user interface or user testing. The exact spelling "USER" occurs 0
 * times in that run's 5,061 titles and descriptions; the case-insensitive form
 * occurs 316.
 *
 * Replayed over all 28 runs in `runs/` that carry their SERP rows, matching an
 * all-capitals term exactly removes 682 of 42,058 name-derived edges, invents
 * none, changes no relation, leaves every anchor's in-degree alone, and costs
 * no entity whose name is not all-capitals a single edge. Roughly 60 of the
 * 682 are real: an acronym brand a page wrote in mixed case, "Nvidia, AMD,
 * Broadcom". Roughly, because that line is a reading and not a measurement.
 *
 * The three cases below are the whole rule: the word is not the name, the
 * shout still is, and a Capitalised name is left exactly as it was — which is
 * the boundary that matters, because most of this bug lives on that side and
 * case cannot reach it. See the argument at `namesIt` in sweep.ts.
 *
 * The paid co-occurrence pass is off in every case here, so these read the
 * string match and nothing else.
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
 * One namer, and what its own snippets say is the only variable.
 *
 * The queries are the fixture's own, because `FakeSearch` refuses one it was
 * not given. `tailwatch.example` is the named host in every case: its
 * registrable host spells "watch", so the one-spelling-one-owner rule hands
 * the term to it rather than dropping the pair, and whether the edge exists is
 * decided by the case test alone.
 */
const serpWhereGrepstackSays = (mentions: string) => ({
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
  why: `stands this way to the anchor on the evidence of its own front page`,
  spans: [span],
})

/** Literal substrings of the fixture's own front pages, so the span gate
 *  passes and these entities carry the sentence written here rather than the
 *  "could not be tied to its page" fallback. */
const GREPSTACK = said(
  "Grepstack",
  "company",
  "competitor",
  "A hosted log search vendor.",
  "Grepstack sells hosted log search to platform teams",
)
const TAILWATCH_SPAN = "log search and uptime checks in one console"
const LOGLENS = said("Loglens", "publisher", "covers", "A newsletter about log tooling.", LOGLENS_SPAN)
const FORUM = said(
  "The Ops Forum",
  "community",
  "discusses",
  "A forum for on-call engineers.",
  "argue about retention windows and alert fatigue",
)

/** The market, with the named host's stored name as the only knob. */
const marketWhereTailwatchIsCalled = (name: string) => ({
  classify: (host: string) =>
    host === HOSTS.grepstack
      ? GREPSTACK
      : host === HOSTS.tailwatch
        ? said(name, "company", "competitor", "A log search vendor.", TAILWATCH_SPAN)
        : host === HOSTS.loglens
          ? LOGLENS
          : FORUM,
})

describe("a name the run stores in capitals", () => {
  it("is not named by a page that merely uses the word", async () => {
    // The bug, at fixture scale. "WATCH" is an ordinary English word stored
    // shouted, exactly as "USER", "TODAY", "FIRST", "BILL" and "CORE" are in
    // the runs on disk; a page writing the word in lower case has not heard of
    // the company, and under a case-insensitive match it bought an edge
    // anyway. That is 141 of figma's edges, 112 of openai's, 93 of
    // cloudflare's.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackSays("We watch every container so you do not have to."),
      script: marketWhereTailwatchIsCalled("WATCH"),
    })
    expect(
      edge(h, HOSTS.grepstack, HOSTS.tailwatch),
      "a page using the ordinary word bought an edge to the company spelled that way",
    ).toBeUndefined()
  })

  it("is named by a page that shouts it back", async () => {
    // The rule has to keep something, and this is the half it keeps: a writer
    // who means the company writes it the way the company does. nvidia.com
    // keeps 11 of its 14 edges on the vercel run this way — "NVIDIA DGX
    // Cloud", "NVIDIA GPUs" — and loses the 3 that said "Nvidia".
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackSays("Buyers weigh us against WATCH on price per gigabyte."),
      script: marketWhereTailwatchIsCalled("WATCH"),
    })
    expect(edge(h, HOSTS.grepstack, HOSTS.tailwatch)?.why).toContain('names "WATCH"')
  })

  it("leaves a Capitalised name matched the way it always was", async () => {
    // THE BOUNDARY, and the reason this fix is small. On the reference run
    // 3,340 of 4,714 titles of three or more real words capitalise nearly all
    // of them, so "Handoff" in "Design Handoff Best Practices" is spelled
    // exactly like Handoff the company and no case rule can tell them apart.
    // Matching every name case-sensitively was measured
    // instead of assumed: it takes sketch.com 75 -> 63, handoff.com 74 -> 51,
    // batch.com 50 -> 38 without finishing any of them, and on cloudflare it
    // takes nginx.org 84 -> 16 for the crime of being styled lowercase. So
    // only the shouted cohort moved, and this is the test that says so.
    const h = await runFixture({
      ...OFFLINE,
      serp: serpWhereGrepstackSays("Reviewed beside tailwatch on price per gigabyte."),
      script: marketWhereTailwatchIsCalled("Tailwatch"),
    })
    expect(edge(h, HOSTS.grepstack, HOSTS.tailwatch)?.why).toContain('names "Tailwatch"')
  })
})
