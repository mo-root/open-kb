import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostBreakdown } from "./CostBreakdown";
import type { CostLineView, RunCostView } from "./types";

/**
 * CostBreakdown.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering section
 * D's scope from git history). Continuing the SELF-<n> numbering from SELF-99.
 *
 * Pure props-in-markup-out (no hooks), so renderToStaticMarkup pins the real
 * branches: the `!cost` guard, the uncapped-vs-capped ceiling hint, the
 * per-unit divide-by-zero guard (`units && units > 0`, not just `units`), the
 * `Lines` component's "+N more" rollup when a row list exceeds its `max`
 * (never a silent cap, per that component's own comment), the empty-list
 * guard that must render nothing rather than an empty section, and the
 * failures/tool-time/partial conditionals that are each gated on a specific
 * truthy check rather than presence alone.
 */

const line = (over: Partial<CostLineView> = {}): CostLineView => ({
  label: "serp",
  calls: 1,
  failures: 0,
  usd: 0.01,
  ms: 0,
  ...over,
});

const cost = (over: Partial<RunCostView> = {}): RunCostView => ({
  usd: 1.2345,
  elapsedMs: 754_000,
  calls: 40,
  tokens: 12_000,
  ceilingUsd: 2,
  byKind: [line()],
  byAgent: [line({ label: "rank" })],
  partial: false,
  ...over,
});

describe("CostBreakdown renders nothing without a bill", () => {
  it("returns an empty string when cost is null", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={null} />);
    expect(html).toBe("");
  });
});

describe("CostBreakdown's ceiling hint", () => {
  it("says 'of $X ceiling' when the run had one", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ ceilingUsd: 2 })} />);
    expect(html).toContain("of $2.0000 ceiling");
    expect(html).not.toContain("no ceiling");
  });

  it("says 'no ceiling' when ceilingUsd is null", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ ceilingUsd: null })} />);
    expect(html).toContain("no ceiling");
  });

  it("also reads a ceiling of exactly 0 as uncapped, not a $0.00 ceiling", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ ceilingUsd: 0 })} />);
    expect(html).toContain("no ceiling");
  });
});

describe("CostBreakdown's per-unit cost", () => {
  it("divides the total by units when given a positive count", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ usd: 2 })} units={4} />);
    expect(html).toContain("$0.5000");
    expect(html).toContain("4 on the map");
  });

  it("shows an em dash, not a division by zero, when units is 0", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost()} units={0} />);
    expect(html).toContain(">—<");
    expect(html).not.toContain("on the map");
  });

  it("shows an em dash when units is omitted entirely", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost()} />);
    expect(html).toContain(">—<");
  });

  it("labels the unit 'entity' by default and honours a custom label", () => {
    const withDefault = renderToStaticMarkup(<CostBreakdown cost={cost()} units={1} />);
    expect(withDefault).toContain("per entity");
    const withCustom = renderToStaticMarkup(
      <CostBreakdown cost={cost()} units={1} unitLabel="host" />,
    );
    expect(withCustom).toContain("per host");
  });
});

describe("CostBreakdown's Lines rollup", () => {
  it("renders nothing for an empty row list rather than an empty section", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ byKind: [] })} />);
    expect(html).not.toContain("by tool");
  });

  it("shows every row when the list is at or under its max", () => {
    const rows = Array.from({ length: 6 }, (_, i) => line({ label: `k${i}`, usd: 0.01 }));
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ byKind: rows })} />);
    for (const r of rows) expect(html).toContain(r.label);
    expect(html).not.toContain("more ·");
  });

  it("folds the tail into a '+N more' line that keeps the column summing to the total", () => {
    const rows = Array.from({ length: 8 }, (_, i) => line({ label: `k${i}`, usd: 0.01, calls: 2 }));
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ byKind: rows })} />);
    // max for "by tool" is 6, so rows k6 and k7 fold into the tail.
    expect(html).toContain("k5");
    expect(html).not.toContain(">k6<");
    expect(html).not.toContain(">k7<");
    expect(html).toContain("+ 2 more");
    expect(html).toContain("$0.0200");
    expect(html).toContain("4 calls");
  });

  it("maps a known kind label and falls back to the raw label for an unknown one", () => {
    const html = renderToStaticMarkup(
      <CostBreakdown cost={cost({ byKind: [line({ label: "serp" }), line({ label: "mystery" })] })} />,
    );
    expect(html).toContain("search");
    expect(html).toContain("mystery");
  });

  it("shows a failure count only when failures is greater than zero", () => {
    const withFailures = renderToStaticMarkup(
      <CostBreakdown cost={cost({ byKind: [line({ failures: 3 })] })} />,
    );
    expect(withFailures).toContain("3 failed");
    const withoutFailures = renderToStaticMarkup(
      <CostBreakdown cost={cost({ byKind: [line({ failures: 0 })] })} />,
    );
    expect(withoutFailures).not.toContain("failed");
  });

  it("shows tool time only when ms is greater than zero", () => {
    const withMs = renderToStaticMarkup(<CostBreakdown cost={cost({ byKind: [line({ ms: 60_000 })] })} />);
    expect(withMs).toContain("of tool time");
    const withoutMs = renderToStaticMarkup(<CostBreakdown cost={cost({ byKind: [line({ ms: 0 })] })} />);
    expect(withoutMs).not.toContain("of tool time");
  });

  it("singularises 'call' for exactly one call", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ byKind: [line({ calls: 1 })] })} />);
    expect(html).toContain("1 call<");
    expect(html).not.toContain("1 calls");
  });
});

describe("CostBreakdown's partial-spend caveat", () => {
  it("shows the caveat only when partial is true", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ partial: true })} />);
    expect(html).toContain("The lines above cover part of the spend");
  });

  it("says nothing when partial is false", () => {
    const html = renderToStaticMarkup(<CostBreakdown cost={cost({ partial: false })} />);
    expect(html).not.toContain("cover part of the spend");
  });
});
