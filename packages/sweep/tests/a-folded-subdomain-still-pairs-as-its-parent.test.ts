import { describe, it, expect } from "vitest"
import { runFixture, HOSTS, type Harness, type LinkPair } from "./fixture.js"

/**
 * THE FOLD WAS APPLIED TO THE ENTITIES AND NOT TO THE PAIRS.
 *
 * `byHost` keys every retrieved row by `parentOf(host)`, so a row on `docs.`,
 * `blog.` or `api.` is filed as its parent company's evidence — that is what
 * makes `docs.apify.com` and `apify.com` one row on the map instead of two. The
 * co-occurrence selector then re-derived the host straight from the url with no
 * fold and dropped anything not in `keptHosts`, which holds parents. So every
 * SERP row that arrived on a folded subdomain was invisible to pair selection,
 * permanently, after the run had already paid to retrieve it and had already
 * decided whose evidence it was.
 *
 * MEASURED: 3,726 rows corpus-wide, 1,906 of 49,143 (3.9%) on the runs written
 * by the current engine.
 *
 * The market below is the pure case — the only evidence joining two vendors
 * arrives on one of them's docs subdomain — so the pair exists after the fold
 * and does not exist without it.
 */

const hit = (host: string, title: string, description: string) => ({
  url: `https://${host}/`,
  title,
  description,
})

const DOCS = `docs.${HOSTS.grepstack}`

/**
 * Two queries that each return grepstack's DOCS host beside tailwatch, and
 * nothing else that pairs. Neither snippet names the other company, so the free
 * naming pass answers nothing and the pair has to survive to the paid pass to
 * be visible at all.
 */
const serp = {
  "log search": [
    hit(DOCS, "Grepstack docs — query syntax", "How to search stored log lines."),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
  ],
  "log search alternatives": [
    hit(DOCS, "Grepstack docs — retention", "How long ingested logs are kept."),
    hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks from nine regions."),
  ],
}

const pairsAsked = (h: Harness, seen: LinkPair[]): LinkPair[] => {
  expect(h.calls.some((c) => c.phase === "link")).toBe(true)
  return seen
}

const has = (pairs: LinkPair[], a: string, b: string) =>
  pairs.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))

describe("a row that arrived on a docs subdomain", () => {
  it("pairs as the company it was filed under", async () => {
    const seen: LinkPair[] = []
    const h = await runFixture({
      serp,
      script: { link: (pairs) => (seen.push(...pairs), { edges: [] }) },
    })
    const pairs = pairsAsked(h, seen)
    expect(
      has(pairs, HOSTS.grepstack, HOSTS.tailwatch),
      "the only evidence for this pair arrived on a folded subdomain and the selector never saw it",
    ).toBe(true)
  }, 30_000)

  it("counts toward the two-query floor exactly as its parent's own rows do", async () => {
    // The floor is the selector's whole defence against noise: one shared query
    // is what any two pages of a broad search have in common. A folded row that
    // counted for nothing did not weaken the floor, it removed pairs from
    // consideration — which is why both of these rows have to be counted, not
    // just seen.
    const seen: LinkPair[] = []
    const h = await runFixture({
      serp,
      script: { link: (pairs) => (seen.push(...pairs), { edges: [] }) },
    })
    const pair = pairsAsked(h, seen).find(
      (p) =>
        (p.a === HOSTS.grepstack && p.b === HOSTS.tailwatch) ||
        (p.b === HOSTS.grepstack && p.a === HOSTS.tailwatch),
    )
    expect(pair?.seen).toBe(2)
    // And the subdomain is still not an entity of its own: the fold decides
    // identity, this only makes the selector agree with it.
    expect(h.result.entities.some((e) => e.domain === DOCS)).toBe(false)
  }, 30_000)
})
