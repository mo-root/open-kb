import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * `bake-layouts.ts` had zero test coverage anywhere, AND was unreachable by
 * the suite even if a test existed: `vitest.config.ts`'s `include` lists
 * `packages/web/{app,lib,components}/**` plus a non-recursive
 * `packages/web/*.test.{ts,tsx}` for direct children (added for
 * `middleware.test.ts`), but this file sits one level deeper, under
 * `packages/web/scripts/`, which none of those globs reach. A test placed
 * here would have joined the exact class `scripts/check-test-collection.mjs`
 * exists to catch — collected by nothing, run by nothing, green by omission.
 * Confirmed by running it before adding the include line below: it named
 * this exact gap. Fixed the same way `middleware.test.ts`'s own gap was: one
 * new line in `vitest.config.ts`'s allowlist, non-recursive so it cannot
 * widen into a directory with no tests in it.
 *
 * The file's own doc comment (lines 12-20) says its lobe force is "mirrored
 * from GraphCanvas's `makeClusterForce`" — a duplicated recipe, not an
 * import of one, because `bake-layouts.ts` runs `readdirSync`/`mkdirSync`
 * against `demo/maps` at module scope, so importing it in a test would run
 * the whole bake. Five numbers are hand-copied this way: the two named lobe
 * constants (`CLUSTER_PAD_SEATS`, `CLUSTER_SHOVE`), the unnamed `0.06`
 * cohesion coefficient in both files' cluster-force closures, the hub-score
 * formula deciding which node anchors the layout, the node-radius formula,
 * and the collide force's `.strength(0.9).iterations(3)` pair — the same
 * `forceCollide()` recipe, present exactly once per file (confirmed with
 * `grep -n "iterations("` on both before writing the regex below). All five
 * currently agree, but nothing fails if one drifts: if GraphCanvas's copy is
 * retuned later (its own comments show this has already happened once, with
 * measured before/after ratios — including a note that raising collide
 * strength above ~1 visibly jitters, which is exactly the kind of retune
 * that would silently orphan the bake's copy), the baked
 * `public/layouts/*.json` seeds would silently start from the wrong lobe
 * recipe with no test to catch it. Same shape as `nodeTypes.test.ts`'s
 * TYPE_COLOR-vs-globals.css pin: read both real source files as text rather
 * than restating the numbers, so a future edit to either side fails here
 * instead of drifting silently.
 */
const BAKE = readFileSync(fileURLToPath(new URL("./bake-layouts.ts", import.meta.url)), "utf8")
const CANVAS = readFileSync(
  fileURLToPath(new URL("../components/kb/GraphCanvas.tsx", import.meta.url)),
  "utf8",
)

/** First `<name> = <number>` assignment's numeric literal, as a string. */
function constant(src: string, name: string): string {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*([\\d.]+)`))
  if (!m) throw new Error(`no ${name} assignment found`)
  return m[1]
}

describe("bake-layouts.ts's lobe force: pinned to GraphCanvas's makeClusterForce", () => {
  it("CLUSTER_PAD_SEATS matches", () => {
    expect(constant(BAKE, "CLUSTER_PAD_SEATS")).toBe(constant(CANVAS, "CLUSTER_PAD_SEATS"))
  })

  it("CLUSTER_SHOVE matches", () => {
    expect(constant(BAKE, "CLUSTER_SHOVE")).toBe(constant(CANVAS, "CLUSTER_SHOVE"))
  })

  it("the unnamed cohesion coefficient in `(d.x - nd.x) * <coeff> * alpha` matches", () => {
    const re = /\(d\.x - nd\.x\) \* ([\d.]+) \*/
    const bake = BAKE.match(re)
    const canvas = CANVAS.match(re)
    expect(bake).not.toBeNull()
    expect(canvas).not.toBeNull()
    expect(bake![1]).toBe(canvas![1])
  })

  it("the hub-score formula (core-type tiebreak) matches verbatim", () => {
    const needle = 'deg + (nodeTypeOf(n.group) === "core" ? 0.5 : 0)'
    expect(BAKE).toContain(needle)
    expect(CANVAS).toContain(needle)
  })

  it("the node-radius formula matches", () => {
    // Same `4 + Math.sqrt(rel / <maxRel>) * 12` shape in both files; only the
    // max-relevance operand's spelling differs (`maxRel` locally in
    // bake-layouts.ts vs the memoized `meta.maxRel` in GraphCanvas), so the
    // operand is captured and dropped rather than compared.
    const re = /4 \+ Math\.sqrt\(rel \/ [\w.]+\) \* 12/
    const bake = BAKE.match(re)?.[0].replace(/rel \/ [\w.]+\)/, "rel / X)")
    const canvas = CANVAS.match(re)?.[0].replace(/rel \/ [\w.]+\)/, "rel / X)")
    expect(bake).toBeDefined()
    expect(bake).toBe(canvas)
  })

  it("the collide force's strength and iterations match", () => {
    // `forceCollide()...strength(0.9).iterations(3)` — GraphCanvas's own
    // comment there says raising strength toward 1 "visibly jitters" and
    // that iterations was raised from a lower value to clear overlaps a
    // single pass left; the bake copy has neither comment, so a future
    // retune of either number in GraphCanvas is the exact silent-drift risk
    // this test exists to catch, same as the other four pins above.
    const re = /\.strength\(([\d.]+)\)\s*\.iterations\((\d+)\)/
    const bake = BAKE.match(re)
    const canvas = CANVAS.match(re)
    expect(bake).not.toBeNull()
    expect(canvas).not.toBeNull()
    expect(bake![1]).toBe(canvas![1])
    expect(bake![2]).toBe(canvas![2])
  })
})
