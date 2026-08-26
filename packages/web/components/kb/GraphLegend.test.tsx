import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraphLegend } from "./GraphLegend";
import { TYPE_CSS, type NodeType } from "@/lib/nodeTypes";

/**
 * GraphLegend.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history).
 *
 * `onToggle`/`onHighlight` fire from pointer/focus events that need a live DOM
 * (same limitation TabBar.test.tsx and Donut.test.tsx note for this repo, which
 * has no jsdom/RTL harness) so this pins what a static render decides from
 * `visible`/`counts`/`types` alone: the swatch colour, the glyph colour, the
 * label's line-through, `aria-pressed`, the hide/show title, and the guard
 * that returns nothing for an empty map rather than an empty shell.
 */

const noop = () => {};
const ALL: Record<NodeType, boolean> = {
  core: true,
  product: true,
  player: true,
  community: true,
};
const ZERO: Record<NodeType, number> = { core: 0, product: 0, player: 0, community: 0 };

describe("GraphLegend renders nothing for a map with no types present", () => {
  it("returns an empty string rather than an empty overlay shell", () => {
    const html = renderToStaticMarkup(
      <GraphLegend
        types={[]}
        counts={ZERO}
        visible={ALL}
        onToggle={noop}
        onHighlight={noop}
      />,
    );
    expect(html).toBe("");
  });
});

describe("GraphLegend marks a visible type as on: its own colour, no strike-through, pressed", () => {
  it("paints the swatch and glyph in the type's TYPE_CSS colour", () => {
    const html = renderToStaticMarkup(
      <GraphLegend
        types={["product"]}
        counts={{ ...ZERO, product: 12 }}
        visible={ALL}
        onToggle={noop}
        onHighlight={noop}
      />,
    );
    expect(html).toContain(`background:${TYPE_CSS.product}`);
    expect(html).toContain(`color:${TYPE_CSS.product}`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="hover to pick them out · click to hide products"');
    expect(html).not.toContain("line-through");
    expect(html).toContain("12</span>");
  });
});

describe("GraphLegend marks a hidden type as off: the muted colour, struck through, unpressed", () => {
  it("falls back to var(--border)/var(--muted) and offers to show it again", () => {
    const html = renderToStaticMarkup(
      <GraphLegend
        types={["player"]}
        counts={{ ...ZERO, player: 3 }}
        visible={{ ...ALL, player: false }}
        onToggle={noop}
        onHighlight={noop}
      />,
    );
    expect(html).toContain("background:var(--border)");
    expect(html).toContain("color:var(--muted)");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('title="hover to pick them out · click to show players"');
    expect(html).toContain("line-through");
    expect(html).toContain("3</span>");
  });
});

describe("GraphLegend lists rows in the order the caller passes, not a fixed type order", () => {
  it("keeps community before core when given in that order", () => {
    const html = renderToStaticMarkup(
      <GraphLegend
        types={["community", "core"]}
        counts={ZERO}
        visible={ALL}
        onToggle={noop}
        onHighlight={noop}
      />,
    );
    expect(html.indexOf("communities")).toBeLessThan(html.indexOf(">core<"));
  });
});
