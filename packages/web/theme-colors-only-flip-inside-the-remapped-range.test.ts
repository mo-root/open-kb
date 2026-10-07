import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * A themed color step outside `globals.css`'s own re-key range renders as a
 * fixed literal, not a token — SELF-682's own find.
 *
 * `globals.css`'s header makes a specific promise: "every ramp step is
 * re-keyed to a --c-* variable ... so a single data-theme swap inverts the
 * whole UI by MEANING, not by hue." That promise is literal, not a
 * description of most steps — the `@theme inline` block only remaps the
 * ranges it actually lists (slate 50-950 in full; sky 200-600; amber,
 * rose 200-500; emerald, violet 300-500/400). A class naming any OTHER step
 * of one of those five families (`border-sky-800`, `bg-rose-950`,
 * `border-amber-600`, …) compiles fine — Tailwind still has its own stock
 * value for every step — but that value is a hardcoded literal with no
 * `--c-*` behind it, so it never changes when `data-theme` does. Paired on
 * the same element with a sibling property that DOES use a remapped step
 * (the shape every real offender had: a themed border next to a themed
 * text or background one hue-family apart in step number), the two drift
 * out of sync the moment the page is in light mode, while looking identical
 * in dark mode where most development and review happens — exactly the kind
 * of gap a type-check and a headless test suite cannot see on their own,
 * which is why this file turns it into a plain text scan instead.
 *
 * `NoteView.tsx` already names this exact trap in its own `because` block's
 * comment ("border-amber-900/bg-amber-950 would sit outside that range and
 * render as a fixed dark literal instead of flipping with light mode") —
 * but as a warning against introducing a NEW instance, not a sweep for
 * existing ones. Grepping the five families' full numeric range across
 * every `.ts`/`.tsx` this app ships found four real, independent sites that
 * had already made the mistake the warning was written to prevent:
 * `ProductsTab.tsx`'s two product/integration cards (`border-sky-800/50
 * bg-sky-950/20`), `SearchesPanel.tsx`'s "only the empty" toggle
 * (`border-amber-600/60` beside a correctly-flipping `text-amber-400`),
 * `BuildWorkflow.tsx`'s Stop button hover (`hover:border-rose-600/60`
 * beside a correctly-flipping `hover:text-rose-400`), and
 * `app/runs/[id]/page.tsx`'s failed-run banner (`border-rose-900/50
 * bg-rose-950/20`, one line below a correctly-flipping `bg-rose-500/15`
 * status pill). All four fixed to the nearest in-range step, matching the
 * `border-{hue}-500/40 bg-{hue}-500/10` idiom `GraphCanvas.tsx`'s advisory
 * banner and `NoteView.tsx`'s own `because` box already use.
 *
 * This guard is the shape SELF-672/674's stale-cursor sweep and SELF-678/679's
 * pluralization sweep already are: a found CLASS of defect, turned into a
 * standing check so the next instance (a new card, a new hover state) fails
 * `pnpm test` instead of silently shipping a theme that only half-inverts.
 */

const GLOBALS_CSS = "packages/web/app/globals.css"
const THEMED_FAMILIES = ["slate", "sky", "amber", "emerald", "rose", "violet"] as const
const UTILITY_PREFIX =
  "(?:bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|divide|shadow|caret|accent|placeholder)"

/** The exact (family, step) pairs `globals.css`'s own `@theme inline` block
 *  re-keys to a `--c-*` variable that flips under `[data-theme="dark"]`.
 *  Parsed from the file itself, not hand-copied, so a future widened or
 *  narrowed remap range updates this test without anyone having to edit it. */
function remappedSteps(): Map<string, Set<string>> {
  const css = readFileSync(GLOBALS_CSS, "utf8")
  const map = new Map<string, Set<string>>()
  for (const m of css.matchAll(/--color-(slate|sky|amber|emerald|rose|violet)-(\d+):/g)) {
    // Both groups always match when `m` does — the pattern has no optional
    // capture — but `matchAll`'s type widens every group to `| undefined`.
    const family = m[1]!
    const step = m[2]!
    if (!map.has(family)) map.set(family, new Set())
    map.get(family)!.add(step)
  }
  return map
}

function usageRegex(): RegExp {
  return new RegExp(`\\b${UTILITY_PREFIX}-(${THEMED_FAMILIES.join("|")})-(\\d+)\\b`, "g")
}

/** `NoteView.tsx`'s own comment names a banned class (`border-amber-900`) by
 *  exact text to warn against it, and this file's own fix comments do the
 *  same for the four sites above — a scan that did not strip comments first
 *  would flag the very sentences written to prevent the bug. Block comments
 *  only: this codebase has no known offending mention inside a `//` line
 *  comment, and stripping those risks truncating a string that happens to
 *  contain `//` earlier on the same line. */
function withoutBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "")
}

/** First-party web source that ships to the browser. `--others
 *  --exclude-standard` includes uncommitted files, same reasoning as
 *  `tests/testing-doubles-stay-out-of-src.test.ts`: a guard that only read
 *  the index would go green on the very change that introduces the next
 *  violation. */
function shippedWebFiles(): string[] {
  const dirs = ["packages/web/app", "packages/web/components", "packages/web/lib"]
  const all = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...dirs], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
  return all.filter((p) => /\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p))
}

describe("a themed color step stays inside globals.css's own remap", () => {
  it("never names a sky/amber/emerald/rose/violet step outside the @theme inline range", () => {
    const remapped = remappedSteps()
    const files = shippedWebFiles()
    // A guard reading zero files reports clean, and that clean would mean
    // nothing — the same refusal `testing-doubles-stay-out-of-src.test.ts` makes.
    expect(files.length).toBeGreaterThan(50)

    const re = usageRegex()
    const offenders: string[] = []
    for (const file of files) {
      const text = withoutBlockComments(readFileSync(file, "utf8"))
      for (const m of text.matchAll(re)) {
        // Same non-optional-capture reasoning as `remappedSteps` above.
        const [whole, family, step] = [m[0], m[1]!, m[2]!]
        if (!remapped.get(family)?.has(step)) offenders.push(`${file}: ${whole}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("parsed a non-empty remap for every themed family, so the first test cannot pass vacuously", () => {
    const remapped = remappedSteps()
    for (const family of ["sky", "amber", "emerald", "rose", "violet"]) {
      expect(remapped.get(family)?.size ?? 0).toBeGreaterThan(0)
    }
  })

  it("the scan still catches the exact shape it was written to catch", () => {
    const re = usageRegex()
    const sample = withoutBlockComments(
      '<div className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-4">',
    )
    const hits = [...sample.matchAll(re)].map((m) => `${m[1]}-${m[2]}`)
    expect(hits).toEqual(["sky-800", "sky-950"])
  })
})
