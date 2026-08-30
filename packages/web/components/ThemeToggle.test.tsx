import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ThemeToggle } from "./ThemeToggle"

/**
 * ThemeToggle.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout, untracked by 481fa6d — section D scope
 * recovered from `git show 481fa6d^:docs/overnight-backlog.md`, the same
 * recovery prior SELF-<n> commits used). git log names SELF-184 as the last
 * used, so this is SELF-185.
 *
 * Confirmed zero coverage with `grep -rln "ThemeToggle" packages/web` before
 * this change: the only non-test hits were the import/render in HeaderNav.tsx
 * and doc-comment mentions in GraphCanvas.tsx, app/global-error.tsx,
 * app/layout.tsx and lib/theme.ts. StageTracker.test.tsx and theme.test.ts
 * each name "ThemeToggle" too, but only in prose (StageTracker.test.tsx:13
 * contrasts itself with it as a hooked component; theme.test.ts:10 is about
 * the no-FOUC script's twin rule) — neither imports or renders the component.
 *
 * The toggle click, the localStorage write and the mount-time useEffect (which
 * resolves `theme` from `null` to the DOM's stamped attribute) all need a live
 * DOM this repo has no jsdom/RTL harness for — same limitation TabBar.test.tsx
 * and StageTracker.test.tsx already documented for their own hook-driven parts.
 * What renderToStaticMarkup CAN pin is the one render that ships over the
 * wire and gets hydrated against: `theme` starts life as `null` (ThemeToggle.tsx:16),
 * and the component's own comment (lines 11-13) says this first render is
 * deliberately theme-agnostic so SSR markup and the hydrated DOM never disagree.
 * That resolves to a specific, checkable shape: `isDark` is `false` (only
 * `theme === "dark"` sets it, and `null !== "dark"`), so the label reads
 * "Toggle color theme" (the `theme === null` branch, ThemeToggle.tsx:75-77)
 * and the icon is MoonIcon, never SunIcon, regardless of what the reader's
 * actual stored preference is.
 */

function render(className?: string) {
  return renderToStaticMarkup(<ThemeToggle className={className} />)
}

describe("ThemeToggle: the pre-hydration render is theme-agnostic", () => {
  it("labels the button 'Toggle color theme' before the mount effect resolves a theme", () => {
    const html = render()
    expect(html).toContain('aria-label="Toggle color theme"')
    expect(html).toContain('title="Toggle color theme"')
  })

  it("puts the same label text in the sr-only span", () => {
    const html = render()
    expect(html).toContain(">Toggle color theme</span>")
  })

  it("renders MoonIcon, not SunIcon, since isDark is false until the effect runs", () => {
    const html = render()
    // MoonIcon's one path vs. SunIcon's <circle> + rays <path> — see ThemeToggle.tsx:103-138.
    expect(html).toContain('d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"')
    expect(html).not.toContain("<circle")
  })
})

describe("ThemeToggle: className is appended to the built-in classes, not replacing them", () => {
  it("keeps the built-in classes when none is passed", () => {
    const html = render()
    expect(html).toMatch(/class="inline-flex h-8 w-8[^"]*"/)
  })

  it("appends a passed className after the built-in ones", () => {
    const html = render("mt-4")
    expect(html).toMatch(/class="inline-flex h-8 w-8[^"]*mt-4"/)
  })
})
