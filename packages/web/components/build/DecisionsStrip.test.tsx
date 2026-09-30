import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionsStrip, type Decision } from "./DecisionsStrip";

/**
 * DecisionsStrip.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history). Continuing the SELF-<n> numbering
 * from SELF-85.
 *
 * The component is a pure props-in renderer (no pointer/focus handlers, so
 * none of the jsdom/RTL gap other D-scope tests hit applies here) with three
 * real branches worth pinning: the empty-list guard that must render nothing
 * rather than an empty shell, the newest-first reversal (the strip's whole
 * point per its own doc comment — "the live question is always what did it
 * just decide"), and `clock()`'s minute/second padding, including that
 * `atSec === 0` is a real timestamp and must render rather than being
 * treated as falsy (the same `!== undefined` class of guard already pinned
 * on TabBar's count badge).
 */

describe("DecisionsStrip renders nothing for an empty list", () => {
  it("returns an empty string rather than an empty section shell", () => {
    const html = renderToStaticMarkup(<DecisionsStrip decisions={[]} />);
    expect(html).toBe("");
  });
});

describe("DecisionsStrip orders rows newest first", () => {
  it("reverses the input so the most recent decision leads", () => {
    const decisions: Decision[] = [
      { id: 1, text: "round 1: 40 hosts found" },
      { id: 2, text: "round 2: 9 more queries queued" },
      { id: 3, text: "enough — 118 hosts" },
    ];
    const html = renderToStaticMarkup(<DecisionsStrip decisions={decisions} />);
    const iEnough = html.indexOf("enough — 118 hosts");
    const iRound2 = html.indexOf("round 2: 9 more queries queued");
    const iRound1 = html.indexOf("round 1: 40 hosts found");
    expect(iEnough).toBeGreaterThan(-1);
    expect(iEnough).toBeLessThan(iRound2);
    expect(iRound2).toBeLessThan(iRound1);
  });

  it("shows the count, not just the rows", () => {
    const decisions: Decision[] = [
      { id: 1, text: "a" },
      { id: 2, text: "b" },
    ];
    const html = renderToStaticMarkup(<DecisionsStrip decisions={decisions} />);
    expect(html).toContain(">2<");
  });
});

describe("DecisionsStrip's clock formats seconds as mm:ss", () => {
  it("pads single-digit minutes and seconds", () => {
    const html = renderToStaticMarkup(
      <DecisionsStrip decisions={[{ id: 1, text: "round 2", atSec: 65 }]} />,
    );
    expect(html).toContain(">01:05<");
  });

  it("renders atSec: 0 — a real timestamp, not an absent one", () => {
    const html = renderToStaticMarkup(
      <DecisionsStrip decisions={[{ id: 1, text: "first decision", atSec: 0 }]} />,
    );
    expect(html).toContain(">00:00<");
  });

  it("omits the clock span entirely when atSec is undefined", () => {
    const html = renderToStaticMarkup(
      <DecisionsStrip decisions={[{ id: 1, text: "no timestamp on this one" }]} />,
    );
    expect(html).not.toContain("tnum shrink-0");
    expect(html).toContain("no timestamp on this one");
  });

  it("floors a fractional atSec instead of printing raw float digits", () => {
    // `Decision.atSec` is a bare `number`; readProgress's own test (types.test.ts)
    // pins a fractional value as valid input. 65.3 % 60 is 5.299999999999997 in
    // floating point, not 5.3 — without flooring first, padStart sees a string
    // already longer than 2 and pads nothing, so this would render
    // "01:5.299999999999997" instead of a clock.
    const html = renderToStaticMarkup(
      <DecisionsStrip decisions={[{ id: 1, text: "round 2", atSec: 65.3 }]} />,
    );
    expect(html).toContain(">01:05<");
  });
});
