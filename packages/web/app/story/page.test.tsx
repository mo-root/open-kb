import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import StoryPage from "./page"

/**
 * app/story/page.tsx had zero test coverage anywhere. D-scope, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md is gone from
 * this checkout — untracked by 481fa6d; section D scope recovered via
 * `git show 481fa6d^:docs/overnight-backlog.md`, the same recovery prior
 * SELF-<n> commits used). Continuing the existing numbering: git log
 * a7bbc57..HEAD names SELF-188 as the last used, so this is SELF-189.
 *
 * app/film/page.test.tsx's own doc comment names this file's sibling gap
 * directly: "app/layout.tsx is the one other untested file under app/" — that
 * comment is itself incomplete, since this file was untested too at the time
 * it was written (confirmed with `git log --oneline --all -- app/story/
 * page.test.tsx`, empty). Unlike layout.tsx, this one has no next/font import
 * and no client boundary of its own — it's a pure server component like
 * FilmPage, so the same renderToStaticMarkup harness covers it in one render.
 *
 * The component itself just wraps <ScrollFilm/> (already covered by its own
 * TOTAL-pin test) with no props, so there's nothing behavioural of this
 * file's own to assert beyond "it renders ScrollFilm's actual markup and
 * nothing else swapped in by mistake" — the same class of regression B-scope
 * found in FilmPage's video attributes. ScrollFilm's effects don't run under
 * static rendering, but its first-paint DOM (the rig iframe, the scroll hint,
 * the hairline bar) is plain JSX and renders the same as any other paint.
 */
describe("StoryPage", () => {
  it("renders the scroll-driven film rig, not the plain <video> film page", () => {
    const html = renderToStaticMarkup(<StoryPage />)
    expect(html).toContain('src="/launch-rig.html?t=0"')
    expect(html).not.toContain("/launch.mp4")
  })

  it("labels the rig for assistive tech as the scroll-advanced film", () => {
    const html = renderToStaticMarkup(<StoryPage />)
    expect(html).toContain(
      'title="The launch film: one domain in, knowledge base out — advanced by scrolling"',
    )
  })

  it("shows the scroll-to-play hint on first paint", () => {
    const html = renderToStaticMarkup(<StoryPage />)
    expect(html).toContain("scroll to play")
  })
})
