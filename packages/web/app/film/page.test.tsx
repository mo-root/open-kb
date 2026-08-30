import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import FilmPage from "./page"

/**
 * FilmPage had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md is gone from
 * this checkout — untracked by 481fa6d; section D scope recovered via
 * `git show 481fa6d^:docs/overnight-backlog.md`, the same recovery prior
 * SELF-<n> commits used).
 *
 * A pure server component (no hooks, no client boundary, no next/font — that
 * last one matters: app/layout.tsx is the one other untested file under
 * app/, and it pulls in next/font/google at module scope, which is why it is
 * not this fire's pick), so renderToStaticMarkup exercises the whole thing in
 * one render.
 *
 * The one real invariant here: this file's own doc comment says the landing
 * page "autoplays it muted" and /film is "a deliberate destination" where
 * "the score plays" — i.e. NOT muted, controls on. `/launch.mp4` is embedded
 * twice in this app: here, and in DemoHome.tsx's landing hero. Read both with
 * `grep -n "launch.mp4" -A8 packages/web/components/DemoHome.tsx
 * packages/web/app/film/page.tsx`: DemoHome's copy has `autoPlay muted loop`,
 * this one has `controls autoPlay` and neither `muted` nor `loop`. DemoHome's
 * own test (DemoHome.test.tsx) only asserts the string "launch.mp4" is
 * present, not which attributes ride with it — so nothing anywhere pins the
 * one difference that makes /film the page with sound. A copy-paste of
 * DemoHome's video block over this one (or the reverse) would land silently.
 */
describe("FilmPage", () => {
  it("renders the film unmuted, with controls, and not looping", () => {
    const html = renderToStaticMarkup(<FilmPage />)
    expect(html).toContain('src="/launch.mp4"')
    expect(html).toContain("controls=\"\"")
    expect(html).toContain("autoPlay=\"\"")
    expect(html).not.toContain("muted")
    expect(html).not.toContain("loop")
  })

  it("links onward to the scroll-controlled version at /story", () => {
    const html = renderToStaticMarkup(<FilmPage />)
    expect(html).toContain('href="/story"')
  })

  it("labels the video for assistive tech the same way DemoHome's does", () => {
    const html = renderToStaticMarkup(<FilmPage />)
    expect(html).toContain(
      'aria-label="The launch film: one domain in, knowledge base out"',
    )
  })
})
