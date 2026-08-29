import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FindingsPanel, maxBreadth, type EntityData } from "./FindingsPanel";
import type { TraceView } from "./types";

/**
 * FindingsPanel.tsx had zero test coverage anywhere, while every other panel
 * in components/build/ (AgentPanel, CostBreakdown, DecisionsStrip, EventFeed,
 * PlanCard, ResultPanel, SearchesPanel, StageTracker) already has a test —
 * this one was missed by 40cea9d's and 8a4a89f's sweeps of the directory.
 * D-scope, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md is gone from this checkout — see 48c1eaa's note
 * on recovering section D's scope from git history). Continuing the SELF-<n>
 * numbering from SELF-168.
 *
 * `tab` state defaults to "calls" and there is no jsdom/RTL harness here (the
 * same gap 8a4a89f documents), so only the default-rendered CallsTab can be
 * exercised by rendering the top-level component; the map tab is reached by
 * a click this test cannot simulate. CallsTab's own real branches — the
 * empty guard, the newest-first reversal ("a live reader is watching the
 * head of the stream, not its tail", the component's own comment) and the
 * failed-call styling — are all visible in that default render.
 *
 * MapTab's one piece of arithmetic, the breadth bar's divide-by-zero guard,
 * was pulled out to the exported `maxBreadth` and is tested directly instead,
 * the same move 8a4a89f made for PlanCard's `plannedDropped`.
 */

function call(overrides: Partial<TraceView>): TraceView {
  return {
    seq: 0,
    ts: "",
    round: 0,
    agent: "sweep",
    tool: "serp",
    kind: "search",
    argsDigest: "",
    ms: 0,
    ok: true,
    error: "",
    usd: 0,
    runningUsd: 0,
    ...overrides,
  };
}

describe("FindingsPanel's calls tab (the default tab)", () => {
  it("shows the empty-state text rather than an empty table", () => {
    const html = renderToStaticMarkup(<FindingsPanel calls={[]} entities={[]} />);
    expect(html).toContain("every search and every page fetch appears here");
    expect(html).not.toContain("<table");
  });

  it("orders rows newest first", () => {
    const calls = [
      call({ seq: 1, argsDigest: "first query" }),
      call({ seq: 2, argsDigest: "second query" }),
      call({ seq: 3, argsDigest: "third query" }),
    ];
    const html = renderToStaticMarkup(<FindingsPanel calls={calls} entities={[]} />);
    const iThird = html.indexOf("third query");
    const iSecond = html.indexOf("second query");
    const iFirst = html.indexOf("first query");
    expect(iThird).toBeGreaterThan(-1);
    expect(iThird).toBeLessThan(iSecond);
    expect(iSecond).toBeLessThan(iFirst);
  });

  it("marks a failed call distinctly from an ok one", () => {
    const calls = [call({ argsDigest: "ok call", ok: true }), call({ argsDigest: "bad call", ok: false })];
    const html = renderToStaticMarkup(<FindingsPanel calls={calls} entities={[]} />);
    expect(html).toMatch(/text-rose-300 line-through">bad call/);
    expect(html).not.toMatch(/text-rose-300 line-through">ok call/);
  });

  it("falls back to the tool name when argsDigest is empty", () => {
    const calls = [call({ argsDigest: "", tool: "fetch" })];
    const html = renderToStaticMarkup(<FindingsPanel calls={calls} entities={[]} />);
    expect(html).toContain(">fetch<");
  });

  it("shows the calls count in the tab strip", () => {
    const calls = [call({ seq: 1 }), call({ seq: 2 }), call({ seq: 3 })];
    const html = renderToStaticMarkup(<FindingsPanel calls={calls} entities={[]} />);
    expect(html).toContain(">3<");
  });
});

describe("maxBreadth: the map tab's breadth-bar divide-by-zero guard", () => {
  it("floors at 1 for an empty list, rather than dividing by 0", () => {
    expect(maxBreadth([])).toBe(1);
  });

  it("floors at 1 when every entity has breadth 0 or undefined", () => {
    const entities: EntityData[] = [{ domain: "a.com" }, { domain: "b.com", breadth: 0 }];
    expect(maxBreadth(entities)).toBe(1);
  });

  it("returns the widest bar's breadth, not the count of entities", () => {
    const entities: EntityData[] = [
      { domain: "a.com", breadth: 2 },
      { domain: "b.com", breadth: 9 },
      { domain: "c.com", breadth: 4 },
    ];
    expect(maxBreadth(entities)).toBe(9);
  });
});
