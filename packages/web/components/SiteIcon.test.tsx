import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteIcon, normalizeDomain } from "./SiteIcon";

/**
 * ZERO TEST COVERAGE ANYWHERE, found sweeping `packages/web/components` for
 * files with no matching `.test.tsx` (D-scope: "areas nobody has swept").
 * `normalizeDomain` is not a private helper of this one component — it is
 * imported directly by `kb/KbBrowser.tsx` to normalize a manifest's root
 * domain for anchor-matching, so a regression here is not confined to a
 * favicon chip. `monogram` stays unexported and is only reachable through the
 * fallback branch's rendered markup, which is what the third describe below
 * exercises. Same `renderToStaticMarkup` shape `viz/StatTile.test.tsx` uses:
 * no jsdom/RTL harness exists in this repo (confirmed on B1-B4, still true),
 * and `onError`'s `setErrored` transition needs a live DOM to trigger, so
 * this covers every render-time path and none of the client-side retry.
 */
describe("normalizeDomain strips scheme, www. and path down to a bare host", () => {
  it("passes an already-bare domain through unchanged", () => {
    expect(normalizeDomain("firecrawl.dev")).toBe("firecrawl.dev");
  });

  it("returns empty for undefined, null and the empty string", () => {
    expect(normalizeDomain(undefined)).toBe("");
    expect(normalizeDomain(null)).toBe("");
    expect(normalizeDomain("")).toBe("");
  });

  it("strips a scheme, any scheme, not just http/https", () => {
    expect(normalizeDomain("https://firecrawl.dev")).toBe("firecrawl.dev");
    expect(normalizeDomain("ftp://firecrawl.dev")).toBe("firecrawl.dev");
  });

  it("strips a leading www., but only the leading one", () => {
    expect(normalizeDomain("www.firecrawl.dev")).toBe("firecrawl.dev");
    expect(normalizeDomain("www.www.firecrawl.dev")).toBe("www.firecrawl.dev");
  });

  it("drops path, query and hash", () => {
    expect(normalizeDomain("firecrawl.dev/pricing")).toBe("firecrawl.dev");
    expect(normalizeDomain("firecrawl.dev?ref=x")).toBe("firecrawl.dev");
    expect(normalizeDomain("firecrawl.dev#top")).toBe("firecrawl.dev");
  });

  it("lowercases and trims surrounding whitespace", () => {
    expect(normalizeDomain("  Firecrawl.DEV  ")).toBe("firecrawl.dev");
  });

  it("composes scheme, www. and path together, in the shape a manifest actually stores", () => {
    expect(normalizeDomain("https://www.firecrawl.dev/blog/launch")).toBe(
      "firecrawl.dev",
    );
  });
});

describe("SiteIcon renders the favicon proxy for a real domain", () => {
  it("points <img> at the DuckDuckGo icon proxy for the normalized host", () => {
    const html = renderToStaticMarkup(
      <SiteIcon domain="https://www.firecrawl.dev/" name="Firecrawl" />,
    );
    expect(html).toContain(
      '<img src="https://icons.duckduckgo.com/ip3/firecrawl.dev.ico"',
    );
  });

  it("uses the name for alt text when a name is given", () => {
    const html = renderToStaticMarkup(
      <SiteIcon domain="firecrawl.dev" name="Firecrawl" />,
    );
    expect(html).toContain('alt="Firecrawl favicon"');
  });

  it("falls back to the bare host for alt text when no name is given", () => {
    const html = renderToStaticMarkup(<SiteIcon domain="firecrawl.dev" />);
    expect(html).toContain('alt="firecrawl.dev favicon"');
  });

  it("sizes the box from the size prop, default 16", () => {
    const html = renderToStaticMarkup(<SiteIcon domain="firecrawl.dev" />);
    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
  });
});

describe("SiteIcon falls back to a monogram or the player glyph without a domain", () => {
  it("renders the first alphanumeric of the name, uppercased, on an empty domain", () => {
    const html = renderToStaticMarkup(<SiteIcon domain="" name="firecrawl" />);
    expect(html).not.toContain("<img");
    expect(html).toContain(">F<");
  });

  it("skips a leading non-alphanumeric to find the monogram", () => {
    const html = renderToStaticMarkup(<SiteIcon domain={null} name=" Acme" />);
    expect(html).toContain(">A<");
  });

  it("renders the player NodeGlyph, not a blank box, when there is no name either", () => {
    const html = renderToStaticMarkup(<SiteIcon domain={undefined} />);
    expect(html).not.toContain("<img");
    // No monogram span (there is no name to draw one from) and the player
    // glyph's own diamond outline in its place.
    expect(html).not.toContain("font-mono");
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('d="M12 3.2 20.8 12 12 20.8 3.2 12 Z"');
  });

  it("also falls back for a domain that normalizes to empty, e.g. a bare scheme", () => {
    const html = renderToStaticMarkup(<SiteIcon domain="https://" name="Acme" />);
    expect(html).not.toContain("<img");
    expect(html).toContain(">A<");
  });
});
