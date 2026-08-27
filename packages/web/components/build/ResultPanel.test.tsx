import { describe, expect, it } from "vitest";
import { JUDGED_KINDS } from "@open-kb/core";
import { KIND_COLOR } from "./ResultPanel";

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
