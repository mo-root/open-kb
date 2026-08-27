import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Chip,
  KindChip,
  MicroHead,
  RelevanceBadge,
  SectionHead,
  TierBadge,
  TypeChip,
  relevanceTone,
} from "./ui";

/**
 * ui.tsx had zero test coverage anywhere, despite being imported by
 * ProductsTab.tsx, NoteView.tsx, PlanCard.tsx and FindingsPanel.tsx. D-scope
 * sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see
 * 48c1eaa's note on recovering section D's scope from git history).
 *
 * Every export here is a lookup-with-fallback (kind/tier -> tone class,
 * score -> tone tier) or a dead/live branch (TypeChip), so this pins the
 * fallback and boundary behaviour rather than just the happy-path render
 * shape — the same split GraphLegend.test.tsx and Donut.test.tsx use for a
 * file with no jsdom/RTL harness available.
 */

describe("relevanceTone's two thresholds are >=85 and >=60, not >85/>60", () => {
  it("uses the high tier at exactly 85 and the mid tier at exactly 60", () => {
    expect(relevanceTone(85)).toBe("text-sky-300 border-sky-500/40 bg-sky-500/15");
    expect(relevanceTone(84.9)).toBe("text-sky-300 border-sky-500/25 bg-sky-500/10");
    expect(relevanceTone(60)).toBe("text-sky-300 border-sky-500/25 bg-sky-500/10");
    expect(relevanceTone(59.9)).toBe("text-slate-400 border-slate-600/40 bg-slate-700/20");
  });
});

describe("RelevanceBadge rounds the displayed number but tones off the raw value", () => {
  it("shows the rounded score and a title that states this is a placement, not a measured relevance", () => {
    const html = renderToStaticMarkup(<RelevanceBadge value={84.6} />);
    expect(html).toContain(">85<");
    expect(html).toContain("placement 85");
    expect(html).toContain("not a measured relevance");
    // 84.6 rounds display-side to 85 but is still under the 85 tone threshold.
    expect(html).toContain("bg-sky-500/10");
    expect(html).not.toContain("bg-sky-500/15");
  });
});

describe("KindChip falls back to the neutral tone for a kind the palette never taught", () => {
  it("matches a known kind case- and whitespace-insensitively", () => {
    const html = renderToStaticMarkup(<KindChip kind=" Product " />);
    expect(html).toContain("text-sky-300");
    expect(html).toContain("Product");
  });

  it("uses the shared neutral fallback for an unrecognised kind", () => {
    const html = renderToStaticMarkup(<KindChip kind="mystery" />);
    expect(html).toContain("text-slate-300 border-slate-600/50 bg-slate-700/30");
  });
});

describe("TierBadge falls back to the neutral tone for a tier the ladder never heard of", () => {
  it("matches a known tier case-insensitively and carries the title through", () => {
    const html = renderToStaticMarkup(<TierBadge tier="OWN-PAGE" title="best evidence" />);
    expect(html).toContain("text-sky-300 border-sky-400/60 bg-sky-500/15");
    expect(html).toContain('title="best evidence"');
  });

  it("does not drop a tier the map asserted but the ladder does not name", () => {
    const html = renderToStaticMarkup(<TierBadge tier="inferred" />);
    expect(html).toContain("text-slate-300 border-slate-600/50 bg-slate-700/30");
    expect(html).toContain("inferred");
  });
});

describe("Chip renders the requested tone, defaulting to slate", () => {
  it("picks the rose classes when asked", () => {
    const html = renderToStaticMarkup(<Chip tone="rose">alert</Chip>);
    expect(html).toContain("text-rose-300 border-rose-500/30 bg-rose-500/10");
  });

  it("defaults to slate when no tone is given", () => {
    const html = renderToStaticMarkup(<Chip>plain</Chip>);
    expect(html).toContain("text-slate-300 border-slate-700 bg-slate-800/50");
  });
});

describe("SectionHead and MicroHead omit the count span entirely rather than rendering an empty one", () => {
  it("SectionHead shows a count of 0 (it is a real count) but hides an undefined one", () => {
    const withZero = renderToStaticMarkup(<SectionHead title="Products" count={0} />);
    expect(withZero).toContain(">0<");
    const withNone = renderToStaticMarkup(<SectionHead title="Products" />);
    expect(withNone).not.toContain('class="tnum');
  });

  it("MicroHead follows the same rule", () => {
    const withCount = renderToStaticMarkup(<MicroHead title="reddit.com" count={4} />);
    expect(withCount).toContain(">4<");
    const withNone = renderToStaticMarkup(<MicroHead title="reddit.com" />);
    expect(withNone).not.toContain('class="tnum ml-2');
  });
});

describe("TypeChip renders a non-interactive span for a dead target even when given an onClick", () => {
  it("ignores onClick and drops the type colour once dead is true", () => {
    const html = renderToStaticMarkup(
      <TypeChip type="product" label="Acme" dead onClick={() => {}} />,
    );
    expect(html).toContain("<span");
    expect(html).not.toContain("<button");
    expect(html).toContain('title="unresolved link"');
  });

  it("renders a live button coloured by the type, with no dead fallback title", () => {
    const html = renderToStaticMarkup(
      <TypeChip type="product" label="Acme" onClick={() => {}} />,
    );
    expect(html).toContain("<button");
    expect(html).not.toContain('title="unresolved link"');
  });

  it("falls back to a plain span when no onClick is given, even without dead", () => {
    const html = renderToStaticMarkup(<TypeChip type="product" label="Acme" />);
    expect(html).toContain("<span");
    expect(html).not.toContain("<button");
  });
});
