import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadPrompt } from "../src/prompts.js"

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
    // The rejection sentences are quoted so the agent recognises them as feedback, not errors.
    expect(raw).toContain("quote not present in")
    expect(raw).toContain("no such handle")
    expect(raw).toContain("feedback, not")
  })

  it("downgrades rather than deletes, and retraction carries a why", () => {
    expect(raw).toContain("downgraded, not deleted")
    expect(raw).toContain("`retract` carries a why")
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

  it("gives the lead its band, its re-entry, and its ending", () => {
    expect(raw).toContain("61–100")
    expect(raw).toContain("dedupeKey")
    expect(raw).toContain("next({after:{landings, seconds}, why})")
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
