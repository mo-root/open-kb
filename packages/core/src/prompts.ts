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

/**
 * Split a frontmatter `includes` field, e.g. `"[01-a, 02-b]"`, into an ordered
 * list of doctrine names. Exported because `scripts/show-prompt.ts`'s
 * `promptStats` needs the individual names (one row per doctrine file) and
 * not just the joined body `composePrompt` returns — before this export it
 * hand-copied this exact five-line chain, so a change here (a new frontmatter
 * shape, a different separator) could compose one prompt while `--stats`
 * silently reported the shares of another.
 */
export function parseIncludes(raw: string | undefined): string[] {
  return (raw ?? "")
    .replace(/[[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Compose an agent prompt with the doctrine files it declares in `includes`. */
export function composePrompt(agent: string, agentsDir: string, doctrineDir: string): string {
  const a = loadPrompt(agent, agentsDir)
  const includes = parseIncludes(a.frontmatter.includes)
  const parts = includes.map((d) => loadPrompt(d, doctrineDir).body)
  return [...parts, a.body].join("\n\n---\n\n")
}

/**
 * Fill `{{name}}` placeholders in a prompt body.
 *
 * Throws on a placeholder with no value, and on a value with no placeholder.
 * Both mean the prompt sent to a paid model call differs from the one the
 * caller wrote.
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
