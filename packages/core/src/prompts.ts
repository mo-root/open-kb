import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface LoadedPrompt {
  frontmatter: Record<string, string>
  body: string
}

/**
 * Minimal frontmatter reader. The filename is the identity: a prompt whose `agent`
 * disagrees with its filename is a bug that must fail loudly rather than run silently.
 * A silent mismatch is how a system ends up running a prompt nobody thinks it runs.
 */
export function loadPrompt(name: string, dir: string): LoadedPrompt {
  const raw = readFileSync(join(dir, `${name}.md`), "utf8")
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!m) throw new Error(`${name}.md has no frontmatter`)
  const frontmatter: Record<string, string> = {}
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim())
    if (kv) frontmatter[kv[1]!] = kv[2]!.trim()
  }
  const key = frontmatter.agent ?? frontmatter.doctrine
  if (key && key !== name) throw new Error(`${name}.md declares "${key}" — filename and identity must match`)
  return { frontmatter, body: m[2]!.trim() }
}

/** Compose an agent prompt with the doctrine files it declares in `includes`. */
export function composePrompt(agent: string, agentsDir: string, doctrineDir: string): string {
  const a = loadPrompt(agent, agentsDir)
  const includes = (a.frontmatter.includes ?? "")
    .replace(/[[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const parts = includes.map((d) => loadPrompt(d, doctrineDir).body)
  return [...parts, a.body].join("\n\n---\n\n")
}
