import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Gauge } from "./Gauge";

/**
 * ZERO TEST COVERAGE ANYWHERE, same gap Donut.test.tsx closed for its own
 * file. Gauge is the other file in this directory with real geometry —
 * `polar`/`arcPath` turn a value into an SVG arc — plus a `frac` clamp and a
 * `max === min` guard that Donut has no equivalent of, so this pins those
 * rather than duplicating Donut's coverage.
 */

describe("Gauge clamps frac instead of drawing past the track", () => {
  it("draws no fill arc when value sits at or below min", () => {
    // frac = max(0, min(1, (value-min)/(max-min))) = 0 at value === min, and
    // the fill path only renders when `frac > 0` — so exactly one <path>
    // (the track) reaches the DOM.
    const html = renderToStaticMarkup(<Gauge value={0} min={0} max={100} />);
    expect(html.split("<path").length - 1).toBe(1);
  });

  it("draws no fill arc for a value below min either", () => {
    const html = renderToStaticMarkup(<Gauge value={-40} min={0} max={100} />);
    expect(html.split("<path").length - 1).toBe(1);
  });

  it("caps the fill arc at the full sweep for a value above max", () => {
    // frac clamps to 1 regardless of how far past max the value runs, so the
    // fill arc's `d` for 150 matches the one for 100 against a max of 100 —
    // only the centre number (unclamped, `Math.round(value)`) differs.
    const over = renderToStaticMarkup(<Gauge value={150} min={0} max={100} />);
    const atMax = renderToStaticMarkup(<Gauge value={100} min={0} max={100} />);
    const paths = (html: string) => [...html.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths(over)).toEqual(paths(atMax));
    expect(over.split("<path").length - 1).toBe(2);
  });
});

describe("Gauge treats an empty range as zero rather than dividing by it", () => {
  it("renders only the track, not NaN geometry, when max equals min", () => {
    const html = renderToStaticMarkup(<Gauge value={5} min={10} max={10} />);
    expect(html).not.toContain("NaN");
    expect(html.split("<path").length - 1).toBe(1);
  });
});

describe("Gauge's aria label follows valueText, not the raw value", () => {
  it("appends the max only when valueText is omitted", () => {
    const html = renderToStaticMarkup(<Gauge value={42} max={100} label="cost" />);
    expect(html).toContain('aria-label="cost: 42 of 100"');
  });

  it("uses valueText verbatim and drops the implicit max suffix", () => {
    const html = renderToStaticMarkup(
      <Gauge value={42} max={100} label="cost" valueText="42%" />,
    );
    expect(html).toContain('aria-label="cost: 42%"');
    expect(html).not.toContain("of 100");
  });

  it("falls back to the word gauge when no label is given", () => {
    const html = renderToStaticMarkup(<Gauge value={3} max={10} />);
    expect(html).toContain('aria-label="gauge: 3 of 10"');
  });
});

describe("Gauge's large-arc flag follows the sweep it actually draws, not the track's", () => {
  it("marks the track large (240° sweep) but the half-full fill small (120°)", () => {
    // arcPath's `large` flag is 1 when the sweep exceeds 180°. The default
    // track always sweeps the full 240°; a half-full fill only sweeps 120°.
    const html = renderToStaticMarkup(<Gauge value={50} min={0} max={100} />);
    const paths = html.match(/<path[^>]*d="([^"]+)"/g) ?? [];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/A59 59 0 1 1/); // track: large=1, sweep=1
    expect(paths[1]).toMatch(/A59 59 0 0 1/); // fill: large=0, sweep=1
  });
});
