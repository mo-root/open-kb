import { describe, it, expect } from "vitest"
import { runFixture, defaultScript, ANCHOR, SERP } from "./fixture.js"

/**
 * MEASURED bug, on a live cursor.com run: the anchor's own host reached the
 * judge and came back `kind: company, relation: competitor` — the model
 * arguing Cursor competes with Cursor. The anchor's own domain can legitimately
 * show up in someone else's search results (a "vs" page, a listicle that names
 * it alongside its rivals), and until this guard existed that was enough to
 * queue it for a fetch and a judgement like any other host.
 *
 * Excluded at `hostList` construction, before triage or `judgeHosts` ever sees
 * the row — so the fix has to show up as an ABSENCE: no fetch, no classify
 * call, no entity, even when the model is scripted to hand back exactly the
 * wrong verdict if it is ever asked.
 */

describe("the anchor is never its own competitor", () => {
  it("is excluded before the judge ever sees it — never fetched by the pool, never classified, never an entity", async () => {
    const h = await runFixture({
      // The anchor's own domain, surfaced by an ordinary search result —
      // exactly the shape a "vs" page or a listicle produces.
      serp: {
        ...SERP,
        "log search": [
          ...SERP["log search"]!,
          { url: `https://${ANCHOR}/`, title: "Pellucid — log search", description: "Also shows up in its own market's results." },
        ],
      },
      script: {
        // Scripted to hand back the measured bug's exact verdict if it is
        // ever asked — the test fails loudly if the guard regresses instead
        // of silently passing because nobody would have said this anyway.
        classify: (host, prompt) =>
          host === ANCHOR
            ? {
                name: "Pellucid",
                kind: "company",
                what: "A hosted observability suite for small platform teams.",
                relation: "competitor",
                why: "the wrong verdict this guard exists to prevent",
                spans: ["Pellucid runs log search and uptime alerts"],
              }
            : defaultScript().classify(host, prompt),
      },
    })

    // Never classified: the rank pool's one paid question was never asked
    // about the anchor's own host.
    expect(h.calls.filter((c) => c.phase === "classify" && c.subject === ANCHOR)).toEqual([])

    // Never fetched BY THE JUDGE POOL: `understand` reads the anchor's own
    // front page twice on its own, legitimately, before rank ever starts —
    // once in the surfaces loop that learns what it sells, once more
    // gathering nav links for its own product pages. Two is the ceiling for
    // those two free, unrelated reads; a third would be the rank pool paying
    // to read it again.
    const anchorFrontPageFetches = h.fetch.calls.filter((c) => c.url === `https://${ANCHOR}/`)
    expect(anchorFrontPageFetches).toHaveLength(2)

    // Never an entity, regular or otherwise — not even wearing a refusal.
    // The anchor is the map's subject, not a node on it.
    expect(h.result.entities.find((e) => e.domain === ANCHOR)).toBeUndefined()
  })
})
