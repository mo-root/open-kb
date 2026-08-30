import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraphSearch, type SearchItem } from "./GraphSearch";

/**
 * GraphSearch.tsx had zero test coverage anywhere. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout, untracked by 481fa6d — section D scope
 * recovered from `git show 481fa6d^:docs/overnight-backlog.md`, the same
 * recovery prior SELF-<n> commits used). git log names SELF-185 as the last
 * used, so this is SELF-186.
 *
 * Confirmed zero coverage with `grep -rln "GraphSearch" packages/web` before
 * this change: the only non-test hits were the import/render in
 * GraphCanvas.tsx and this file itself. NodeGlyph.test.tsx and
 * typingGuard.test.ts each name "GraphSearch" too, but only in prose (listing
 * it as one of NodeGlyph's consumers, and noting it shares typingGuard.ts with
 * CommandPalette.tsx) — neither imports or renders the component. The ranking
 * logic it calls, `rankMatches`, is already fully covered in its own
 * lib/graph/search.test.ts, so nothing here re-tests ranking.
 *
 * Every stateful path — typing into the box, the `/`-focuses-from-anywhere
 * listener, arrow-key/Enter/Escape handling, the blur-delay-for-click-through —
 * needs a live DOM this repo has no jsdom/RTL harness for, same limitation
 * ThemeToggle.test.tsx and FindingsPanel.test.tsx already documented for their
 * own hook-driven parts. What renderToStaticMarkup CAN pin is the one render
 * that ships over the wire: `q` starts as `""` (GraphSearch.tsx:37), and no
 * prop or argument to the component can move it — it is pure internal state
 * set only by the `onChange` handler, which never runs during SSR. That
 * resolves to one specific, checkable shape: the kbd hint reads "/" rather
 * than a result count (`q ? ... : "/"`, GraphSearch.tsx:107, and `q` is
 * falsy), and the dropdown never renders (`open && q.trim() !== ""`,
 * GraphSearch.tsx:110) because the `q.trim() !== ""` half of that guard is
 * false — confirmed by flipping `open`'s own initial value to `true` and
 * seeing the dropdown still not render, so it is `q`, not `open`, this test
 * actually pins. That holds no matter how many items are passed in or how
 * well they would match an empty query, since `rankMatches` returns `[]` for
 * an empty query before it ever looks at `items` (lib/graph/search.ts:20).
 */

function item(overrides: Partial<SearchItem>): SearchItem {
  return { id: "a", title: "Apify", domain: "apify.com", type: "core", deg: 5, ...overrides };
}

describe("GraphSearch: the pre-interaction render is query-agnostic", () => {
  it("starts with an empty controlled input", () => {
    const html = renderToStaticMarkup(
      <GraphSearch items={[]} onPick={() => {}} onQueryChange={() => {}} />,
    );
    expect(html).toMatch(/<input[^>]*value=""/);
  });

  it("labels and hints the box for a reader who has not typed yet", () => {
    const html = renderToStaticMarkup(
      <GraphSearch items={[]} onPick={() => {}} onQueryChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Find a node on the map"');
    expect(html).toContain('placeholder="Find on the map…"');
  });

  it("shows the '/' shortcut hint, not a result count, before any query", () => {
    const html = renderToStaticMarkup(
      <GraphSearch items={[]} onPick={() => {}} onQueryChange={() => {}} />,
    );
    expect(html).toMatch(/<kbd[^>]*>\/<\/kbd>/);
  });

  it("renders no dropdown on first paint, regardless of how many items are given", () => {
    const items = [
      item({ id: "a", title: "Apify" }),
      item({ id: "b", title: "Bright Data", domain: "brightdata.com" }),
    ];
    const html = renderToStaticMarkup(
      <GraphSearch items={items} onPick={() => {}} onQueryChange={() => {}} />,
    );
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("Apify");
  });
});
