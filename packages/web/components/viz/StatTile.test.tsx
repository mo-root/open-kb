import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatTile } from "./StatTile";

/**
 * ZERO TEST COVERAGE ANYWHERE, the last file in this directory's viz sweep
 * (Donut, Gauge, BarMeter, Sparkline all closed the same gap already).
 * StatTile's own untested logic is `compact()`: a string value passes
 * through unchanged, a non-finite number renders "—", and the two
 * thresholds (1e4 for K, 1e6 for M) each pick toFixed(0) on an exact
 * multiple vs toFixed(1) otherwise via `v % 1e3 === 0` / `v % 1e6 === 0`.
 * Also covers the three independently-optional pieces (glyph, hint, trend)
 * and that trend needs more than one point before Sparkline renders at all.
 */

describe("StatTile's compact() formats the headline value", () => {
  it("passes a string value through unchanged, with no locale formatting", () => {
    const html = renderToStaticMarkup(<StatTile label="Status" value="N/A" />);
    expect(html).toContain(">N/A<");
  });

  it("renders an em dash for a non-finite number", () => {
    const html = renderToStaticMarkup(<StatTile label="Rate" value={NaN} />);
    expect(html).toContain(">—<");
  });

  it("uses toLocaleString for a value under the 1e4 K-threshold", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={1284} />);
    expect(html).toContain(">1,284<");
  });

  it("formats an exact multiple of 1e3 at the K threshold with no decimal", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={10000} />);
    expect(html).toContain(">10K<");
  });

  it("formats a non-exact K value with one decimal", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={12900} />);
    expect(html).toContain(">12.9K<");
  });

  it("formats an exact multiple of 1e6 at the M threshold with no decimal", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={2000000} />);
    expect(html).toContain(">2M<");
  });

  it("formats a non-exact M value with one decimal", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={4200000} />);
    expect(html).toContain(">4.2M<");
  });

  it("keeps the sign on a negative exact-multiple M value", () => {
    const html = renderToStaticMarkup(<StatTile label="Delta" value={-2000000} />);
    expect(html).toContain(">-2M<");
  });
});

describe("StatTile's glyph, hint and trend are each independently optional", () => {
  it("omits the glyph span entirely when glyph is not passed", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={1} />);
    expect(html).not.toContain("aria-hidden");
  });

  it("renders the glyph inside an aria-hidden span when passed", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} glyph={<span>*</span>} />,
    );
    expect(html).toContain("aria-hidden");
  });

  it("omits the hint line when hint is not passed", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={1} />);
    expect(html).not.toContain("38% of notes");
  });

  it("renders the hint line when passed", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} hint="38% of notes" />,
    );
    expect(html).toContain("38% of notes");
  });

  it("renders no sparkline when trend is omitted", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={1} />);
    expect(html).not.toContain("<svg");
  });

  it("renders no sparkline when trend has a single point", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={1} trend={[5]} />);
    expect(html).not.toContain("<svg");
  });

  it("renders a sparkline once trend has more than one point", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} trend={[5, 8, 3]} />,
    );
    expect(html).toContain("<svg");
  });

  it("uses the default accent var for trendColor when not passed", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} trend={[5, 8, 3]} />,
    );
    expect(html).toContain("var(--accent, #3D7FFC)");
  });

  it("uses the caller's trendColor instead of the default when passed", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} trend={[5, 8, 3]} trendColor="#ff0000" />,
    );
    expect(html).toContain("#ff0000");
    expect(html).not.toContain("var(--accent, #3D7FFC)");
  });
});

describe("StatTile's tone and className pass straight into the DOM", () => {
  it("defaults the value's tone class to text-slate-100", () => {
    const html = renderToStaticMarkup(<StatTile label="Notes" value={1} />);
    expect(html).toContain("text-slate-100");
  });

  it("uses the caller's tone class instead of the default when passed", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} tone="text-rose-400" />,
    );
    expect(html).toContain("text-rose-400");
    expect(html).not.toContain("text-slate-100");
  });

  it("appends the caller's className to the root without dropping the base classes", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Notes" value={1} className="col-span-2" />,
    );
    expect(html).toContain("col-span-2");
    expect(html).toContain("bg-slate-900");
  });
});
