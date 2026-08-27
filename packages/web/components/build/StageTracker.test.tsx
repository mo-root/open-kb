import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { StageTracker } from "./StageTracker"
import { STAGES, type Stage, type StageState } from "./types"

/**
 * StageTracker.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering section
 * D's scope from git history).
 *
 * StageTracker is pure props-in-markup-out (no hooks, unlike TabBar or
 * ThemeToggle), so renderToStaticMarkup pins its full branching logic, not
 * just a first-render snapshot: which of three visual states each marker
 * gets, the blurb/message gates that are keyed on "active" specifically (not
 * "done" or "pending"), the chips gate that is spelled `!== "pending"` rather
 * than `=== "active" || "done"`, and the connecting-rule that must stop
 * before the last item. That last one already broke once — the comment at
 * StageTracker.tsx:59-68 documents a `calc(100%-8px)` that painted a hairline
 * through the numeral badges before it was measured and corrected to
 * `calc(100%-20px)` — so pinning "the rule renders, and stops at the last
 * stage" guards a bug this file has already had.
 */

function states(overrides: Partial<Record<Stage, StageState>>): Record<Stage, StageState> {
  const base = {} as Record<Stage, StageState>
  for (const s of STAGES) base[s] = overrides[s] ?? "pending"
  return base
}

describe("StageTracker: marker numbering and per-state styling", () => {
  it("numbers markers 01-06, zero-padded, in STAGES order", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({})} />)
    expect(html).toContain(">01<")
    expect(html).toContain(">06<")
    expect(html.indexOf(">01<")).toBeLessThan(html.indexOf(">06<"))
  })

  it("gives a done marker emerald styling and a done label the plain text color", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({ understand: "done" })} />)
    expect(html).toContain("border-emerald-500/40")
    expect(html).toContain("text-slate-200")
  })

  it("gives an active marker the pulse ring and the label the sky color", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({ plan: "active" })} />)
    expect(html).toContain("animate-pulse")
    expect(html).toContain("border-sky-400/70")
    expect(html).toContain("text-sky-300")
  })

  it("gives a pending marker slate styling and the label the dimmed color", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({})} />)
    expect(html).toContain("border-slate-800")
    expect(html).toContain("text-slate-600")
  })
})

describe("StageTracker: the blurb and progress message are gated on 'active', not 'done'", () => {
  it("shows the stage blurb only for the active stage", () => {
    const html = renderToStaticMarkup(
      <StageTracker states={states({ understand: "done", plan: "active" })} />,
    )
    expect(html).not.toContain("read the company's own pages")
    expect(html).toContain("write the query catalog knowing no company names")
  })

  it("shows a progress message only while its stage is active", () => {
    const html = renderToStaticMarkup(
      <StageTracker
        states={states({ plan: "active" })}
        messages={{ plan: "querying host 12/40" }}
      />,
    )
    expect(html).toContain("querying host 12/40")
  })

  it("omits the message row entirely when the active stage has no message", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({ plan: "active" })} />)
    expect(html).not.toContain("querying host 12/40")
  })

  it("does not leak a message onto a done stage, even if one is passed for it", () => {
    const html = renderToStaticMarkup(
      <StageTracker
        states={states({ understand: "done", plan: "active" })}
        messages={{ understand: "should never render" }}
      />,
    )
    expect(html).not.toContain("should never render")
  })
})

describe("StageTracker: chips are gated on state !== 'pending', not on state === 'done'", () => {
  it("shows chips for a done stage", () => {
    const html = renderToStaticMarkup(
      <StageTracker states={states({ understand: "done" })} chips={{ understand: ["24 pages"] }} />,
    )
    expect(html).toContain("24 pages")
  })

  it("shows chips for an active stage too", () => {
    const html = renderToStaticMarkup(
      <StageTracker states={states({ plan: "active" })} chips={{ plan: ["18 queries"] }} />,
    )
    expect(html).toContain("18 queries")
  })

  it("hides chips for a pending stage even when some are passed", () => {
    const html = renderToStaticMarkup(
      <StageTracker states={states({})} chips={{ sweep: ["should not render"] }} />,
    )
    expect(html).not.toContain("should not render")
  })

  it("renders nothing for an empty chip list", () => {
    const html = renderToStaticMarkup(
      <StageTracker states={states({ understand: "done" })} chips={{ understand: [] }} />,
    )
    const item = html.slice(html.indexOf("<li"), html.indexOf("</li>"))
    expect(item).not.toContain("flex-wrap")
  })
})

describe("StageTracker: the connecting rule stops before the last stage", () => {
  it("draws a connecting line after every stage except the last", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({})} />)
    const items = html.split("<li").slice(1)
    expect(items).toHaveLength(STAGES.length)
    items.slice(0, -1).forEach((item) => {
      expect(item).toContain("calc(100%-20px)")
    })
    expect(items[items.length - 1]).not.toContain("calc(100%-20px)")
  })

  it("colors the connecting line emerald after a done stage and slate otherwise", () => {
    const html = renderToStaticMarkup(<StageTracker states={states({ understand: "done" })} />)
    const items = html.split("<li").slice(1)
    expect(items[0]).toContain("bg-emerald-500/30")
    expect(items[1]).toContain("bg-slate-800")
  })
})
