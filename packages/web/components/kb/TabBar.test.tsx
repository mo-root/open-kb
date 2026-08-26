import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TabBar, type TabDef } from "./TabBar"

/**
 * TabBar.tsx had zero test coverage anywhere. D-scope sweep, self-discovered
 * (A, B and C are all done or BLOCKED; docs/overnight-backlog.md itself is
 * gone from this checkout — see 48c1eaa's note on recovering section D's
 * scope from git history).
 *
 * The underbar's measured position and the arrow/Home/End keyboard nav both
 * live inside useLayoutEffect/useRef/onKeyDown closures that need a live DOM
 * to exercise — this repo has no jsdom/RTL harness (same limitation noted on
 * useUrlView and GraphCanvas's zero-entity guard). renderToStaticMarkup still
 * pins everything render-time: which tab is `aria-selected` and in the tab
 * order, the count badge's `!== undefined` guard (so a literal 0 still
 * renders), the idPrefix-derived id/aria-controls pair every panel has to
 * match, and the underbar's own pre-measurement state (width 0, opacity 0,
 * so it cannot flash at x=0 before the first layout effect runs).
 */

type Id = "a" | "b" | "c"

const tabs: TabDef<Id>[] = [
  { id: "a", label: "Alpha", glyph: "docs" },
  { id: "b", label: "Beta", glyph: "docs", count: 3 },
  { id: "c", label: "Gamma", glyph: "docs", count: 0 },
]

function render(active: Id, idPrefix?: string) {
  return renderToStaticMarkup(
    <TabBar tabs={tabs} active={active} onChange={() => {}} idPrefix={idPrefix} />,
  )
}

describe("TabBar: only the active tab is selected and in the tab order", () => {
  it("gives the active tab aria-selected=true and tabIndex 0", () => {
    const html = render("a")
    expect(html).toContain('id="kb-tab-a" aria-selected="true"');
    expect(html).toMatch(/id="kb-tab-a"[^>]*tabindex="0"/)
  })

  it("gives every inactive tab aria-selected=false and tabIndex -1", () => {
    const html = render("a")
    expect(html).toMatch(/id="kb-tab-b"[^>]*aria-selected="false"/)
    expect(html).toMatch(/id="kb-tab-b"[^>]*tabindex="-1"/)
    expect(html).toMatch(/id="kb-tab-c"[^>]*aria-selected="false"/)
  })

  it("switching which id is active moves which tab carries the selected styling", () => {
    const html = render("b")
    expect(html).toMatch(/id="kb-tab-b"[^>]*aria-selected="true"/)
    expect(html).toMatch(/id="kb-tab-a"[^>]*aria-selected="false"/)
  })
})

describe("TabBar: the count badge is gated on '!== undefined', not truthiness", () => {
  it("renders no badge when count is omitted", () => {
    const html = render("a")
    const aTab = html.slice(html.indexOf('id="kb-tab-a"'), html.indexOf('id="kb-tab-b"'))
    expect(aTab).not.toContain("tnum")
  })

  it("renders a literal 0 badge rather than hiding it", () => {
    const html = render("a")
    const cTab = html.slice(html.indexOf('id="kb-tab-c"'))
    expect(cTab).toContain('class="tnum')
    expect(cTab).toContain(">0<")
  })

  it("renders a nonzero count", () => {
    const html = render("a")
    const bTab = html.slice(html.indexOf('id="kb-tab-b"'), html.indexOf('id="kb-tab-c"'))
    expect(bTab).toContain(">3<")
  })
})

describe("TabBar: idPrefix namespaces both halves of the aria-controls pair", () => {
  it("defaults to 'kb'", () => {
    const html = render("a")
    expect(html).toContain('id="kb-tab-a"')
    expect(html).toContain('aria-controls="kb-panel-a"')
  })

  it("an explicit idPrefix replaces it on every tab", () => {
    const html = render("a", "notes")
    expect(html).toContain('id="notes-tab-a"')
    expect(html).toContain('aria-controls="notes-panel-a"')
    expect(html).not.toContain("kb-tab-")
  })
})

describe("TabBar: the underbar starts unmeasured", () => {
  it("renders at width 0 and opacity 0 before any layout effect can measure a tab", () => {
    const html = render("a")
    const underbar = html.slice(html.lastIndexOf("<span"))
    expect(underbar).toContain("width:0")
    expect(underbar).toContain("opacity:0")
    expect(underbar).toContain("translateX(0px)")
  })
})
