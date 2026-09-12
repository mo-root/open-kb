import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JUDGED_KINDS } from "@open-kb/core";
import { KIND_COLOR, ResultPanel, type RunResult } from "./ResultPanel";

/**
 * `KIND_COLOR` was missing `unknown`, one of `JUDGED_KINDS`' seven members
 * (`@open-kb/core/judge`). `noise` is rightly absent — `onMap()`
 * (packages/sweep/src/sweep.ts) filters it out of `keep` before a report's
 * `kinds` tally is ever built, so it structurally cannot reach this donut.
 * `unknown` is not filtered — `onMap`'s own doc comment says so, a host the
 * judge found but could not place — and every kept `unknown` entity fell
 * through `Composition`'s `KIND_COLOR[label] ?? "#7C8BA8"` to the exact
 * colour already spoken for by `directory`, so an unplaced host was
 * indistinguishable from a directory listing in the one chart meant to say
 * what kind of thing came back.
 *
 * Same shape of gap as SELF-105's `FAMILY_TONE` and B3's `RELATION_ORDER`: a
 * closed union, a hand-copied chip map, one member short, silently absorbed
 * by a fallback instead of erroring. Pinned against the real union here so a
 * further `JUDGED_KINDS` member fails this test instead of landing in the
 * fallback again. D-scope sweep, self-discovered (A, B and C are all done or
 * BLOCKED; docs/overnight-backlog.md itself is gone from this checkout — see
 * 48c1eaa's note on recovering section D's scope from git history).
 */
describe("KIND_COLOR covers every reachable JUDGED_KINDS member", () => {
  const REACHABLE = JUDGED_KINDS.filter((k) => k !== "noise");

  it("has a distinct colour for each kind onMap() can keep, not the fallback", () => {
    for (const k of REACHABLE) expect(KIND_COLOR[k]).toBeDefined();
  });

  it("gives no two reachable kinds the same colour", () => {
    const colors = REACHABLE.map((k) => KIND_COLOR[k]);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("does not bother defining noise, which onMap() always filters first", () => {
    expect(KIND_COLOR.noise).toBeUndefined();
  });
});

/**
 * `ResultPanel` itself — the three-ending switch above's actual subject —
 * had zero test coverage: `@vitest/coverage-v8` measured this file at 9.6%
 * lines / 100% branches / 0% functions before this commit, meaning the one
 * test above exercises `KIND_COLOR` as a data object and never once calls
 * `Stat`, `Composition`, `ResultStats` or `ResultPanel` itself. It is props
 * in, markup out with no hooks (same shape as `CostBreakdown.tsx`, covered
 * the same way), so `renderToStaticMarkup` pins the real branches: the
 * `stopped`-wins-only-without-a-result precedence the component's own
 * comment calls out ("THREE endings, not two"), `errorText` outranking a
 * present `result`, the `kept ?? 0 === 0` empty-map guard catching both an
 * explicit 0 and an absent field, and `Composition`'s own `sells`/kind/
 * relation conditionals. D-scope, self-discovered (docs/overnight-backlog.md
 * is gone from this checkout, untracked by 481fa6d); git log names SELF-431
 * as the last used, so this is SELF-432.
 */
const result = (over: Partial<RunResult> = {}): RunResult => ({
  domain: "acme.com",
  kept: 12,
  hosts: 40,
  ...over,
});

describe("ResultPanel: stopped ending only wins without a result", () => {
  it("shows the neutral 'stopped' chrome when stopped is true and there is no result", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={null} errorText={null} stopped />,
    );
    expect(html).toContain("stopped");
    expect(html).toContain("you stopped the run — everything it had already found is kept");
    expect(html).toContain("nothing you spent here is lost");
  });

  it("falls through to the mapped ending when stopped is true but a result is present", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result()} errorText={null} stopped />,
    );
    expect(html).not.toContain("you stopped the run");
    expect(html).toContain("mapped");
  });
});

describe("ResultPanel: failed ending", () => {
  it("shows the failed badge with no <pre> when there is neither a result nor error text", () => {
    const html = renderToStaticMarkup(<ResultPanel result={null} errorText={null} />);
    expect(html).toContain("failed");
    expect(html).toContain("the run did not finish");
    expect(html).not.toContain("<pre");
  });

  it("renders the error text in a <pre> when it is given", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={null} errorText="ECONNRESET at fetch" />,
    );
    expect(html).toContain("<pre");
    expect(html).toContain("ECONNRESET at fetch");
  });

  it("errorText outranks a present result — a partial map still reads as failed", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ kept: 12 })} errorText="crashed mid-run" />,
    );
    expect(html).toContain("failed");
    expect(html).toContain("crashed mid-run");
    expect(html).not.toContain("mapped");
  });
});

describe("ResultPanel: empty-map ending", () => {
  it("shows the amber empty-map badge when kept is exactly 0", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ kept: 0, hosts: 7 })} errorText={null} />,
    );
    expect(html).toContain("empty map");
    expect(html).toContain("7 hosts came back and none survived classification");
  });

  it("also reads an absent kept field as empty, not as a crash", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ kept: undefined, hosts: 0 })} errorText={null} />,
    );
    expect(html).toContain("empty map");
    expect(html).toContain("0 hosts came back");
  });

  it("still renders the stat grid on an empty map, not just the badge", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ kept: 0, queries: 9, opening: 3 })} errorText={null} />,
    );
    expect(html).toContain("queries asked");
    expect(html).toContain(">9<");
    expect(html).toContain("opening hand");
    expect(html).toContain(">3<");
  });
});

describe("ResultPanel: mapped ending", () => {
  it("shows the domain alone when sells is absent", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ domain: "acme.com", sells: undefined })} errorText={null} />,
    );
    expect(html).toContain("mapped");
    expect(html).toContain(">acme.com<");
    expect(html).not.toContain(" — ");
  });

  it("appends ' — sells' after the domain when given", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ domain: "acme.com", sells: "widgets" })} errorText={null} />,
    );
    expect(html).toContain("acme.com — widgets");
  });
});

describe("ResultPanel's Composition chart", () => {
  it("renders neither chart heading when there are no kinds or relations", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ kinds: {}, relations: {} })} errorText={null} />,
    );
    expect(html).not.toContain("what kind of thing came back");
    expect(html).not.toContain("how each one stands to");
  });

  it("renders the kind donut and the relation bars once either is non-empty", () => {
    const html = renderToStaticMarkup(
      <ResultPanel
        result={result({ kinds: { company: 5, product: 2 }, relations: { competitor: 3, none: 4 } })}
        errorText={null}
      />,
    );
    expect(html).toContain("what kind of thing came back");
    expect(html).toContain("how each one stands to acme.com");
  });

  it("filters the 'none' relation out of the bars — it is not a rival reading", () => {
    const html = renderToStaticMarkup(
      <ResultPanel result={result({ kinds: {}, relations: { none: 4 } })} errorText={null} />,
    );
    expect(html).not.toContain("how each one stands to");
  });
});
