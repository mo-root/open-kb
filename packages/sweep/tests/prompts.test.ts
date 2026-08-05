import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { composePrompt } from "@open-kb/core"
import { RELATIONS, ENTITY_KINDS } from "../src/sweep.js"

/**
 * The prompts are the product.
 *
 * Every instruction a paid model run receives lives in `prompts/` so it can be
 * read and edited without touching TypeScript. That only stays true if something
 * checks, the four sweep prompts spent their whole life as template literals
 * buried in `sweep.ts` while `prompts/` sat beside them describing an agent that
 * this pipeline never runs, and nothing noticed.
 *
 * These are the checks that would have noticed.
 */

function root(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "prompts", "doctrine"))) return join(dir, "prompts")
    dir = dirname(dir)
  }
  throw new Error("no prompts/")
}

const AGENTS = ["understand", "catalog", "assess", "classify"]

describe("the sweep's prompts", () => {
  it.each(AGENTS)("%s composes with its doctrine", (agent) => {
    const composed = composePrompt(agent, join(root(), "agents"), join(root(), "doctrine"))
    expect(composed.length).toBeGreaterThan(200)
    // Placeholders survive composition, they are filled at call time, not here.
    expect(composed).toMatch(/\{\{\w+\}\}/)
  })

  /**
   * The drift this exists to catch, stated plainly: `02-relations.md` opened with
   * "The five relations" for as long as the code had eight, and then eleven. The
   * classifier was being handed a vocabulary list that was missing most of the
   * words it was required to choose from.
   */
  it("documents every relation the code will accept", () => {
    const doc = readFileSync(join(root(), "doctrine", "02-relations.md"), "utf8")
    const undocumented = RELATIONS.filter((r) => r !== "none" && !doc.includes(`**${r}**`))
    expect(undocumented).toEqual([])
  })

  it("documents the escape hatch and what it costs", () => {
    const doc = readFileSync(join(root(), "doctrine", "02-relations.md"), "utf8")
    expect(doc).toContain("**none**")
  })

  it("names every entity kind the classifier must choose between", () => {
    const p = readFileSync(join(root(), "agents", "classify.md"), "utf8")
    const unnamed = ENTITY_KINDS.filter((k) => !p.includes(k))
    expect(unnamed).toEqual([])
  })
})

/**
 * The classify prompt is sent once per host. A measured live run made 740 such
 * calls, and ~75% of its 3.19M input tokens were the same ~13K chars of
 * composed doctrine re-sent every time — breadth doctrine, search craft,
 * reading-the-web narrative, none of which a per-host judge can act on: it
 * fetches nothing and plans nothing. The prompt was trimmed to carry only what
 * one judgement needs. These tests keep the win from silently regressing and
 * keep the trim from cutting the one thing that must never be cut: the full
 * relation vocabulary, because a judge choosing from words it was never given
 * poisons every judgement.
 */
describe("the composed classify prompt", () => {
  const composed = () => composePrompt("classify", join(root(), "agents"), join(root(), "doctrine"))

  it("stays small enough to send 740 times without dominating the bill", () => {
    // Measured 12,996 chars before the trim; ~4K after. The ceiling leaves
    // headroom for wording, not for re-including a doctrine file.
    expect(composed().length).toBeLessThan(6_000)
  })

  it("still carries the whole relation vocabulary, every word the schema will accept", () => {
    const c = composed()
    const missing = RELATIONS.filter((r) => !c.includes(`**${r}**`))
    expect(missing).toEqual([])
  })

  it("keeps the de-branding warning — ranking market vocabulary is not selling", () => {
    expect(composed()).toContain("RANKS, COMPARES or REVIEWS")
  })

  it("keeps exactly the placeholders the rank call renders with", () => {
    // render() throws on any mismatch between these and the call-site's vars,
    // so a drift here would fail at runtime, on a paid call. Fail here instead.
    const found = new Set([...composed().matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))
    expect([...found].sort()).toEqual(["anchor", "buyer", "host", "intents", "page", "seenIn", "sells"])
  })
})
