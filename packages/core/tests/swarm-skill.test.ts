import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadPrompt } from "../src/prompts.js"
import { computeScorecard, scorecardSentences } from "../src/scorecard.js"

const PATH = "prompts/swarm/skill.md"

/**
 * The swarm's ONE skill file — shared doctrine plus the two role sections, read by both the
 * lead and the investigators. It is loaded from disk at runtime, so nothing in the type system
 * notices if it bloats past what a model will read, grows a placeholder nobody fills, or loses
 * the section that made a live failure stop happening. These assertions are that notice.
 */
describe("swarm skill", () => {
  const raw = readFileSync(PATH, "utf8")
  const skill = loadPrompt("skill", "prompts/swarm")

  it("declares itself the swarm skill", () => {
    expect(skill.frontmatter.skill).toBe("swarm")
  })

  it("stays inside the size the design budgeted", () => {
    // The design prices the skill at ~3.2k tokens because it is re-sent on every lead turn and
    // handed whole to every investigator. Every line competes with every other for attention —
    // the doctrine's own lesson: a run once recorded none of twelve competitors because the
    // guidance that mattered was one thin paragraph among rich ones.
    expect(raw.length).toBeLessThan(13_000)
    // And a floor: a skill this short cannot carry the doctrine, both roles, and the vocabulary.
    expect(raw.length).toBeGreaterThan(8_000)
  })

  it("takes no placeholders — the harness prefixes one line, nothing is rendered", () => {
    // Unlike the sweep's agent prompts, this file is never passed through render(). A {{name}}
    // left here would reach the model as literal braces on every turn of every run.
    expect(raw).not.toMatch(/\{\{\w+\}\}/)
  })

  it("holds its three sections in order: doctrine, then LEAD, then INVESTIGATOR", () => {
    const doctrine = raw.indexOf("# Doctrine")
    const lead = raw.indexOf("# LEAD")
    const investigator = raw.indexOf("# INVESTIGATOR")
    expect(doctrine).toBeGreaterThan(-1)
    expect(lead).toBeGreaterThan(doctrine)
    expect(investigator).toBeGreaterThan(lead)
  })

  it("carries the de-branding thesis", () => {
    expect(raw).toContain("the anchor's shadow")
    expect(raw).toContain("the market's own vocabulary finds the market")
  })

  it("states the evidence bar and shows what the mint's refusals look like", () => {
    expect(raw).toContain("literal substring of bytes this run fetched")
    // The rejection sentences are quoted so the agent recognises them as feedback, not errors —
    // and only sentences the cite-by-URL path can actually emit. "no such handle" is the store's
    // sentence for a bad handle; remember cites by URL, so the un-fetched-URL sentence is the
    // one a model will really see.
    expect(raw).toContain("quote not present in")
    expect(raw).toContain("nothing was fetched from")
    expect(raw).toContain("feedback, not")
  })

  it("teaches note-writing: the what says what the host IS, the why never restates it", () => {
    // The swarm's own-page notes on run 3 (runs/swarm-brightdata-com-
    // 202608060151.json): 6 of 12 whys were the relation label restated —
    // "Primary direct enterprise competitor" — evidence of nothing. The
    // classify prompt carries the long form of these rules; the skill carries
    // the sentence-sized form, and this keeps it from being trimmed away.
    expect(raw).toContain("A `what` says what the host IS")
    expect(raw).toContain("praise is not a capability")
    expect(raw).toContain("never the what again")
  })

  it("downgrades rather than deletes, and retraction carries a why", () => {
    expect(raw).toContain("downgraded, not deleted")
    expect(raw).toContain("`retract` carries a why")
    // The downgrade is no longer silent: remember returns the refused claim
    // with its remedy, and the skill teaches the row so the model acts on it.
    expect(raw).toContain("`downgraded` row")
  })

  it("divides the spending: the lead buys questions, investigators buy pages", () => {
    // Live run 1's lesson: sixteen lead turns, thirty-three of the lead's own
    // searches, one mission, zero pages fetched — every commercial claim died
    // at the gate. Each of these sentences is that run's counter-instruction.
    expect(raw).toContain("you buy questions; investigators buy pages")
    expect(raw).toContain("spending the map's money on one context's guesses")
    expect(raw).toContain("fetch the target's apex page")
  })

  it("requires the host's own front page behind a commercial claim, remedy quoted byte for byte", () => {
    expect(raw).toContain("fetch that host's own front page THIS mission")
    // The exact hint tools-free.ts returns with <host> filled in — the swarm
    // package's own tests assert the same sentence from the template side, so
    // skill and tool cannot drift apart without one of the two suites failing.
    expect(raw).toContain('"fetch https://<host>/ and cite its own page to establish a commercial relation"')
  })

  it("names cost as tiers and never as models", () => {
    for (const tier of ["peek", "read", "dig"]) expect(raw).toContain(`**${tier}**`)
    // "Model choice is exposed to the lead only as a cost word, never as a model id" — the
    // design's sentence. A model name here would pin the skill to a vendor and teach the
    // agent to reason about rates instead of sizes.
    expect(raw).not.toMatch(/gemini|gpt|claude|openai|anthropic|opus|sonnet|haiku|flash/i)
  })

  it("carries the dense-headings judgement and the empty-200 lore", () => {
    // The 615KB / five-headings counter-example is a paragraph of judgement, not a branch in
    // fetch: the harness never decides how a page should be read.
    expect(raw).toContain("615KB")
    expect(raw).toContain("HTTP 200 and an empty body")
    expect(raw).toContain("{host, mode}")
  })

  it("includes the compact vocabulary the classifier shares", () => {
    for (const kind of ["company", "product", "capability", "buyer", "community"]) {
      expect(raw, `kind "${kind}" missing`).toContain(`**${kind}**`)
    }
    for (const rel of [
      "competitor", "substitute", "shaper", "dependency", "integration",
      "target", "covers", "lists", "discusses", "unknown",
    ]) {
      expect(raw, `relation "${rel}" missing`).toContain(`**${rel}**`)
    }
    expect(raw).toContain("The map is the ecosystem, not the shortlist")
  })

  it("quotes the machine's own yield sentence byte for byte — the skill and the scorecard cannot drift", () => {
    // The old teaching ("the last six landings produced 2 new companies...")
    // drifted from what the scorecard actually says: different verb, noun,
    // and count basis. Now the skill quotes the sentence the machine renders
    // from the design's illustrative history, computed here rather than
    // hardcoded, so a wording change in yieldSentence fails this test before
    // it teaches the lead a sentence it will never see.
    const sc = computeScorecard({
      families: [],
      entities: [],
      spendableUsd: 0,
      ceilingUsd: 1,
      spentUsd: 0,
      elapsedMs: 0,
      wallMs: 1_000,
      yieldHistory: [3, 3, 2, 2, 2, 2, 1, 1, 0, 0, 0, 0],
      recall: { pooled: null, probes: [] },
    })
    const yieldLine = scorecardSentences(sc).find((l) => l.startsWith("the last"))
    expect(yieldLine).toBe("the last 6 landings added 2 nodes; the 6 before added 14")
    expect(raw).toContain(`"${yieldLine}"`)
  })

  it("teaches the one-refusal finish exchange, the gate's tail quoted byte for byte", () => {
    // The literal below is the skill-side pin of GATE_REFUSAL_TAIL; the swarm
    // package's tools-control tests assert the same bytes from the exported
    // constant's side, so the skill and the gate cannot drift apart without
    // one of the two suites failing (the commercialDowngradeHint precedent).
    expect(raw).toContain(
      '"; finishing now records these as unresolved — address them or carry them into unresolved verbatim; your next finish stands"',
    )
    // And the dedup rule the tail relies on: unresolved carries the gate's
    // exact words, because a paraphrase records the same objection twice.
    expect(raw).toContain("verbatim")
  })

  it("tells the lead when to stop thinking: a dry, spawn-less turn has exactly two moves", () => {
    // Live run 3 (runs/swarm-brightdata-com-202608060151.json): the lead built
    // the night's best map — 12 nodes, all own-page tier, $1.37 — then sat 14
    // consecutive spawn-less, finish-less turns re-reading it, the scorecard
    // armed in its notes the whole time, until the 24-turn loop detector fired.
    // Run 2's lead failed the other way: finished at turn 20 with $3.55
    // unspent. The skill taught the yield curve and the gate's exchange but
    // never said WHEN to stop; these sentences are that lesson. Whether a
    // model obeys them is not offline-testable — that verification is the
    // next live run. What is testable is that the lesson stays in the file.
    expect(raw).toContain("you have exactly two moves")
    expect(raw).toContain("Reading the map again is not a move")
    expect(raw).toContain("spends the run's money on hesitation")
    // The only number in the lesson is the measured failure, never a turn
    // budget — the cap belongs to the harness, and the skill already names it
    // a loop detector, not a budget.
    expect(raw).toContain("One lead sat fourteen such turns")
  })

  it("gives the lead its band, its re-entry, its review seat, and its ending", () => {
    expect(raw).toContain("61–100")
    expect(raw).toContain("dedupeKey")
    expect(raw).toContain("next({after:{landings, seconds}, why})")
    expect(raw).toContain("review({promote, kill, why})")
    expect(raw).toContain("finish(reason, summary, unresolved[])")
    expect(raw).toContain("yield curve")
  })

  it("gives the investigator one mission, the coinage ban, and the map as its output", () => {
    expect(raw).toContain("ONE mission")
    expect(raw).toContain("coinage")
    expect(raw).toContain("The map is your output, not your return value")
    expect(raw).toContain("1–60")
    expect(raw).toContain("wake:true")
    expect(raw).toContain("120 tokens")
  })
})
