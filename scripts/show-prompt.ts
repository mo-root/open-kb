/**
 * Print exactly what an agent receives as its system prompt.
 *
 * The doctrine is composed from markdown at runtime, so what the model reads is never visible in
 * any one file. This prints the real thing.
 *
 *   npx tsx scripts/show-prompt.ts investigator
 *   npx tsx scripts/show-prompt.ts investigator --stats
 */
import { readdirSync } from "node:fs"
import { loadPrompt, composePrompt } from "../packages/core/src/prompts.js"

const AGENTS = "prompts/agents"
const DOCTRINE = "prompts/doctrine"

export interface PromptShare {
  name: string
  lines: number
  chars: number
  /** Share of the composed prompt's total chars, rounded to the nearest percent. */
  sharePct: number
}

export interface PromptStats {
  agent: string
  includes: PromptShare[]
  own: PromptShare
  totalLines: number
  totalChars: number
  composed: string
}

/**
 * The measurement `--stats` prints: share of the prompt is share of the
 * agent's attention. Had zero test coverage anywhere — every line of this
 * script ran unconditionally at import time (argv, `readdirSync`, a possible
 * `process.exit(1)`), so nothing could import it without also running its
 * CLI. Pulled the arithmetic out, pure, and gated the CLI body below behind
 * the same `invokedDirectly` guard `scripts/run-doctor.ts` already uses for
 * the identical reason.
 */
export function promptStats(name: string, agentsDir: string, doctrineDir: string): PromptStats {
  const agent = loadPrompt(name, agentsDir)
  const includes = (agent.frontmatter.includes ?? "")
    .replace(/[[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const composed = composePrompt(name, agentsDir, doctrineDir)
  const share = (body: string) => Math.round((body.length / composed.length) * 100)

  return {
    agent: name,
    includes: includes.map((d) => {
      const body = loadPrompt(d, doctrineDir).body
      return { name: d, lines: body.split("\n").length, chars: body.length, sharePct: share(body) }
    }),
    own: { name: `(${name} itself)`, lines: agent.body.split("\n").length, chars: agent.body.length, sharePct: share(agent.body) },
    totalLines: composed.split("\n").length,
    totalChars: composed.length,
    composed,
  }
}

/** Only when run as a command. Same guard shape as `scripts/run-doctor.ts`. */
const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {
  const name = process.argv[2] ?? "investigator"
  const statsOnly = process.argv.includes("--stats")

  const available = readdirSync(AGENTS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))

  if (!available.includes(name)) {
    console.error(`No such agent: ${name}\nAvailable: ${available.join(", ")}`)
    process.exit(1)
  }

  const stats = promptStats(name, AGENTS, DOCTRINE)

  if (!statsOnly) {
    console.log(stats.composed)
    console.log("\n" + "=".repeat(78) + "\n")
  }

  console.log(`agent      ${stats.agent}`)
  console.log(`includes   ${stats.includes.length} doctrine file${stats.includes.length === 1 ? "" : "s"}`)
  for (const d of stats.includes) {
    console.log(`  ${d.name.padEnd(22)} ${String(d.lines).padStart(4)} lines  ${String(d.chars).padStart(6)} chars  ${String(d.sharePct).padStart(3)}% of prompt`)
  }
  console.log(`  ${stats.own.name.padEnd(22)} ${String(stats.own.lines).padStart(4)} lines  ${String(stats.own.chars).padStart(6)} chars  ${String(stats.own.sharePct).padStart(3)}% of prompt`)
  console.log(`\ntotal      ${stats.totalLines} lines, ${stats.totalChars} chars`)
  console.log(`\nShare of the prompt is share of the agent's attention. If something is not happening,`)
  console.log(`check whether the file telling it to happen is 3% of what it reads.`)
}
