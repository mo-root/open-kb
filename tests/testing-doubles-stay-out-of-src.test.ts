import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * The fakes are reachable, and not from production.
 *
 * `@open-kb/core` gained a second export the day `sweep()` gained a port seam:
 * `@open-kb/core/testing`, holding `FakeSearch` and `FakeFetch`. Before that the
 * doubles lived at a path only `packages/core`'s own tests could reach, which
 * is why `packages/swarm` carries two hand-rolled copies of them and the sweep
 * was about to grow a third.
 *
 * Widening a package's `exports` widens what every workspace package can
 * import, and the thing being made importable here is a search port that
 * answers from a table and charges nothing. A production caller that reached it
 * would not fail — it would return an empty result set, cost $0, and report a
 * map of a market it never searched. That failure has no exception in it
 * anywhere, which is precisely why the reach has to be impossible rather than
 * merely unwise.
 *
 * Two things stop it. The subpath is not in the barrel, so `from "@open-kb/core"`
 * cannot land there by autocomplete or by accident. And this file: any
 * first-party module that ships — every `src/`, the web app's own directories,
 * and `scripts/`, all of which run against real credentials — is read here, and
 * naming the subpath fails the suite.
 *
 * The guard is a text scan, so its whole risk is watching a string nobody uses.
 * The second test closes that: if no test imports the subpath either, the
 * pattern is stale and this file is asserting nothing.
 */

/** An IMPORT of the subpath, not a mention of it. The doubles' own file
 *  discusses its address in a comment, and so does this one. */
// Both spellings. The first draft matched only the bare specifier, and the
// relative path is the idiom `scripts/` already uses everywhere — so a script
// running against real credentials could import FakeSearch by path and report
// a $0 map of a market it never searched, with nothing going red and no
// compiler error to catch it either.
const IMPORTS =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)["'][^"']*(?:@open-kb\/core\/testing|testing\/fake-provider)[^"']*["']/

/** First-party TypeScript the repo contains, split by whether it ships.
 *  `--others --exclude-standard` includes files not yet committed: a guard that
 *  only read the index would go green on the very change that introduces the
 *  violation, which is the one moment it is needed. */
function tracked(): { ships: string[]; tests: string[] } {
  const all = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
  const isTest = (p: string) => /(^|\/)(tests?)\//.test(p) || /\.(test|spec)\.tsx?$/.test(p)
  const isFirstParty = (p: string) =>
    p.startsWith("packages/") || p.startsWith("scripts/") || p.startsWith("tests/")
  return {
    ships: all.filter((p) => isFirstParty(p) && !isTest(p) && !p.includes("/dist/")),
    tests: all.filter((p) => isTest(p)),
  }
}

describe("the testing doubles", () => {
  it("are imported by nothing that ships", () => {
    const { ships } = tracked()
    // A guard reading zero files reports clean, and that clean would mean
    // nothing — the same refusal `scripts/check-core-purity.mjs` makes.
    expect(ships.length).toBeGreaterThan(50)
    const offenders = ships.filter((p) => IMPORTS.test(readFileSync(p, "utf8")))
    expect(offenders).toEqual([])
  })

  it("are imported by something, so this file is watching a live string", () => {
    const { tests } = tracked()
    const users = tests.filter((p) => IMPORTS.test(readFileSync(p, "utf8")))
    expect(users.length).toBeGreaterThan(0)
  })
})
