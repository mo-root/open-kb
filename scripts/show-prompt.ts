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

const name = process.argv[2] ?? "investigator"
const statsOnly = process.argv.includes("--stats")

const available = readdirSync(AGENTS)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""))

if (!available.includes(name)) {
  console.error(`No such agent: ${name}\nAvailable: ${available.join(", ")}`)
  process.exit(1)
}

const agent = loadPrompt(name, AGENTS)
const includes = (agent.frontmatter.includes ?? "")
  .replace(/[[\]]/g, "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const composed = composePrompt(name, AGENTS, DOCTRINE)

if (!statsOnly) {
  console.log(composed)
  console.log("\n" + "=".repeat(78) + "\n")
}

const lines = composed.split("\n").length
console.log(`agent      ${name}`)
console.log(`includes   ${includes.length} doctrine file${includes.length === 1 ? "" : "s"}`)
for (const d of includes) {
  const body = loadPrompt(d, DOCTRINE).body
  const share = ((body.length / composed.length) * 100).toFixed(0)
  console.log(`  ${d.padEnd(22)} ${String(body.split("\n").length).padStart(4)} lines  ${String(body.length).padStart(6)} chars  ${share.padStart(3)}% of prompt`)
}
const own = agent.body
console.log(`  ${("(" + name + " itself)").padEnd(22)} ${String(own.split("\n").length).padStart(4)} lines  ${String(own.length).padStart(6)} chars  ${String(((own.length / composed.length) * 100).toFixed(0)).padStart(3)}% of prompt`)
console.log(`\ntotal      ${lines} lines, ${composed.length} chars`)
console.log(`\nShare of the prompt is share of the agent's attention. If something is not happening,`)
console.log(`check whether the file telling it to happen is 3% of what it reads.`)
