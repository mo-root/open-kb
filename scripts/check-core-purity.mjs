import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const FORBIDDEN = [
  [/process\s*\??\.\s*env/, "process.env — credentials are a parameter"],
  [/\b(document|window)\s*\??\./, "DOM API in a headless engine"],
  [/brightdata|openrouter|gemini/i, "vendor name in core"],
  [
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+Request\s*\(|(?:\bimport\s*\(\s*|\bfrom\s+|\brequire\(\s*)["']node:https?["']/,
    "HTTP framing — core declares a port, a provider implements it",
  ],
]

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith(".ts")) out.push(p)
  }
  return out
}

// Scan whole-file text, not line by line — a line-by-line scan lets a forbidden expression
// hide by wrapping across lines (e.g. `process\n  .env\n  .API_KEY`), where no single line
// contains the full match. Matching against the full text closes that gap; the line number for
// reporting is recovered by counting newlines before the match's start index.
const violations = []
for (const file of walk("packages/core/src")) {
  const text = readFileSync(file, "utf8")
  for (const [re, why] of FORBIDDEN) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
    let m
    while ((m = global.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length
      const snippet = m[0].replace(/\s+/g, " ").trim()
      violations.push(`${file}:${line}  ${why}\n    ${snippet}`)
      if (m[0].length === 0) global.lastIndex++ // guard against a hypothetical zero-length match
    }
  }
}

if (violations.length) {
  console.error("core purity violations:\n" + violations.join("\n"))
  process.exit(1)
}
console.log("core purity: clean")
