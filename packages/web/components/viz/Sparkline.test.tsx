import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sparkline } from "./Sparkline";

/**
 * ZERO TEST COVERAGE ANYWHERE, same gap this directory's Donut/Gauge/BarMeter
 * test files closed for their own components. Sparkline has its own untested
 * logic: non-finite values are filtered out before any geometry runs, a
 * single surviving point has no span to divide by (`n === 1` short-circuits
 * `x` to the midpoint), a flat series (`min === max`) falls back to a `span`
 * of 1 rather than dividing by zero, and the empty-after-filtering case
 * renders a bare `<svg>` with no path at all rather than NaN geometry.
 */

describe("Sparkline drops non-finite values before computing geometry", () => {
  it("renders no path and no line when every value is non-finite", () => {
    const html = renderToStaticMarkup(<Sparkline values={[NaN, Infinity, -Infinity]} />);
    expect(html).not.toContain("<path");
    expect(html).not.toContain("<circle");
  });

  it("renders geometry from the finite values once NaN/Infinity are filtered out", () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, NaN, 3, Infinity]} />);
    expect(html).toContain("<path");
    expect(html).not.toContain("NaN");
  });
});

describe("Sparkline handles the degenerate one-point and flat-series cases without dividing by zero", () => {
  it("places a single surviving point at the horizontal midpoint", () => {
    const html = renderToStaticMarkup(<Sparkline values={[5]} width={100} />);
    const [d] = [...html.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1]);
    expect(d.startsWith("M50.00,")).toBe(true);
  });

  it("falls back to a span of 1 rather than NaN when every value is equal", () => {
    const html = renderToStaticMarkup(<Sparkline values={[7, 7, 7]} />);
    expect(html).not.toContain("NaN");
    expect(html).toContain("<path");
  });
});

describe("Sparkline's fill and end-dot are each independently switchable", () => {
  it("omits the area path when fill is false", () => {
    const withFill = renderToStaticMarkup(<Sparkline values={[1, 2, 3]} />);
    const withoutFill = renderToStaticMarkup(<Sparkline values={[1, 2, 3]} fill={false} />);
    expect(pathCount(withFill)).toBe(2); // area wash + line
    expect(pathCount(withoutFill)).toBe(1); // line only
  });

  it("omits the end-dot circle when showEnd is false", () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 2, 3]} showEnd={false} />);
    expect(html).not.toContain("<circle");
  });
});

describe("Sparkline's aria-label defaults to a point/min/max/last summary", () => {
  it("builds the default summary from the filtered series", () => {
    const html = renderToStaticMarkup(<Sparkline values={[2, 5, 3]} />);
    expect(html).toContain('aria-label="sparkline, 3 points, 2 to 5, ending 3"');
  });

  it("uses the caller's ariaLabel verbatim instead of building one", () => {
    const html = renderToStaticMarkup(<Sparkline values={[2, 5, 3]} ariaLabel="p95 latency trend" />);
    expect(html).toContain('aria-label="p95 latency trend"');
    expect(html).not.toContain("sparkline, 3 points");
  });
});

function pathCount(html: string): number {
  return html.split("<path").length - 1;
}
