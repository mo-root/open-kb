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
 * checks — the four sweep prompts spent their whole life as template literals
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
    // Placeholders survive composition — they are filled at call time, not here.
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
