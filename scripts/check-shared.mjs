import { execFileSync } from "node:child_process"
import { relative, resolve } from "node:path"

/**
 * What `check-skips.mjs` and `check-test-collection.mjs` both needed and, until
 * now, each typed out separately: `rel`, `run` and the `.test.`/`.spec.` file
 * pattern were byte-identical in both files (found by `jscpd`, which had never
 * been run over `scripts/` before). The two scripts stay deliberately
 * independent on the thing their own doc comments call out — collection reads
 * `vitest list` against `git ls-files`, skips reads GATES against a source
 * scan, and neither set is derived from the other. Sharing this file does not
 * touch that: `rel`/`run` are generic path/subprocess glue with no opinion
 * about either set, and `TEST_FILE` is the one piece of the "what counts as a
 * test file" decision that WAS already shared in substance, just copy-pasted —
 * the exact "closed set that will disagree with itself" risk this repo has
 * fixed before (see the `sweptFromRival` precedent in packages/sweep/src/
 * sweep.ts), one typo in either copy away from the two guards quietly
 * disagreeing about which files are tests.
 */

export const ROOT = resolve(import.meta.dirname, "..")

/** Vitest's own default include is wider than this repo's `.test.` convention
 *  (`.spec.` too) — see check-test-collection.mjs's doc comment for why both
 *  guards look for `.spec.` as well, on purpose, rather than only `.test.`. */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** Repo-relative POSIX paths, the spelling both authorities are normalized to. */
export function rel(p) {
  return relative(ROOT, resolve(ROOT, p)).split("\\").join("/")
}

export function run(cmd, args) {
  // stdio: "pipe" — execFileSync's default echoes the child's stderr to this
  // process's own, which would spray vitest's banner into `pnpm check` output
  // on every clean run; capture both and only surface them when the child
  // actually fails.
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" })
  } catch (err) {
    const e = /** @type {{ stdout?: string; stderr?: string }} */ (err)
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`)
  }
}
