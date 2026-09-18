import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarMeter } from "./BarMeter";

/**
 * ZERO TEST COVERAGE ANYWHERE, same gap Donut.test.tsx and Gauge.test.tsx
 * closed in this directory. BarMeter has its own real logic neither of those
 * files exercises: a `ceiling` that defaults to the largest row value but
 * must not divide by zero when every row is zero, a `sort` flag that
 * `KbOverview.tsx` explicitly turns off (`sort={false}`, to keep the
 * ecosystem panel in the classifier's own relation order) and `ResultPanel.tsx`
 * leaves on, and a `minWidth` floor that keeps a nonzero-but-tiny bar visible
 * without giving a true zero the same sliver.
 *
 * `glyph` (the leading icon a row may carry — KbOverview.tsx's ecosystem and
 * rivals panels both pass one, `kb/KbOverview.tsx:348`) was still an
 * uncovered branch after all of the above: a coverage-v8 run over
 * `packages/web/components/**` (D-scope, following SELF-520's precedent of
 * running coverage over web, which had none before) found it as the one
 * untested branch in an otherwise 100%-statement file. StatTile.test.tsx
 * next door already pins the identical optional-glyph pattern for its own
 * `glyph` prop — the same test shape, applied here.
 */

describe("BarMeter's ceiling defaults to the largest row, not a fixed scale", () => {
  it("fills a mid-value bar to less than 100% when a larger row sets the ceiling", () => {
    const html = renderToStaticMarkup(
      <BarMeter rows={[{ label: "a", value: 5 }, { label: "b", value: 10 }]} sort={false} />,
    );
    const widths = [...html.matchAll(/width:(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([50, 100]);
  });

  it("does not divide by zero when every row is zero", () => {
    const html = renderToStaticMarkup(
      <BarMeter rows={[{ label: "a", value: 0 }, { label: "b", value: 0 }]} />,
    );
    expect(html).not.toContain("NaN");
    const widths = [...html.matchAll(/width:(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([0, 0]);
  });
});

describe("BarMeter's sort flag decides whether rows keep their caller-given order", () => {
  const rows = [
    { label: "small", value: 1 },
    { label: "big", value: 9 },
    { label: "mid", value: 4 },
  ];

  it("reorders descending by value when sort is on (the default)", () => {
    const html = renderToStaticMarkup(<BarMeter rows={rows} />);
    const order = [...html.matchAll(/uppercase tracking-wide text-slate-400">([a-z]+)</g)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["big", "mid", "small"]);
  });

  it("keeps the given order when sort is off, as KbOverview relies on for relation order", () => {
    const html = renderToStaticMarkup(<BarMeter rows={rows} sort={false} />);
    const order = [...html.matchAll(/uppercase tracking-wide text-slate-400">([a-z]+)</g)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["small", "big", "mid"]);
  });
});

describe("BarMeter gives a nonzero row a visible sliver but a true zero none", () => {
  it("sets minWidth 3 for a nonzero value and 0 for a zero value", () => {
    const html = renderToStaticMarkup(
      <BarMeter rows={[{ label: "a", value: 0 }, { label: "b", value: 1 }]} sort={false} />,
    );
    // React omits the unit on a literal 0 ("min-width:0") but keeps it on any
    // other number ("min-width:3px"), so the pattern has to accept both.
    const minWidths = [...html.matchAll(/min-width:(\d+)(?:px)?/g)].map((m) => Number(m[1]));
    expect(minWidths).toEqual([0, 3]);
  });
});

describe("BarMeter's glyph is optional, the same pattern StatTile.test.tsx pins", () => {
  it("omits the leading glyph span entirely when a row has none", () => {
    const html = renderToStaticMarkup(<BarMeter rows={[{ label: "a", value: 1 }]} />);
    expect(html).not.toContain("aria-hidden");
  });

  it("renders the glyph inside an aria-hidden span when a row has one", () => {
    // The real caller: KbOverview.tsx's ecosystem/rivals panels pass
    // `glyph: <NodeGlyph .../>` per row (kb/KbOverview.tsx:348), which this
    // file had never driven — every row above omits it.
    const html = renderToStaticMarkup(
      <BarMeter rows={[{ label: "a", value: 1, glyph: <span>*</span> }]} />,
    );
    expect(html).toContain("aria-hidden");
    expect(html).toContain(">*<");
  });
});

describe("BarMeter's value label follows valueFormat, defaulting to a locale integer", () => {
  it("uses the caller's formatter when one is given", () => {
    const html = renderToStaticMarkup(
      <BarMeter rows={[{ label: "cost", value: 1234 }]} valueFormat={(n) => `$${n}`} />,
    );
    expect(html).toContain("$1234");
  });

  it("falls back to toLocaleString when no formatter is given", () => {
    const html = renderToStaticMarkup(<BarMeter rows={[{ label: "cost", value: 1234 }]} />);
    expect(html).toContain((1234).toLocaleString());
  });
});
