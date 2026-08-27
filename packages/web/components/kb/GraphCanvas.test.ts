import { describe, expect, it } from "vitest"
import {
  escapeHtml,
  hashStr,
  hexToRgba,
  mixHex,
  mulberry32,
  parseHex,
  truncate,
} from "./GraphCanvas"

/**
 * D-scope sweep, self-discovered (A, B and C are all done or BLOCKED;
 * docs/overnight-backlog.md itself is gone from this checkout — see 48c1eaa's
 * note on recovering section D's scope from git history). Continuing the
 * existing SELF-<n> numbering: git log a7bbc57..HEAD names SELF-101 as the
 * last used, so this is SELF-102.
 *
 * GraphCanvas.tsx (2,400+ lines) is the single largest untested file in
 * packages/web — grepped every component for a colocated test (as SELF-96's
 * StageTracker commit did) and it had none, unlike its five siblings under
 * components/kb/ that already do. Seven small pure functions carry real,
 * independently-checkable logic and were all module-private, so this adds
 * `export` to each (no other change) purely so this file can import them —
 * same enabling move as SELF-99's meanRelevance, just for a helper that
 * needed the keyword added rather than one that already had it.
 *
 * escapeHtml is the one worth the most: `nodeLabel`/`linkLabel` (lines
 * ~1492-1519) build the hover-tooltip HTML that react-force-graph-2d injects
 * via innerHTML, and every interpolated field — entity title, kind, relation,
 * the edge's blurb/mechanism sentence — is scraped-web or model-classified
 * text, not something this app authored. An unescaped `<` or `&` in a vendor's
 * self-description would inject markup into every reader's tooltip. Confirmed
 * by reading the call sites: every use sits in HTML TEXT-CONTENT position
 * (inside a `<div ...>text</div>`, never inside an attribute value), which is
 * why the function does not escape `'` — the one character that only matters
 * inside a single-quoted attribute, which nothing here uses.
 *
 * hashStr + mulberry32 (line ~862) are the layout's determinism: same KB slug
 * and reset count must reseed to the same starting positions, or a reset
 * would silently become a fresh random layout instead of a repeatable one.
 * mixHex/parseHex/hexToRgba are the theme-aware colour blending used to
 * recede unfocused nodes/links into the paper/navy background without the
 * transparency bug `globalAlpha` would cause (documented at mixHex's own
 * doc comment). truncate is the node-label ellipsis, off by one at the
 * boundary (`s.slice(0, n - 1)}…` costs one character for the ellipsis
 * itself).
 *
 * `pnpm check && pnpm test` both green (see commit message for the count).
 *
 * Backlog item: SELF-102
 */

describe("hashStr: the layout's own seed, not a general hash", () => {
  it("is deterministic for the same input", () => {
    expect(hashStr("cursor.com")).toBe(hashStr("cursor.com"))
  })

  it("distinguishes inputs that differ, including by length alone", () => {
    expect(hashStr("cursor.com")).not.toBe(hashStr("cursor.co"))
    expect(hashStr("a")).not.toBe(hashStr("b"))
  })

  it("returns an unsigned 32-bit integer even for a long input", () => {
    const h = hashStr("x".repeat(500))
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffffffff)
  })

  it("hashes the empty string to the FNV offset basis, not zero or NaN", () => {
    expect(hashStr("")).toBe(2166136261)
  })
})

describe("mulberry32: a seeded PRNG, so a reset replays the same layout", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect(a()).toBe(b())
    expect(a()).toBe(b())
  })

  it("diverges for different seeds", () => {
    const a = mulberry32(1)()
    const b = mulberry32(2)()
    expect(a).not.toBe(b)
  })

  it("stays in [0, 1) across repeated draws", () => {
    const rng = mulberry32(hashStr("grundfos.com"))
    for (let i = 0; i < 50; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe("parseHex: the only entry point mixHex and callers trust", () => {
  it("parses 6-digit hex, with or without the #", () => {
    expect(parseHex("#ff0000")).toEqual([255, 0, 0])
    expect(parseHex("00ff00")).toEqual([0, 255, 0])
  })

  it("expands 3-digit shorthand the same way CSS does", () => {
    expect(parseHex("#0f0")).toEqual([0, 255, 0])
  })

  it("is case-insensitive", () => {
    expect(parseHex("#ABCDEF")).toEqual(parseHex("#abcdef"))
  })

  it("tolerates surrounding whitespace", () => {
    expect(parseHex("  #ff0000  ")).toEqual([255, 0, 0])
  })

  it("returns null for anything that is not 3 or 6 hex digits", () => {
    expect(parseHex("not-a-color")).toBeNull()
    expect(parseHex("#ff00")).toBeNull()
    expect(parseHex("")).toBeNull()
  })
})

describe("mixHex: blend toward a colour without globalAlpha's erase/bleach bug", () => {
  it("returns the source colour unchanged at t=0", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("rgb(0,0,0)")
  })

  it("returns the target colour at t=1", () => {
    expect(mixHex("#000000", "#ffffff", 1)).toBe("rgb(255,255,255)")
  })

  it("rounds to a midpoint at t=0.5", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("rgb(128,128,128)")
  })

  it("clamps t outside [0, 1] rather than overshooting the colour range", () => {
    expect(mixHex("#000000", "#ffffff", 2)).toBe("rgb(255,255,255)")
    expect(mixHex("#000000", "#ffffff", -1)).toBe("rgb(0,0,0)")
  })

  it("falls back to the untouched hex when either side fails to parse", () => {
    expect(mixHex("not-a-color", "#ffffff", 0.5)).toBe("not-a-color")
    expect(mixHex("#000000", "not-a-color", 0.5)).toBe("#000000")
  })
})

describe("hexToRgba: the canvas paint colour, alpha appended", () => {
  it("converts a 6-digit hex to its rgba() equivalent", () => {
    expect(hexToRgba("#ff8800", 0.5)).toBe("rgba(255,136,0,0.5)")
  })

  it("passes the alpha through verbatim, including 0 and 1", () => {
    expect(hexToRgba("#000000", 0)).toBe("rgba(0,0,0,0)")
    expect(hexToRgba("#000000", 1)).toBe("rgba(0,0,0,1)")
  })

  it("returns the input unchanged for anything that is not 6 hex digits", () => {
    // Unlike parseHex, this one does NOT expand 3-digit shorthand — it is fed
    // theme palette constants only, all already 6 digits, and a silent
    // fallback to the raw string is safer here than a second parse path.
    expect(hexToRgba("#0f0", 0.5)).toBe("#0f0")
    expect(hexToRgba("not-a-color", 0.5)).toBe("not-a-color")
  })
})

describe("truncate: the node-label ellipsis", () => {
  it("leaves a string at or under the limit untouched", () => {
    expect(truncate("cursor.com", 10)).toBe("cursor.com")
    expect(truncate("short", 10)).toBe("short")
  })

  it("cuts one character short of the limit to make room for the ellipsis", () => {
    // n=5 on a 6-char string: 4 kept characters + the ellipsis glyph = 5 wide.
    expect(truncate("abcdef", 5)).toBe("abcd…")
  })

  it("never returns a string longer than n", () => {
    expect(truncate("a very long entity title indeed", 10).length).toBe(10)
  })
})

describe("escapeHtml: the tooltip's only defense against scraped/model text", () => {
  it("escapes every HTML metacharacter it targets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
    expect(escapeHtml("Q&A")).toBe("Q&amp;A")
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;")
  })

  it("escapes & before the entities it introduces, so escaping is not re-escaped", () => {
    // A naive re-ordering (quotes first, then &) would turn `"` into `&quot;`
    // and then mangle that same `&` on a second pass; this locks the order.
    expect(escapeHtml("<>&\"")).toBe("&lt;&gt;&amp;&quot;")
  })

  it("leaves a single quote untouched, matching where it is actually used", () => {
    // Every call site interpolates into HTML text content ("<div>text</div>"),
    // never into a single-quoted attribute, so this is not a gap — see the
    // file header comment on this test for the call sites checked.
    expect(escapeHtml("vendor's own name")).toBe("vendor's own name")
  })

  it("passes ordinary text through unchanged", () => {
    expect(escapeHtml("Cursor is a code editor")).toBe("Cursor is a code editor")
  })
})
