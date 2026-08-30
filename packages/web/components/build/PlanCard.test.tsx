import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanCard, UnderstandingCard } from "./PlanCard";
import type { PlanView, PlannedQueryView, UnderstandingView } from "./types";

/**
 * PlanCard.tsx had zero test coverage anywhere, the one .tsx left in
 * components/build/ without one after 8a4a89f (AgentPanel, CostBreakdown,
 * DecisionsStrip, EventFeed, FindingsPanel, ResultPanel, SearchesPanel,
 * StageTracker, types.ts all have a test; SELF-169 filled FindingsPanel).
 * D-scope, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md is gone from this checkout — see 48c1eaa's note
 * on recovering section D's scope from git history). Continuing the SELF-<n>
 * numbering from SELF-169.
 *
 * `groupPlan`, `plannedDropped` and `formatUsd` already have direct unit
 * tests in types.test.ts, so this file exercises the JSX branches that call
 * them: which chip tone and copy the reader gets, whether the ceiling note
 * renders, and PlanCard's own running-offset numbering across groups. There
 * is no jsdom/RTL harness in this repo (the gap 8a4a89f documents for
 * PlanCard's sibling panels), so `QueryGroup`'s "show all" toggle — reached
 * only by a click — is out of reach; its default-collapsed render (the
 * PREVIEW slice and the button's presence/absence) is not.
 */

function query(overrides: Partial<PlannedQueryView>): PlannedQueryView {
  return { q: "site:reddit.com pain point", source: "pain", rationale: "", ...overrides };
}

function plan(overrides: Partial<PlanView>): PlanView {
  return { domain: "acme.com", count: 0, queries: [], estimatedUsd: 0, ...overrides };
}

describe("UnderstandingCard", () => {
  it("shows a dash for sells and buyer when both are empty", () => {
    const u: UnderstandingView = { domain: "", sells: "", buyer: "", products: [], coinages: [], usd: 0 };
    const html = renderToStaticMarkup(<UnderstandingCard u={u} />);
    expect(html).toContain(">—<");
  });

  it("lists products with a count badge when products were read", () => {
    const u: UnderstandingView = {
      domain: "acme.com",
      sells: "widgets",
      buyer: "ops teams",
      products: [{ name: "Widget Pro", sells: "automates widget QA" }],
      coinages: [],
      usd: 0,
    };
    const html = renderToStaticMarkup(<UnderstandingCard u={u} />);
    expect(html).toContain("Widget Pro");
    expect(html).toContain(">1<");
    expect(html).not.toContain("No product could be read off their own pages");
  });

  it("falls back to the no-product message when the list is empty", () => {
    const u: UnderstandingView = { domain: "acme.com", sells: "widgets", buyer: "", products: [], coinages: [], usd: 0 };
    const html = renderToStaticMarkup(<UnderstandingCard u={u} />);
    expect(html).toContain("No product could be read off their own pages");
  });

  it("omits the coinages section entirely when there are none", () => {
    const u: UnderstandingView = { domain: "acme.com", sells: "", buyer: "", products: [], coinages: [], usd: 0 };
    const html = renderToStaticMarkup(<UnderstandingCard u={u} />);
    expect(html).not.toContain("never searched");
  });

  it("shows every coinage struck through, up to 14, with an overflow count past that", () => {
    const coinages = Array.from({ length: 16 }, (_, i) => `coinage-${i}`);
    const u: UnderstandingView = { domain: "acme.com", sells: "", buyer: "", products: [], coinages, usd: 0 };
    const html = renderToStaticMarkup(<UnderstandingCard u={u} />);
    expect(html).toContain("coinage-0");
    expect(html).toContain("coinage-13");
    expect(html).not.toContain(">coinage-14<");
    expect(html).toContain("+2");
  });
});

describe("PlanCard: the dropped-queries chip", () => {
  it("reads amber with the drop count when the filter dropped queries", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={plan({ queries: [query({})], written: 5 })} />,
    );
    expect(html).toMatch(/border-amber-500\/30[^"]*"[^>]*>4 dropped before buying/);
  });

  it("reads emerald with no drop count when every written query survived", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={plan({ queries: [query({}), query({})], written: 2 })} />,
    );
    expect(html).toContain("every written query survived the name filter");
    expect(html).not.toContain("dropped before buying");
  });
});

describe("PlanCard: requested/written chips", () => {
  it("omits both chips when neither figure rode the frame", () => {
    const html = renderToStaticMarkup(<PlanCard plan={plan({ queries: [query({})] })} />);
    expect(html).not.toContain("asked for");
    expect(html).not.toContain("catalog wrote");
  });

  it("shows each figure only when it is present on the frame", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={plan({ queries: [query({})], requested: 20, written: 18 })} />,
    );
    expect(html).toContain("asked for 20");
    expect(html).toContain("catalog wrote 18");
  });
});

describe("PlanCard: the deployment-ceiling note", () => {
  it("is absent on an uncapped run", () => {
    const html = renderToStaticMarkup(<PlanCard plan={plan({ queries: [query({})] })} />);
    expect(html).not.toContain("sized to this host");
  });

  it("names the ceiling, singular phrasing for one question", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={plan({ queries: [query({})], ceiling: 1 })} />,
    );
    expect(html).toContain("1 question,");
    expect(html).not.toContain("1 questions");
  });

  it("names the clock only when clockSeconds rode along with the ceiling", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={plan({ queries: [query({})], ceiling: 12, clockSeconds: 240 })} />,
    );
    expect(html).toContain("12 questions");
    expect(html).toContain("is what fits in 240s");
  });
});

describe("PlanCard: the empty-plan message", () => {
  it("says no queries were planned when the count is also zero", () => {
    const html = renderToStaticMarkup(<PlanCard plan={plan({ count: 0, queries: [] })} />);
    expect(html).toContain("No queries planned.");
  });

  it("reports the count-only frame when queries carried no per-query detail", () => {
    const html = renderToStaticMarkup(<PlanCard plan={plan({ count: 24, queries: [] })} />);
    expect(html).toContain("24 queries planned");
    expect(html).toContain("per-query reasons were not carried on the stream");
  });
});

describe("PlanCard: query groups and running offsets", () => {
  it("previews only the first 6 queries per group and offers the rest behind a button", () => {
    const queries = Array.from({ length: 8 }, (_, i) => query({ q: `pain query ${i}`, source: "pain" }));
    const html = renderToStaticMarkup(<PlanCard plan={plan({ count: 8, queries })} />);
    expect(html).toContain("pain query 0");
    expect(html).toContain("pain query 5");
    expect(html).not.toContain("pain query 6");
    expect(html).toContain("show all 8");
  });

  it("shows no toggle button when a group is at or under the preview size", () => {
    const queries = Array.from({ length: 3 }, (_, i) => query({ q: `pain query ${i}`, source: "pain" }));
    const html = renderToStaticMarkup(<PlanCard plan={plan({ count: 3, queries })} />);
    expect(html).not.toContain("show all");
  });

  it("numbers queries 001.. running across groups, not restarting per group", () => {
    // groupPlan sorts largest group first, so "pain" (3) renders before "hiring" (1).
    const queries = [
      query({ q: "pain-a", source: "pain" }),
      query({ q: "pain-b", source: "pain" }),
      query({ q: "pain-c", source: "pain" }),
      query({ q: "hiring-a", source: "hiring" }),
    ];
    const html = renderToStaticMarkup(<PlanCard plan={plan({ count: 4, queries })} />);
    const iPainA = html.indexOf("pain-a");
    const iHiringA = html.indexOf("hiring-a");
    expect(html.lastIndexOf("001", iPainA)).toBeGreaterThan(-1);
    expect(html.slice(0, iHiringA)).toContain("004");
  });

  it("marks a query with no rationale rather than inventing one", () => {
    const html = renderToStaticMarkup(
      <PlanCard plan={plan({ count: 1, queries: [query({ rationale: "" })] })} />,
    );
    expect(html).toContain("no reason travelled with this query");
  });
});
