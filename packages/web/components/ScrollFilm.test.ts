import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * ScrollFilm.tsx had zero test coverage anywhere. D-scope, self-discovered (A,
 * B and C are all done or BLOCKED; docs/overnight-backlog.md is gone from
 * this checkout — untracked by 481fa6d; section D scope recovered via
 * `git show 481fa6d^:docs/overnight-backlog.md`, the same recovery prior
 * SELF-<n> commits used). Continuing the existing numbering: git log
 * a7bbc57..HEAD names SELF-175 as the last used, so this is SELF-176.
 *
 * The component itself can't gain much from a render test: it has no props
 * and its whole runtime behaviour lives inside a scroll/resize effect and
 * imperative ref writes, so `renderToStaticMarkup` (this repo's only harness
 * — no jsdom/RTL, per FindingsPanel.test.tsx's and StageTracker.test.tsx's
 * own notes) would only ever exercise the first, effect-free paint.
 *
 * But its own doc comment states a hand-copied fact: `TOTAL = 32.5`, "the
 * film's total runtime, from the rig itself (launch-rig.html: TOTAL)". That
 * rig is `public/launch-rig.html`, a standalone HTML file the component
 * embeds via same-origin `<iframe>` and drives through `window.SEEK(t)` — not
 * an import, so nothing short of a test can catch the two copies drifting.
 * Confirmed both currently read the same value with `grep -n "TOTAL" public/
 * launch-rig.html` before writing this: line 113 is `const TOTAL = 32.50;`.
 * Same shape as `bake-layouts.test.ts`'s pin of `CLUSTER_PAD_SEATS` and
 * friends against `GraphCanvas.tsx`: read both real source files as text and
 * compare the literal, so a future retune of either side's film length fails
 * here instead of leaving the scrub bar silently out of sync with the film.
 *
 * `TRACK_VH` (how much scroll buys the whole film) isn't pinned the same way:
 * it's not copied from the rig, just chosen against it (the file's own
 * comment does the arithmetic, "~58 viewports ≈ 0.56s of film per screen"),
 * so there is no second copy for it to drift from.
 */
const SCROLL_FILM = readFileSync(
  fileURLToPath(new URL("./ScrollFilm.tsx", import.meta.url)),
  "utf8",
)
const RIG = readFileSync(
  fileURLToPath(new URL("../public/launch-rig.html", import.meta.url)),
  "utf8",
)

/** First `<name> = <number>` assignment's numeric literal, as a string. */
function constant(src: string, name: string): string {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*([\\d.]+)`))
  if (!m) throw new Error(`no ${name} assignment found`)
  return m[1]
}

describe("ScrollFilm's TOTAL: pinned to launch-rig.html's own TOTAL", () => {
  it("matches, as a number", () => {
    expect(Number(constant(SCROLL_FILM, "TOTAL"))).toBe(Number(constant(RIG, "TOTAL")))
  })
})
