import { describe, it, expect } from "vitest";
import { pickDefaultNote, resolveTab, resolveNote } from "./KbBrowser";

describe("pickDefaultNote", () => {
  it("picks company.md when present, wherever it sits in the list", () => {
    const notes = [{ path: "players/apify.com.md" }, { path: "company.md" }, { path: "players/zapier.com.md" }];
    expect(pickDefaultNote(notes)).toBe("company.md");
  });

  it("falls back to the first note when no note is named company.md", () => {
    const notes = [{ path: "players/apify.com.md" }, { path: "players/zapier.com.md" }];
    expect(pickDefaultNote(notes)).toBe("players/apify.com.md");
  });

  it("answers null for an empty note list rather than throwing", () => {
    expect(pickDefaultNote([])).toBeNull();
  });
});

describe("resolveTab", () => {
  const ids = new Set(["overview", "notes", "products", "graph"]);

  it("passes a known tab through unchanged", () => {
    expect(resolveTab("products", ids)).toBe("products");
  });

  it("falls back to overview for an id the bar does not have", () => {
    // A hand-typed ?tab=signals (an upstream tab this engine never shipped) is
    // exactly the untrusted input the component's own comment names.
    expect(resolveTab("signals", ids)).toBe("overview");
  });

  it("falls back to overview for the empty string", () => {
    expect(resolveTab("", ids)).toBe("overview");
  });
});

describe("resolveNote", () => {
  const notes = [{ path: "company.md" }, { path: "players/apify.com.md" }];

  it("passes a note this map actually wrote through unchanged", () => {
    expect(resolveNote("players/apify.com.md", notes, "company.md")).toBe("players/apify.com.md");
  });

  it("falls back to the given default for a path this map never wrote", () => {
    // A stale share link, a typo, or a note the run dropped since the link
    // went out — all the same case from resolveNote's side.
    expect(resolveNote("players/gone.com.md", notes, "company.md")).toBe("company.md");
  });

  it("falls back to the given default for a null request", () => {
    expect(resolveNote(null, notes, "company.md")).toBe("company.md");
  });

  it("falls back to the given default for the empty string", () => {
    expect(resolveNote("", notes, "company.md")).toBe("company.md");
  });

  it("passes null through when the default is itself null and nothing matches", () => {
    expect(resolveNote("players/gone.com.md", notes, null)).toBeNull();
  });
});
