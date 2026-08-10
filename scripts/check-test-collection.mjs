import { execFileSync } from "node:child_process"
import { relative, resolve } from "node:path"

// Fails when a test file exists on disk and the suite would not run it.
//
// This repo has been bitten by silent uncollection twice: once for real, when a
// store's whole test file sat outside `include` and the suite went green over
// untested code, and once latently, when `packages/web/components/**/*.test.ts`
// could not match the `.test.tsx` a component test would actually be called. A
// pattern fix closes an instance. Nothing closed the CLASS, because the symptom
// of the class is the absence of a symptom — no error, no skip, no red, just a
// file nobody runs. Only a check that compares the two sets can see it.
//
// The two sets are derived from different authorities on purpose. A guard that
// restated the include globs and then matched files against them would prove
// only that the globs were typed twice and agree with themselves.
//
//   collected — `vitest list`, i.e. vitest resolving the real vitest.config.ts
//               with its real defaults. Not a reimplementation of it: whatever
//               the suite would actually run is what this reads.
//   on disk   — `git ls-files`, tracked plus untracked-and-not-ignored. Git is
//               already this repo's definition of what is first-party, which is
//               why it needs no exclude list of its own. node_modules, dist,
//               inspiration/ and runs/ are ignored and drop out. The
//               `.claude/worktrees/` copy of this repo drops out twice over: by
//               .git/info/exclude, and structurally, because ls-files does not
//               descend through a nested repo boundary — it reports the whole
//               worktree as one directory entry, so its 215 test files can never
//               be mistaken for ours even if the exclude line disappeared.
//
// This complements the typecheck that tsconfig.root.json puts on
// vitest.config.ts rather than repeating it. That one reads the file as
// TypeScript and catches a config that is malformed or misspelled; a config can
// be perfectly well typed and still address nothing, which is precisely the bug
// both incidents were. Types cannot tell you a glob is empty.
//
// The suffix set is stated here rather than derived from the config, and that is
// the load-bearing independence. Deriving it would make the guard agree with any
// mistake in the config by construction — a config that collected `*.spec.ts`
// would send this looking for `.spec.ts` files, find none, and pass while every
// real test went unrun. So it is written down once, independently, and it is
// deliberately WIDER than the include: any executable source named `*.test.*` is
// a test. A `foo.test.mjs` is not collected by today's config, and this will say
// so instead of letting it rot — the fix being to rename it or widen the config,
// either of which is a decision someone made on purpose.
//
// `spec` as well as `test`, and that one word is the difference between this
// guard working and this guard being the bug it was written about. Vitest's own
// default include is `**/*.{test,spec}.?(c|m)[jt]s?(x)`, so `.spec.` is a
// first-class convention in this ecosystem — a `Foo.spec.tsx` written from
// muscle memory, or copied out of another vitest project, is the likeliest way
// a test goes missing here. Without this word such a file was collected by
// nothing AND flagged by nothing: silence twice over, in the one place built to
// end it. This repo's convention is `.test.`, and the point is not to run both
// spellings but to make deviating from ours loud instead of silent.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

const ROOT = resolve(import.meta.dirname, "..")

/** Repo-relative POSIX paths, the spelling both authorities are normalized to. */
function rel(p) {
  return relative(ROOT, resolve(ROOT, p)).split("\\").join("/")
}

function run(cmd, args) {
  // stdio inherit for stderr would spray vitest's banner into `pnpm check` output on every
  // clean run; capture both and only surface them when the child actually fails.
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" })
  } catch (err) {
    const e = /** @type {{ stdout?: string; stderr?: string }} */ (err)
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`)
  }
}

/** What vitest would run, straight from vitest. */
function collected() {
  // --json prints absolute paths as [{ file }]; the plain form prints bare lines that would
  // be ambiguous the day vitest adds a banner to it. Parse the machine format.
  const out = run("node_modules/.bin/vitest", ["list", "--filesOnly", "--json"])
  const parsed = JSON.parse(out)
  if (!Array.isArray(parsed)) throw new Error("`vitest list --json` did not return an array")
  return new Set(parsed.map((entry) => rel(entry.file)))
}

/** Every first-party file on disk, per git, filtered to the ones that are tests. */
function onDisk() {
  // -z, because a filename may contain a newline and git quotes such paths in the default
  // output — which would silently drop exactly the file this guard exists to notice.
  const out = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  return new Set(
    out
      .split("\0")
      .filter(Boolean)
      .map(rel)
      .filter((p) => TEST_FILE.test(p)),
  )
}

const seen = collected()
const present = onDisk()

// Under-collection: the bug. A test file exists and nothing runs it.
const uncollected = [...present].filter((p) => !seen.has(p)).sort()

// Over-collection: the failure mode an "everything except" include would have, kept as a
// guard so that widening the include later cannot quietly start running a vendored
// checkout's or another agent's worktree's suite as if it were ours.
const foreign = [...seen].filter((p) => !present.has(p)).sort()

const problems = []
if (uncollected.length) {
  problems.push(
    `${uncollected.length} test file(s) on disk that nothing collects —\n` +
      `they are neither passing nor failing, they simply do not run.\n` +
      `Add the directory to \`include\` in vitest.config.ts, or rename the file:\n` +
      uncollected.map((p) => `    ${p}`).join("\n"),
  )
}
if (foreign.length) {
  problems.push(
    `${foreign.length} file(s) collected that git does not consider part of this repo —\n` +
      `\`include\` in vitest.config.ts is reaching outside the source tree:\n` +
      foreign.map((p) => `    ${p}`).join("\n"),
  )
}

if (problems.length) {
  console.error("test collection:\n" + problems.join("\n\n"))
  process.exit(1)
}
console.log(`test collection: clean — ${seen.size} files, all of them on disk and all of them run`)
