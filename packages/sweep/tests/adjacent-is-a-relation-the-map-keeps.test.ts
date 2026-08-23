import { describe, it, expect } from "vitest"
import { runFixture, defaultScript, HOSTS } from "./fixture.js"
import { onMap } from "../src/sweep.js"

/**
 * `adjacent` is a real relation, not a refusal: it sits in `RELATIONS`
 * between `substitute` and `dependency`, and an entity classified `adjacent`
 * has to behave exactly like a `competitor` or a `substitute` everywhere else
 * in the pipeline — it stays on the map, it carries every field a classified
 * entity carries.
 *
 * The same fixture run also proves the classify schema's other new fields:
 * `reasoning` and `relationSpan` land on the entity, and `relationSpan` is
 * checked against the page it was quoted from — `relationGrounded` records
 * whether it verified, and never gates the verdict either way (the same rule
 * `descGrounded` lives by).
 */

describe("the adjacent relation", () => {
  it("keeps its full field set, verifies its relationSpan, and stays on the map", async () => {
    const h = await runFixture({
      script: {
        classify: (host, prompt) =>
          host === HOSTS.grepstack
            ? {
                name: "Grepstack",
                kind: "company",
                what: "A hosted log search vendor selling to platform teams.",
                relation: "adjacent",
                why: "sells into the same platform-team workflow, but nobody has to choose one over the other",
                spans: ["Grepstack sells hosted log search to platform teams"],
                reasoning: "shares the anchor's buyer and workflow without being an instead-of choice",
                // A literal substring of the extra paragraph every fixture
                // page carries (see fixture.ts's page() helper) — real page
                // text, not grepstack's own headline sentence.
                relationSpan: "it bills on ingested volume rather than per seat",
              }
            : defaultScript().classify(host, prompt),
      },
    })

    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    expect(e.relation).toBe("adjacent")
    // A real relation, not a refusal: onMap treats it exactly like any other.
    expect(onMap(e)).toBe(true)

    // The rest of the classify answer travelled with it, unchanged by being
    // "adjacent" rather than "competitor".
    expect(e.kind).toBe("company")
    expect(e.what).toBe("A hosted log search vendor selling to platform teams.")
    expect(e.spans).toEqual(["Grepstack sells hosted log search to platform teams"])
    expect(e.settledBy).toBe("model")

    // The new fields, wired all the way to the stored entity.
    expect(e.reasoning).toBe("shares the anchor's buyer and workflow without being an instead-of choice")
    expect(e.relationSpan).toBe("it bills on ingested volume rather than per seat")
    expect(e.relationGrounded).toBe(true)

    // And it still went through the ordinary attribution pass — roads,
    // seenIn — the same as any other kept entity, "adjacent" or not.
    expect(e.seenIn).toBeGreaterThan(0)
    expect(e.roads?.length).toBeGreaterThan(0)
  })

  it("an unverifiable relationSpan is measured, never gated — the relation still stands", async () => {
    const h = await runFixture({
      script: {
        classify: (host, prompt) =>
          host === HOSTS.grepstack
            ? {
                name: "Grepstack",
                kind: "company",
                what: "A hosted log search vendor selling to platform teams.",
                relation: "adjacent",
                why: "sells into the same platform-team workflow, but nobody has to choose one over the other",
                spans: ["Grepstack sells hosted log search to platform teams"],
                reasoning: "shares the anchor's buyer and workflow without being an instead-of choice",
                relationSpan: "a sentence that appears nowhere on this page",
              }
            : defaultScript().classify(host, prompt),
      },
    })
    const e = h.result.entities.find((x) => x.domain === HOSTS.grepstack)!
    // The unverified span changes nothing about the verdict itself.
    expect(e.relation).toBe("adjacent")
    expect(onMap(e)).toBe(true)
    expect(e.relationSpan).toBe("a sentence that appears nowhere on this page")
    expect(e.relationGrounded).toBe(false)
  })
})
