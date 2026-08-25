import { describe, expect, it } from "vitest"
import { promptStats } from "../scripts/show-prompt.js"

const AGENTS = "prompts/agents"
const DOCTRINE = "prompts/doctrine"

/**
 * `promptStats` (the arithmetic behind `scripts/show-prompt.ts --stats`) had
 * no test anywhere — the whole file ran at import time (argv, `readdirSync`,
 * a possible `process.exit(1)`), so nothing could import it at all. Coverage
 * gap found sweeping `scripts/*.ts beyond sweep.ts` (D-scope: "areas nobody
 * has swept"). Fixed by extracting this function and gating the CLI body
 * behind the same `invokedDirectly` guard `scripts/run-doctor.ts` already
 * uses.
 */
describe("promptStats", () => {
  it("splits a composed prompt into one share per doctrine include, plus the agent's own body", () => {
    // investigator declares six includes — the richest agent on disk, so
    // every share this function computes is exercised at once.
    const stats = promptStats("investigator", AGENTS, DOCTRINE)

    expect(stats.agent).toBe("investigator")
    expect(stats.includes.map((s) => s.name)).toEqual([
      "01-the-thesis",
      "02-relations",
      "03-evidence",
      "04-search-craft",
      "05-reading-the-web",
      "06-breadth",
    ])
    expect(stats.own.name).toBe("(investigator itself)")

    // Every share is a real measurement, not a placeholder: positive lines
    // and chars, and a composed prompt whose total is at least the sum of
    // its parts (the `\n\n---\n\n` join separators account for the rest).
    for (const part of [...stats.includes, stats.own]) {
      expect(part.lines).toBeGreaterThan(0)
      expect(part.chars).toBeGreaterThan(0)
      expect(part.sharePct).toBeGreaterThan(0)
      expect(part.sharePct).toBeLessThanOrEqual(100)
    }
    const summedChars = stats.includes.reduce((n, s) => n + s.chars, 0) + stats.own.chars
    expect(stats.totalChars).toBeGreaterThanOrEqual(summedChars)
    expect(stats.totalLines).toBeGreaterThan(0)
    expect(stats.composed.length).toBe(stats.totalChars)

    // Rounded independently, so the shares only APPROXIMATE 100 — the join
    // separators and rounding both eat a few points. Loose bound on purpose.
    const summedShare = stats.includes.reduce((n, s) => n + s.sharePct, 0) + stats.own.sharePct
    expect(summedShare).toBeGreaterThan(90)
    expect(summedShare).toBeLessThanOrEqual(100)
  })

  it("reads an agent with exactly one include", () => {
    const stats = promptStats("link", AGENTS, DOCTRINE)
    expect(stats.includes.map((s) => s.name)).toEqual(["02-relations"])
  })

  it("reads an agent with no includes at all as an empty list, not a crash", () => {
    // classify.md's frontmatter has no `includes:` key — `?? ""` is the only
    // thing standing between that and a throw on `.replace` of undefined.
    const stats = promptStats("classify", AGENTS, DOCTRINE)
    expect(stats.includes).toEqual([])
    // With nothing else in the composed prompt, the agent's own body is the
    // entire thing — its share rounds to 100.
    expect(stats.own.sharePct).toBe(100)
    expect(stats.totalChars).toBe(stats.own.chars)
  })

  it("throws on an agent name with no such file, the same way loadPrompt does", () => {
    expect(() => promptStats("no-such-agent", AGENTS, DOCTRINE)).toThrow()
  })
})
