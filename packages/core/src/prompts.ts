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

/**
 * Fill `{{name}}` placeholders in a prompt body.
 *
 * Deliberately strict: a placeholder with no value THROWS rather than rendering
 * as an empty string or as the literal `{{name}}`. A prompt is the instruction a
 * paid model run receives, and silently sending it with a hole where the buyer
 * description should be produces a plausible, expensive, wrong answer that looks
 * exactly like a right one. Failing here costs nothing.
 *
 * The reverse — a value with no placeholder — throws too. It means the caller
 * believes it is saying something the model never sees, which is the same class
 * of bug read from the other end.
 */
export function render(body: string, vars: Record<string, string | number>): string {
  const wanted = new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))
  const given = new Set(Object.keys(vars))

  const missing = [...wanted].filter((k) => !given.has(k))
  if (missing.length) throw new Error(`prompt is missing values for: ${missing.join(", ")}`)

  const unused = [...given].filter((k) => !wanted.has(k))
  if (unused.length) throw new Error(`prompt has no placeholder for: ${unused.join(", ")}`)

  return body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k]))
}
