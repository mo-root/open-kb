/**
 * The theme rule, once, for every consumer that is allowed to import it.
 *
 * There are three documents in this app that have to answer "is this reader
 * dark or light?" and they do not all have the same tools:
 *
 *   1. A HEALTHY page. `app/layout.tsx` carries an inline, parser-inserted
 *      `<script>` in its `<head>` that stamps `data-theme` before first paint.
 *      It has to be a literal string in the markup — an import would be a
 *      network round trip, and the whole point is that it runs before one.
 *      That copy of the rule cannot come from here, and `theme.test.ts`
 *      evaluates the real script text out of `layout.tsx` against
 *      `themeFromStored` so the two cannot drift apart in silence.
 *   2. `components/ThemeToggle.tsx`, which reads the stamped attribute, writes
 *      it when an errored document arrives without one (see the comment there),
 *      and persists the reader's choice.
 *   3. `app/global-error.tsx`, which runs on a document where NOTHING else of
 *      this app exists — no header, no stylesheet, no `data-theme`.
 *
 * 2 and 3 are ordinary modules and can share, so they do. Before this file they
 * would have been two hand-copied `raw === "light" ? … : …` expressions plus
 * the script, and ThemeToggle's own comment already carried the warning about
 * the two copies having to move together. Three would have been worse.
 *
 * Nothing here imports anything, and nothing here runs at module scope. That is
 * a requirement rather than a style: `global-error.tsx` is the last page in the
 * app, so a module it pulls in must not be able to fail on the way in.
 */

/** The localStorage key. One spelling, referenced rather than retyped. */
export const THEME_KEY = "kb-theme"

export type Theme = "light" | "dark"

/**
 * LIGHT is the default, and every non-`"dark"` value resolves to it: unset,
 * stale, mixed case, or whatever a future writer puts there. Dark is the opt-in.
 *
 * This used to read the other way, on the argument that a live console gets
 * watched while a run is going. The map outlived that argument. Most of what
 * anyone does here is read a finished map, share a link to one, or screenshot a
 * graph, and all three want paper. A reader who wants dark says so once and the
 * choice sticks.
 *
 * One rule, three readers, and they must agree: this function, the inline
 * pre-paint script in `app/layout.tsx`, and the `colorScheme` the metadata
 * channel carries onto a document with no stylesheet. `theme.test.ts` evaluates
 * the real script text against this function so the first two cannot drift.
 */
export function themeFromStored(raw: string | null | undefined): Theme {
  return raw === "dark" ? "dark" : "light"
}

/**
 * The same rule against real storage. `localStorage` throws outright in some
 * privacy modes — and is simply absent under Node, which is how the tests reach
 * this branch — so the read is wrapped and a failure resolves the same way an
 * unset value does.
 */
export function readStoredTheme(): Theme {
  try {
    return themeFromStored(localStorage.getItem(THEME_KEY))
  } catch {
    return "light"
  }
}
