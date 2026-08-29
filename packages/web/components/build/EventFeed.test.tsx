import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventFeed } from "./EventFeed";
import type { FeedItem } from "./types";

/**
 * EventFeed.tsx had zero test coverage anywhere — `git grep -rln "EventFeed"
 * packages/web` before this change found only the component file and
 * BuildWorkflow.tsx (its one caller), never a test. D-scope sweep,
 * self-discovered (A, B and C are all done or BLOCKED; docs/overnight-backlog.md
 * itself is gone from this checkout — see 48c1eaa's note on recovering
 * section D's scope from git history). Continuing the SELF-<n> numbering
 * from SELF-143.
 *
 * The auto-scroll effect (`el.scrollTop = el.scrollHeight` on `items`
 * change) needs a live DOM this repo has no jsdom/RTL harness for — the
 * same gap TabBar.test.tsx and useUrlView.test.ts note — so it is left
 * uncovered. Everything else is render-time and `renderToStaticMarkup`
 * pins it: the `TONE` record's five keys are exactly `FeedItem["tone"]`'s
 * union (a typo in either would either fail to compile or render
 * `undefined` as a class, so this locks the mapping shape, not just one
 * key), and the three-way footer gate — pulsing cursor while `running`,
 * "waiting…" only once `items.length === 0 && !running`, neither once
 * items exist and the run has stopped — which is the one piece of actual
 * branching logic in the file.
 */

function item(id: number, tone: FeedItem["tone"], text = `item ${id}`): FeedItem {
  return { id, tone, text };
}

describe("EventFeed: TONE maps every FeedItem tone to its own class", () => {
  const cases: Array<[FeedItem["tone"], string]> = [
    ["muted", "text-slate-500"],
    ["accent", "text-sky-300"],
    ["green", "text-emerald-300"],
    ["amber", "text-amber-300"],
    ["red", "text-rose-300"],
  ];

  it.each(cases)("renders a %s item with its %s class", (tone, cls) => {
    const html = renderToStaticMarkup(<EventFeed items={[item(1, tone)]} running={false} />);
    expect(html).toContain(cls);
    expect(html).toContain("item 1");
  });
});

describe("EventFeed: item count badge", () => {
  it("shows the item count", () => {
    const html = renderToStaticMarkup(
      <EventFeed items={[item(1, "muted"), item(2, "accent")]} running={false} />,
    );
    expect(html).toContain(">2<");
  });

  it("shows 0 for an empty list", () => {
    const html = renderToStaticMarkup(<EventFeed items={[]} running={false} />);
    expect(html).toContain(">0<");
  });
});

describe("EventFeed: the running-cursor / waiting-placeholder gate", () => {
  it("shows the pulsing cursor while running, with items present", () => {
    const html = renderToStaticMarkup(<EventFeed items={[item(1, "muted")]} running={true} />);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("waiting…");
  });

  it("shows the pulsing cursor while running, even with no items yet", () => {
    const html = renderToStaticMarkup(<EventFeed items={[]} running={true} />);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("waiting…");
  });

  it("shows the waiting placeholder only once idle with no items", () => {
    const html = renderToStaticMarkup(<EventFeed items={[]} running={false} />);
    expect(html).toContain("waiting…");
    expect(html).not.toContain("animate-pulse");
  });

  it("shows neither cursor nor placeholder once stopped with items present", () => {
    const html = renderToStaticMarkup(<EventFeed items={[item(1, "muted")]} running={false} />);
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("waiting…");
  });
});
