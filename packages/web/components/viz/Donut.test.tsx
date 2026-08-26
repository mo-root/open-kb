import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Donut } from "./Donut"

/**
 * ZERO TEST COVERAGE ANYWHERE, like the other three files in this directory.
 * `Donut` is the one of the four with real geometry in it — `arc`/`polar`
 * convert a share into an SVG path, and the ring walk (`cursor`, `gapDeg`)
 * decides which slices are wide enough to draw at all — so this file pins
 * that logic rather than just the render shape ProductsTab/KbCard.test.tsx
 * already established the pattern for.
 */

describe("Donut renders a full circle instead of a one-point arc for a single share", () => {
  it("draws a <circle>, not a <path>, when only one segment has weight", () => {
    // KbOverview's CompositionPanel shape: every NodeType present, only one
    // populated — the map has core, product and player but never any
    // community yet, which is the common case for a freshly built map.
    const html = renderToStaticMarkup(
      <Donut
        segments={[
          { key: "core", label: "core", value: 1, color: "#fff" },
          { key: "product", label: "product", value: 0, color: "#000" },
          { key: "player", label: "player", value: 0, color: "#000" },
        ]}
      />,
    )
    expect(html).toContain("<circle")
    expect(html).not.toContain("<path")
  })
})

describe("Donut excludes zero-value segments from the ring but keeps them in the legend", () => {
  it("draws one path per non-zero segment and lists every segment", () => {
    const html = renderToStaticMarkup(
      <Donut
        segments={[
          { key: "core", label: "core", value: 3, color: "#111" },
          { key: "product", label: "product", value: 5, color: "#222" },
          { key: "player", label: "player", value: 0, color: "#333" },
        ]}
      />,
    )
    // Two non-zero segments, two arcs.
    expect(html.split("<path").length - 1).toBe(2)
    // The zero segment still gets a legend row, reading 0%.
    expect(html).toContain("player")
    expect(html).toContain("0%</span>")
  })
})

describe("Donut's aria summary reports the share of the whole, not the share of the ring", () => {
  it("computes each percentage against the total across all segments", () => {
    // 3 of 3+5+2=10 is 30%, matching `pct`'s own `Math.round((v/total)*100)`.
    const html = renderToStaticMarkup(
      <Donut
        segments={[
          { label: "core", value: 3, color: "#111" },
          { label: "product", value: 5, color: "#222" },
          { label: "player", value: 2, color: "#333" },
        ]}
      />,
    )
    expect(html).toContain('aria-label="composition: core 3 (30%), product 5 (50%), player 2 (20%)"')
  })

  it("reads every share as 0% rather than dividing by zero when the total is zero", () => {
    const html = renderToStaticMarkup(
      <Donut segments={[{ label: "core", value: 0, color: "#111" }]} />,
    )
    expect(html).toContain('aria-label="composition: core 0 (0%)"')
    // No ring at all — not a circle (that's the single-segment case above,
    // which requires a positive value) and not a path.
    expect(html).not.toContain("<circle")
    expect(html).not.toContain("<path")
  })
})

describe("Donut skips a slice too thin for its own gap rather than drawing a backwards arc", () => {
  it("omits the path for a segment whose sweep is smaller than gapDeg", () => {
    // 200 equal segments split 360° into 1.8° each, under the default 3°
    // gap — `a1 = cursor + sweep - gapDeg/2` lands behind `a0`, and
    // `draw: a1 > a0` is what keeps that from reaching `arc()` as a
    // start-past-end path. Every slice hits this, so zero paths draw.
    const segments = Array.from({ length: 200 }, (_, i) => ({
      key: `s${i}`,
      label: `s${i}`,
      value: 1,
      color: "#123456",
    }))
    const html = renderToStaticMarkup(<Donut segments={segments} />)
    expect(html.split("<path").length - 1).toBe(0)
    // Still a real ring by value (not the single-segment circle case).
    expect(html).not.toContain("<circle")
    // The legend still lists all 200, each its true 0.5% share (rounds to 1%
    // — `Math.round((1/200)*100)` is 0.5, which rounds up per `Math.round`).
    expect(html).toContain("1%</span>")
  })
})
