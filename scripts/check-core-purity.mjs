import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const FORBIDDEN = [
  [/process\s*\??\.\s*env/, "process.env — credentials are a parameter"],
  [/\b(document|window)\s*\??\./, "DOM API in a headless engine"],
  [/brightdata|openrouter|gemini/i, "vendor name in core"],
  [
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+Request\s*\(|(?:\bimport\s*\(\s*|\bfrom\s+|\brequire\(\s*)["']node:https?["']/,
    "HTTP framing — core declares a port, a provider implements it",
  ],
]

// THE SCAN ROOT IS NOT AN ARGUMENT, and that decision is the whole of this
// file's interface.
//
// tests/purity.test.ts proves this gate goes red by planting a probe file and
// watching it fail, so the probe has to land somewhere the gate reads. It used
// to land in packages/core/src itself, deleted by an afterEach — and a run that
// never reaches its afterEach leaves a probe inside the real source tree, where
// it fails this gate, sometimes fails `tsc -b` as well, and has already tripped
// a third guard that had nothing to do with any of it. So the probe moved to a
// temp dir, and this gate had to learn to read a directory that is not core.
//
// The obvious way to teach it is `--root <dir>`, and it is the wrong way. A
// gate that takes its root can be handed an empty directory and will answer
// "core purity: clean" — a green over nothing, indistinguishable from the green
// that means something. Right now this gate cannot be neutered without editing
// it; a root argument would make one word in package.json enough, and the
// lesson of every guard in this directory is that a guard which CAN go quiet
// eventually does.
//
// `--also` cannot subtract. Core is scanned on every invocation, whatever the
// arguments say; the flag adds a directory and no flag removes one. The
// self-test gets its probe read, and the weakening a root argument would have
// enabled does not exist to be made loud. Two smaller refusals close the way
// back in: a scan that finds zero .ts files is a failure rather than a clean,
// and any argument this file does not recognise stops the run instead of being
// read as a path.

const ROOT = resolve(import.meta.dirname, "..")

/** Always scanned. Resolved against this file rather than against cwd, where the
 *  bare relative path it used to be only found core when the gate happened to be
 *  invoked from the repo root. */
const CORE = join(ROOT, "packages/core/src")

/** Repo-relative where that reads better, absolute where it does not — an
 *  `--also` directory is a temp dir with no useful path back here. */
function display(p) {
  const r = relative(ROOT, p)
  return r.startsWith("..") ? p : r.split("\\").join("/")
}

/** Being invoked wrongly is not core being impure, and must not read like it.
 *  Exit 2 says the gate did not run; exit 1 stays reserved for a real violation. */
function refuse(lines) {
  console.error(`core purity: DID NOT RUN —\n${lines}`)
  process.exit(2)
}

const extra = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--also") {
    const dir = argv[++i]
    if (dir === undefined) refuse("  `--also` needs a directory after it.")
    extra.push(resolve(dir))
  } else {
    refuse(
      `  unrecognised argument \`${arg}\`.\n` +
        `  The only flag is \`--also <dir>\`, and it ADDS a directory to the scan.\n` +
        `  Nothing moves or narrows it: ${display(CORE)} is read on every run.`,
    )
  }
}

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith(".ts")) out.push(p)
  }
  return out
}

/** A directory's .ts files, and never an empty list.
 *
 *  Zero files scanned reports "clean", which is the one answer this gate must
 *  never give for a reason that has nothing to do with core. An unreadable path
 *  used to throw readdirSync's ENOENT stack — loud, at least, and better than
 *  the empty directory, which came back green. Both are the same refusal now,
 *  because both mean the gate did not look at what it was told to look at. That
 *  covers core too: the day packages/core/src is moved or renamed, this says so
 *  instead of certifying its absence. */
function filesUnder(dir, what) {
  let found = []
  try {
    found = walk(dir)
  } catch (err) {
    refuse(`  ${what} could not be read: ${dir}\n  ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!found.length) {
    refuse(
      `  ${what} holds no .ts files: ${dir}\n` +
        `  A scan of nothing comes back clean, and that clean would mean nothing.`,
    )
  }
  return found
}

const coreFiles = filesUnder(CORE, "core")
const alsoFiles = extra.map((dir) => [dir, filesUnder(dir, "the `--also` directory")])
const files = [...coreFiles, ...alsoFiles.flatMap(([, f]) => f)]

// Scan whole-file text, not line by line — a line-by-line scan lets a forbidden expression
// hide by wrapping across lines (e.g. `process\n  .env\n  .API_KEY`), where no single line
// contains the full match. Matching against the full text closes that gap; the line number for
// reporting is recovered by counting newlines before the match's start index.
const violations = []
for (const file of files) {
  const text = readFileSync(file, "utf8")
  for (const [re, why] of FORBIDDEN) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
    let m
    while ((m = global.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length
      const snippet = m[0].replace(/\s+/g, " ").trim()
      violations.push(`${display(file)}:${line}  ${why}\n    ${snippet}`)
      if (m[0].length === 0) global.lastIndex++ // guard against a hypothetical zero-length match
    }
  }
}

if (violations.length) {
  console.error("core purity violations:\n" + violations.join("\n"))
  process.exit(1)
}

// The count is part of the verdict, not decoration. "clean" alone reads the same
// over 26 files as over none, and the whole hazard this file guards against is a
// green that covered nothing.
// Counted per root, not as one total. `files.length` attributed every `--also`
// file to core — "27 files under packages/core/src" when 26 were — which is the
// one form of this message that is not literally true, in the line whose whole
// job is making a green say how much it covered. It is also what lets a caller
// prove the extra directory was actually READ: a gate that accepts `--also` and
// discards it still prints the directory's name, and only the count differs.
const also = alsoFiles.map(([dir, f]) => `, plus ${f.length} under ${display(dir)}`).join("")
console.log(`core purity: clean — ${coreFiles.length} files under ${display(CORE)}${also}`)
