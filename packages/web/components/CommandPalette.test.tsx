import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { CommandPaletteProvider, PaletteButton, score, usePalette } from "./CommandPalette"

/**
 * CommandPalette.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history).
 *
 * `score` is the one piece of the palette with rules in it — the same reason
 * lib/graph/search.ts's rankMatches was pulled out pure and tested on its
 * own (see that file's own comment) — but it was never exported, so nothing
 * in the repo has ever exercised its subsequence match, its gap penalty, or
 * its ranking order. The component's own header comment states the contract
 * this locks down: subsequence not substring ("brdt" finds "Bright Data"),
 * and "prefers a prefix hit, then an early hit, then a short title."
 *
 * The suites below are a second D-scope pass over the same file (git log names
 * SELF-193 as the last used, so this is SELF-194): everything BELOW `score` —
 * `usePalette`, `CommandPaletteProvider` and `PaletteButton` — still had zero
 * coverage of its own after that first pass. This repo has no jsdom/RTL
 * harness (vitest.config.ts sets no `test.environment`, confirmed by grepping
 * for one — ThemeToggle.test.tsx and TabBar.test.tsx document the same gap for
 * their own hook-driven parts), so a click, a keypress or an effect flushing
 * cannot be exercised here. What CAN be pinned with `renderToStaticMarkup` is
 * the one render that ships over the wire and is hydrated against — no effect
 * has run yet, so `open` is still `false`, `mac` is still its initial `true`,
 * and `useContext` (a render-time read, not an effect) already has its answer.
 */

/* CommandPaletteProvider calls `useRouter` unconditionally at the top of its
   body, and outside a mounted app router that throws — same mock, same reason,
   as app/page.test.tsx's own comment for BuildWorkflow. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
}))

describe("score: no-match and prefix short-circuits", () => {
  it("scores an empty needle 0 (matches everything, ranked first)", () => {
    expect(score("", "Bright Data")).toBe(0)
  })

  it("scores a case-insensitive prefix hit 0, the best possible score", () => {
    expect(score("bri", "Bright Data")).toBe(0)
  })

  it("returns -1 when the needle's letters do not all appear in order", () => {
    expect(score("xyz", "Bright Data")).toBe(-1)
    // "atbr" has the right letters but not in the haystack's order.
    expect(score("atbr", "Bright Data")).toBe(-1)
  })
})

describe("score: subsequence matching, not substring", () => {
  it("finds a subsequence that is never contiguous in the haystack", () => {
    // b-r(ight )d(ata t)... "brdt" is not a substring of "Bright Data".
    expect(score("brdt", "Bright Data")).toBeGreaterThan(0)
  })

  it("lowercases the haystack but assumes the needle already is (the caller's job — see the q.trim().toLowerCase() call site)", () => {
    expect(score("brdt", "BRIGHT DATA")).toBe(score("brdt", "Bright Data"))
    expect(score("BRDT", "Bright Data")).toBe(-1)
  })
})

describe("score: ranking order matches the component's stated preference", () => {
  it("prefers a prefix hit over a later subsequence hit", () => {
    const prefixHit = score("br", "Bright Data")
    const laterHit = score("br", "Umbra Data") // "b" then "r" appear, but not as a prefix
    expect(prefixHit).toBeLessThan(laterHit)
  })

  it("prefers an earlier subsequence hit over a later one, neither a prefix", () => {
    const early = score("ta", "Data Bright") // "t" at index 2, "a" at index 3 — no gap
    const late = score("ta", "Bright Data") // "t" at index 5, "a" at index 8 — one gap
    expect(early).toBeLessThan(late)
  })

  it("prefers a shorter haystack when the match starts at the same index", () => {
    const short = score("at", "Data") // "a" at index 1, "t" at index 2
    const long = score("at", "Data Data") // same positions, longer string
    expect(short).toBeLessThan(long)
  })

  it("penalizes a gappy match more than a contiguous one starting at the same index", () => {
    const contiguous = score("da", "xdax") // "d" at index 1, "a" at index 2 — no gap
    const gapped = score("da", "xdyax") // "d" at index 1, "a" at index 3 — one gap
    expect(contiguous).toBeLessThan(gapped)
  })
})

/** Reads what `usePalette()` sees at render time. A render-time read is the
 *  right probe for a `useContext` call: unlike `usePaletteCommands`'
 *  registration (which only happens inside a `useEffect` that never runs
 *  here), `usePalette` does its whole job — `return useContext(Ctx)` — during
 *  render, so a static render already has its answer. */
function Probe() {
  const ctx = usePalette()
  return <div data-probe={ctx ? typeof ctx.open : "null"} />
}

describe("usePalette: the registry a caller reads, present only inside the provider", () => {
  it("is null outside CommandPaletteProvider — Ctx's own default", () => {
    const html = renderToStaticMarkup(<Probe />)
    expect(html).toContain('data-probe="null"')
  })

  it("is the provider's own registry inside it, with a callable open()", () => {
    const html = renderToStaticMarkup(
      <CommandPaletteProvider>
        <Probe />
      </CommandPaletteProvider>,
    )
    expect(html).toContain('data-probe="function"')
  })
})

describe("CommandPaletteProvider: the pre-hydration render is closed, not empty", () => {
  it("renders only its children — `open` starts false and no effect has run to flip it", () => {
    const html = renderToStaticMarkup(
      <CommandPaletteProvider>
        <div data-marker="child" />
      </CommandPaletteProvider>,
    )
    expect(html).toContain('data-marker="child"')
    // The dialog is `{open && (...)}`; asserting its absence, not merely the
    // child's presence, is what rules out a server/client markup mismatch on
    // first paint — the failure this file's other tests can't see with the
    // dialog rendered instead.
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain("Jump to a map")
  })
})

describe("PaletteButton: the pre-hydration render always claims a Mac shortcut", () => {
  it("shows ⌘K on first render regardless of the actual platform — `mac` starts `true` and only the mount effect (never run in a static render) can correct it to ^K", () => {
    const html = renderToStaticMarkup(<PaletteButton />)
    expect(html).toContain("⌘K")
    expect(html).not.toContain("^K")
  })

  it("renders without a CommandPaletteProvider — ctx is null and the click handler only ever calls it through `?.`", () => {
    expect(() => renderToStaticMarkup(<PaletteButton />)).not.toThrow()
  })

  it("appends a passed className after the built-in ones, same convention as ThemeToggle", () => {
    const bare = renderToStaticMarkup(<PaletteButton />)
    const withClass = renderToStaticMarkup(<PaletteButton className="mt-4" />)
    expect(withClass).not.toBe(bare)
    expect(withClass).toContain("mt-4")
  })
})
