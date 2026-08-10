import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

// Says out loud which suites are dark in THIS environment, and fails when a
// suite went dark without anyone declaring it.
//
// scripts/check-test-collection.mjs closed one silence: a test file that
// nothing collects. This closes the next one along, which is not the same bug
// and is not caught by that guard. A test can be collected, be counted in the
// file total, and still not run — `describe.skipIf` marks it skipped, and what
// the reporter does with that is the whole problem. A file where EVERY test is
// gated gets a down-arrow, which is at least a mark. A file where only some
// are gated gets a green tick:
//
//     ✓ packages/web/lib/kb-from-run.test.ts (43 tests | 2 skipped) 14ms
//     ✓ packages/core/tests/drift.test.ts    (16 tests | 1 skipped)  4ms
//
// Those are the two lines a runner prints, and they are ticks. Three of the
// four tests that stop running on a clean checkout are behind them.
//
// The reason that matters is measured, not theoretical. A `git clone` of this
// repo into an empty directory — committed state, so no gitignored files —
// installs and passes:
//
//     local        59 files passed / 2 skipped     1022 tests passed / 4 skipped
//     clean clone  58 files passed / 3 skipped     1018 tests passed / 8 skipped
//
// Four tests are the difference, and all four read a real run out of `runs/`,
// which is gitignored because those files are megabytes of paid output. A CI
// runner is a clean clone by definition, so CI's green is permanently the
// weaker of the two greens and nothing in the output says which one you are
// looking at. `58 passed` and `59 passed` are both green. The one arrow that
// separates them is the same arrow the two live suites have always printed, so
// it reads as normal even on the day it stops being normal — and the other
// three tests do not even cost an arrow.
//
// Committing a fixture to open those three gates was considered and rejected.
// The suites are named "the live run's 127 dead ends", "two real swarm runs of
// one anchor" and "segments of the real brightdata run"; every assertion in
// them is a count taken from one specific paid run. A hand-authored stand-in
// would let those names go green over numbers nobody measured, which is worse
// than a skip — a skip is at least honest about being absent. The gates stay
// shut on a runner. What changes is that they are now shut IN WRITING.
//
// Two authorities, and they are deliberately different ones:
//
//   the manifest — GATES below, hand-written: file, suite title, what opens the
//                  gate, and why it is gated at all. This is the artefact a
//                  human reads to learn what a green run did not cover.
//   the source   — `git ls-files`, filtered to test files, scanned for skip
//                  constructs. Git is already this repo's definition of
//                  first-party, the same reason check-test-collection.mjs
//                  leans on it. Every construct found must be declared and
//                  every declaration must still be found, so the manifest
//                  cannot drift in either direction: a new `.skipIf` nobody
//                  wrote down fails, and a stale entry for a gate somebody
//                  deleted fails too.
//
// A third input decides which gates are shut right now, and it is emphatically
// NOT the manifest re-evaluating `existsSync(runs/…)` or reading OPENKB_LIVE.
// Restating a condition and then checking it agrees with itself proves only
// that it was typed twice. `vitest list --json` omits skipped tests — that is
// its documented behaviour and the reason it returns 1022 here and 1018 on a
// runner — so asking vitest which suites it can see IS asking vitest which
// gates are open, with vitest resolving the real conditions in the real
// environment.
//
// The census itself never fails the build. A gate being shut is not an error;
// OPENKB_LIVE is unset on purpose and `runs/` cannot exist on a runner. Making
// either one red would only teach people to ignore a red. The failure is
// reserved for the case that is genuinely a mistake: a suite that stopped
// running and was not written down.

const ROOT = resolve(import.meta.dirname, "..")

/**
 * Every conditionally-skipped suite in the repo.
 *
 * `suite` is the describe title verbatim; the scan below refuses to pass unless
 * it finds that exact string at that exact construct, so renaming a suite and
 * forgetting this file is a failure rather than a silently orphaned entry.
 */
const GATES = [
  {
    file: "tests/live/brightdata.live.test.ts",
    suite: "brightdata live",
    opens: "OPENKB_LIVE=1",
    why: "spends money — real Bright Data SERP and Unlocker calls against live hosts",
  },
  {
    file: "tests/live/investigator.live.test.ts",
    suite: "investigator, live",
    opens: "OPENKB_LIVE=1",
    why: "spends money — a real model round-trip through OpenRouter, plus the fetches it decides to make",
  },
  {
    file: "packages/sweep/tests/dead-end-smoke.test.ts",
    suite: "the live run's 127 dead ends",
    opens: "runs/sweep-brightdata-com-202608051650.json",
    why: "asserts counts taken from one paid sweep; `runs/` is gitignored, so a clean checkout never has it",
  },
  {
    file: "packages/core/tests/drift.test.ts",
    suite: "two real swarm runs of one anchor",
    opens: "runs/swarm-brightdata-com-202608052348.json + …202608060151.json",
    why: "diffs two real swarm runs of the same anchor; `runs/` is gitignored, so a clean checkout never has them",
  },
  {
    file: "packages/web/lib/kb-from-run.test.ts",
    suite: "segments of the real brightdata run",
    opens: "runs/sweep-brightdata-com-202608051650.json",
    why: "derives markets from one paid sweep; `runs/` is gitignored, so a clean checkout never has it",
  },
  {
    file: "packages/web/lib/runs.test.ts",
    suite: "a runs directory that refuses to be read",
    opens: "a non-root uid on a filesystem with mode bits — `chmod` has to actually bite",
    why: "builds EACCES with `chmod 000` rather than mocking fs, and root bypasses the permission check outright while Windows has no mode bits worth the name; on either the fixture is an ordinary readable directory and every assertion about a refusal passes for the wrong reason",
  },
]

/**
 * Skip constructs, spelled wider than this repo's conventions on purpose.
 *
 * `describe.skipIf` is the only form in use today. The others are here because
 * the failure this guard exists to prevent arrives as whichever form somebody
 * reaches for next — `it.skip` while debugging, `.todo` for a stub, `.runIf`
 * for the same gate written inside out. `.only` earns its place too: vitest
 * fails a run containing one when CI is set, but only on a runner, hours later,
 * and this says so on the machine where it was typed. `.fails` is deliberately
 * absent — that test runs, and asserting a throw is not a silence.
 */
const SKIP_CONSTRUCT = /\b(?:describe|suite|it|test)\s*(?:\.\s*[a-zA-Z]+\s*)*?\.\s*(skip|skipIf|todo|runIf|only)\b/g

/** Repo-relative POSIX paths, the spelling every authority is normalized to. */
function rel(p) {
  return relative(ROOT, resolve(ROOT, p)).split("\\").join("/")
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" })
  } catch (err) {
    const e = /** @type {{ stdout?: string; stderr?: string }} */ (err)
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`)
  }
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** Every skip construct in a first-party test file, per git and a read of the text. */
function sourceSites() {
  // -z for the same reason check-test-collection.mjs uses it: git quotes paths
  // containing a newline in the default output, and a quoted path would drop
  // exactly the file this guard is looking for.
  const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map(rel)
    .filter((p) => TEST_FILE.test(p))

  const sites = []
  for (const file of files) {
    const text = readFileSync(resolve(ROOT, file), "utf8")
    for (const m of text.matchAll(SKIP_CONSTRUCT)) {
      sites.push({
        file,
        form: m[1],
        line: text.slice(0, m.index).split("\n").length,
        // The title follows the gate expression, and that expression may contain
        // parentheses of its own, so this reads a window rather than parsing a
        // call. 400 characters covers a formatted multi-line describe and stops
        // well short of the next one.
        after: text.slice(m.index, m.index + 400),
      })
    }
  }
  return sites
}

/**
 * What vitest can see here, straight from vitest. `list` omits skipped tests, so
 * a gate is open exactly when its suite's tests show up in this.
 */
function collected() {
  const parsed = JSON.parse(run("node_modules/.bin/vitest", ["list", "--json"]))
  if (!Array.isArray(parsed)) throw new Error("`vitest list --json` did not return an array")
  return parsed.map((e) => ({ file: rel(e.file), name: String(e.name) }))
}

const sites = sourceSites()
const problems = []

// Manifest -> source. A declared gate must still be where it says it is, under
// the title it says it has.
const matched = new Set()
for (const gate of GATES) {
  const hit = sites.find(
    (s) => s.file === gate.file && !matched.has(s) && s.after.includes(JSON.stringify(gate.suite)),
  )
  if (hit) matched.add(hit)
  else
    problems.push(
      `declared gate not found in the source:\n` +
        `    ${gate.file} › ${gate.suite}\n` +
        `  GATES in this file lists it, but no skip construct there is followed by that title.\n` +
        `  If the suite was renamed or the gate removed, update GATES to match.`,
    )
}

// Source -> manifest. The half that actually catches the new silence.
for (const s of sites) {
  if (matched.has(s)) continue
  problems.push(
    `undeclared skip:\n` +
      `    ${s.file}:${s.line}  .${s.form}\n` +
      `  This suite can stop running without anyone being told. Add it to GATES in\n` +
      `  scripts/check-skips.mjs with what opens it and why it is gated, or remove the skip.`,
  )
}

if (problems.length) {
  console.error("skip census:\n" + problems.join("\n\n"))
  process.exit(1)
}

// The census. Not a verdict — a sentence, printed on every run, on every
// machine, so that the difference between two greens is readable instead of
// being four tests wide and invisible.
const seen = collected()
const open = new Set(
  GATES.filter((g) => seen.some((t) => t.file === g.file && t.name.startsWith(`${g.suite} > `))).map((g) => g.suite),
)
const dark = GATES.filter((g) => !open.has(g.suite))

const lines = [
  `skip census: ${seen.length} tests will run here — ${GATES.length} gated suites, ${dark.length} of them dark.`,
]
for (const g of GATES) {
  const shut = !open.has(g.suite)
  lines.push(`    ${shut ? "dark" : "runs"}  ${g.file} › ${g.suite}`)
  if (shut) lines.push(`          opens with ${g.opens}`)
  if (shut) lines.push(`          ${g.why}`)
}
if (dark.length) {
  lines.push(
    `    A green run here is a green over ${GATES.length - dark.length} of ${GATES.length} gated suites, not all of them.`,
  )
}
console.log(lines.join("\n"))
