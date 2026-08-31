import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultPricingFor, FLOOR, MODEL_PRICES, priceForModel } from "../src/pricing.js"
import type { DiscoverOptions, InvestigateOptions, ModelPricing } from "@open-kb/core"

/** What every script and both engines default to. Written out here on purpose:
 *  this string plus its two numbers is the regression, so the test states them
 *  rather than reading them back out of the thing under test. */
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash"

describe("priceForModel", () => {
  /* Read off the table rather than restated. The first draft of this test wrote
     the numbers out a second time, which meant correcting a stale row made the
     test red for being right — a guard that has to be edited whenever the truth
     changes is a guard that will eventually be edited to match a lie. What is
     worth pinning is the mapping, not the digits. */
  it("prices every known id at its table row", () => {
    for (const [id, row] of Object.entries(MODEL_PRICES)) {
      expect(priceForModel(id)).toEqual(row)
    }
    expect(Object.keys(MODEL_PRICES).length).toBeGreaterThan(1)
  })

  /**
   * The bug as it was billed. Both discovery scripts hardcoded the fallback row
   * as this model's actual price while defaulting to this model, so a run that
   * cost three cents printed a bill near seventy. Pin the row, and pin that it
   * is not the fallback.
   */
  it("prices the default model at its own row, not the conservative fallback", () => {
    const row = MODEL_PRICES[DEFAULT_MODEL]
    expect(row, `${DEFAULT_MODEL} must be in the table — it is what everything defaults to`).toBeDefined()
    expect(priceForModel(DEFAULT_MODEL)).toEqual(row)
    // The shape of the bug: the fallback row standing in for a known model's
    // real price. Pinned against the fallback as computed, not as a literal.
    expect(priceForModel(DEFAULT_MODEL)).not.toEqual(priceForModel("someone/model-nobody-has-priced"))
  })

  /**
   * The fallback is a decision, not an oversight: a model nobody has priced is
   * the one to be pessimistic about, and over-reporting is the safe direction
   * for a spend ceiling. Anyone "fixing" it to zero, or to something cheap,
   * breaks this.
   */
  it("prices an id it has not met at the dearest number in every column", () => {
    const unknown = priceForModel("someone/model-nobody-has-priced")
    const rows = Object.values(MODEL_PRICES)
    expect(unknown.inUsdPerM).toBe(Math.max(...rows.map((r) => r.inUsdPerM)))
    expect(unknown.outUsdPerM).toBe(Math.max(...rows.map((r) => r.outUsdPerM)))
    for (const row of rows) {
      expect(unknown.inUsdPerM).toBeGreaterThanOrEqual(row.inUsdPerM)
      expect(unknown.outUsdPerM).toBeGreaterThanOrEqual(row.outUsdPerM)
    }
  })

  it("never prices anything at zero — a run that looks free is worse than one that looks dear", () => {
    for (const id of [...Object.keys(MODEL_PRICES), "", "someone/model-nobody-has-priced"]) {
      const p = priceForModel(id)
      expect(p.inUsdPerM).toBeGreaterThan(0)
      expect(p.outUsdPerM).toBeGreaterThan(0)
    }
  })
})

/**
 * `priceForModel`'s own "prices an id it has not met at the dearest number in
 * every column" test above re-derives its expectation as `Math.max(...rows)`
 * off the LIVE table, so it would stay green even if `defaultPricingFor` lost
 * its floor entirely — a table whose dearest row happens to be its own
 * highest number can't tell "guarded by FLOOR" apart from "guarded by
 * nothing". `DEFAULT_PRICING` is computed once, at import time
 * (pricing.ts:91), off whatever `MODEL_PRICES` held then, so a test cannot
 * reach the real regression by mutating the live table after the fact
 * either — the module has already computed and closed over the number.
 * `defaultPricingFor` is exported for exactly this: it takes its own `rows`,
 * unconnected to the table this file happens to ship today, so the floor's
 * independence from the table is the thing under test rather than an
 * accident of today's numbers.
 */
describe("defaultPricingFor: the floor guards the fallback independently of the table", () => {
  it("holds at FLOOR when every row it is given sits under it", () => {
    // pricing.ts's own comment names this exact regression: retiring
    // gemini-3.5-flash (1.5/9.0, today's dearest row and equal to FLOOR)
    // would leave gemini-3-flash-preview's 0.5/3.0 as the new max — a
    // threefold cut a plain `Math.max(...rows)` would not catch.
    expect(defaultPricingFor([{ inUsdPerM: 0.5, outUsdPerM: 3.0 }])).toEqual(FLOOR)
    expect(defaultPricingFor([])).toEqual(FLOOR)
  })

  it("rises to a row that genuinely prices above FLOOR", () => {
    const dearer: ModelPricing = { inUsdPerM: FLOOR.inUsdPerM + 1, outUsdPerM: FLOOR.outUsdPerM + 1 }
    expect(defaultPricingFor([dearer])).toEqual(dearer)
  })

  it("never lowers FLOOR — the two columns are floored independently, not paired", () => {
    // A row dearer on one column and cheaper on the other must not drag the
    // cheaper column below its own floor by averaging or pairing the two.
    const mixed: ModelPricing = { inUsdPerM: FLOOR.inUsdPerM + 1, outUsdPerM: 0.01 }
    expect(defaultPricingFor([mixed])).toEqual({ inUsdPerM: mixed.inUsdPerM, outUsdPerM: FLOOR.outUsdPerM })
  })
})

/**
 * There is no adapter to test, because there is no longer a boundary to adapt
 * across: core's option shape and the table's return type are the same
 * `ModelPricing`. These assignments are the proof, and they are checked by
 * `tsc -p packages/providers/tsconfig.tests.json` rather than at runtime — if
 * the two spellings ever diverge again, `pnpm check` fails here.
 */
describe("one shape, one spelling", () => {
  it("hands the table's output straight to core's options", () => {
    const priced: ModelPricing = priceForModel(DEFAULT_MODEL)
    const forDiscover: DiscoverOptions["pricing"] = priced
    const forInvestigate: InvestigateOptions["pricing"] = priced
    expect(forDiscover).toBe(priced)
    expect(forInvestigate).toBe(priced)
  })
})

/**
 * The defect was duplication, not arithmetic — four copies of the same numbers,
 * two of which had drifted. Arithmetic tests would all have passed. So this
 * reads the repo instead and asserts there is one copy.
 *
 * `git ls-files` is the file list on purpose: it is exactly the set that ships,
 * so build output under `dist/`, other agents' worktrees under `.claude/`, and
 * `node_modules` are excluded by the same rules that keep them out of a commit.
 * `--others --exclude-standard` puts uncommitted new files in that set too — a
 * fifth copy of the table would be untracked on the branch that added it, which
 * is precisely when this test needs to see it.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
const HOME = "packages/providers/src/pricing.ts"
const SELF = "packages/providers/tests/pricing.test.ts"

/** Every tracked source file, any extension. The first draft globbed
 *  `*.ts,*.tsx,*.mjs`, so a copy in `.cjs`, `.js` or `.mts` was out of scope —
 *  and a price in prose is exactly what rotted in the original defect. `runs/`
 *  and `examples/` are excluded because both are generated artifacts full of
 *  recorded numbers that legitimately match. */
function gitFiles(): string[] {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => f !== SELF)
    .filter((f) => !f.startsWith("runs/") && !f.startsWith("examples/") && !f.startsWith("assets/"))
    .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md)$/.test(f))
    .sort()
}

/** A file listed by git can be gone by the time we read it. `--others` puts
 *  untracked files in the listing, and this repo's guards prove themselves by
 *  planting untracked files in the working tree and deleting them in an
 *  afterEach — so a scan running in a sibling worker sees the name and then the
 *  ENOENT.
 *
 *  This was written for tests/purity.test.ts, which planted
 *  `packages/core/src/__purity-probe.ts`. That one is gone: the probe moved to a
 *  temp dir, where git cannot see it. The helper stays anyway, because the
 *  trigger was never really that file — it is the pattern, and the pattern is
 *  still here. tests/collection.test.ts plants
 *  `__collection-probe-<pid>.test.tsx` at the repo root and under
 *  `packages/web/components/`; both are untracked, both are listed by the same
 *  `ls-files` call this makes, both match the extension filter above, and both
 *  are removed in an afterEach while this file may be mid-scan in another
 *  worker. Naming one cause and then deleting the guard when that cause is fixed
 *  is how the next race gets found in production instead of here.
 *
 *  It is also the right answer on the merits regardless of who is racing: a file
 *  that is not on disk cannot be a second copy of the price table. */
function readOrSkip(f: string): string {
  try {
    return readFileSync(join(repoRoot, f), "utf8")
  } catch {
    return ""
  }
}

function filesContaining(re: RegExp): string[] {
  return gitFiles().filter((f) => re.test(readOrSkip(f)))
}

/** Every price in the table, matched by VALUE rather than by spelling.
 *
 *  Three ways the first draft of this guard could be walked past, all of them
 *  found by attacking it rather than reading it:
 *    - it restated today's four literals, so a row repriced tomorrow arrived
 *      unguarded, and only two of the four rows were listed at all;
 *    - `/inUsdPerM:\s*1\.5\b/` misses `inUsdPerM: 1.50` — `\b` needs a boundary
 *      between `5` and `0` and finds none;
 *    - it required the key, so a bare `const IN = 1.5/1e6` was invisible. That
 *      is not hypothetical: it is exactly how the copy at the old
 *      scripts/discover.ts:50 was written.
 *  So: capture any number next to a per-million divisor or a pricing key, and
 *  compare it NUMERICALLY against the table. Spelling stops mattering. */
function copiesOfPrice(value: number): string[] {
  const asMoney = /(?:inUsdPerM|outUsdPerM)\s*:\s*([\d.]+)|([\d.]+)\s*\/\s*(?:1e6|1_000_000|1000000)/g
  return gitFiles().filter((f) => {
    const text = readOrSkip(f)
    for (const m of text.matchAll(asMoney)) {
      const n = Number(m[1] ?? m[2])
      if (Number.isFinite(n) && n === value) return true
    }
    return false
  })
}

describe("the table has no second copy", () => {
  it("writes every row's numbers in exactly one file, whatever the spelling", () => {
    for (const [id, row] of Object.entries(MODEL_PRICES)) {
      expect(copiesOfPrice(row.inUsdPerM), `${id} inUsdPerM`).toEqual([HOME])
      expect(copiesOfPrice(row.outUsdPerM), `${id} outUsdPerM`).toEqual([HOME])
    }
  })

  it("keeps a model id out of every pricing literal but the table's", () => {
    for (const id of Object.keys(MODEL_PRICES)) {
      expect(filesContaining(new RegExp(`"${id.replace("/", "\\/")}":\\s*\\{`))).toEqual([HOME])
    }
  })

  /** The retired spelling. Its absence is what makes the adapter unnecessary. */
  it("has retired inputPerMTok / outputPerMTok everywhere", () => {
    expect(filesContaining(/\b(inputPerMTok|outputPerMTok)\b/)).toEqual([])
  })
})
