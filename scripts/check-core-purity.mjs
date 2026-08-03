import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const FORBIDDEN = [
  [/process\.env/, "process.env — credentials are a parameter"],
  [/\bdocument\.|window\./, "DOM API in a headless engine"],
  [/brightdata|openrouter|gemini/i, "vendor name in core"],
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

const violations = []
for (const file of walk("packages/core/src")) {
  const text = readFileSync(file, "utf8")
  text.split("\n").forEach((line, i) => {
    for (const [re, why] of FORBIDDEN) {
      if (re.test(line)) violations.push(`${file}:${i + 1}  ${why}\n    ${line.trim()}`)
    }
  })
}

if (violations.length) {
  console.error("core purity violations:\n" + violations.join("\n"))
  process.exit(1)
}
console.log("core purity: clean")
