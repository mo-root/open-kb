import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { COMPANY_TYPES, groupLabel, nodeTypeOf, TYPE_COLOR } from "./nodeTypes"

/**
 * `nodeTypeOf` and `groupLabel` had zero direct test coverage anywhere,
 * despite deciding the type on every node the graph canvas renders
 * (GraphCanvas's visible-type filter, degree scoring and legend counts all
 * call `nodeTypeOf(n.group)`) and the label NotesTab and the graph card show
 * for it. Coverage gap found sweeping web/lib (D-scope: "areas nobody has
 * swept").
 */
describe("nodeTypeOf: the top-level group names the type", () => {
  it("reads the type off the first path segment", () => {
    expect(nodeTypeOf("products/acme")).toBe("product")
    expect(nodeTypeOf("players/rival-co")).toBe("player")
    expect(nodeTypeOf("communities/reddit")).toBe("community")
  })

  it("takes the segment before the first slash, not the whole path", () => {
    // A real node id is a path — `products/acme/notes/x` — and the type is
    // decided by its group, not by anything past it.
    expect(nodeTypeOf("products/acme/deep/nested")).toBe("product")
  })

  it("is core for the overview group and for anything unrecognised", () => {
    // `overview` is the anchor's own group; an unknown-kind host also folds
    // here (see COMPANY_TYPES's comment: 476 of stripe.com's 2,522 entities
    // are nameless `unknown` rows that must still render as the central hub
    // colour rather than as an untyped node with no legend entry).
    expect(nodeTypeOf("overview")).toBe("core")
    expect(nodeTypeOf("unplaced")).toBe("core")
    expect(nodeTypeOf("")).toBe("core")
  })
})

describe("groupLabel: the reader-facing spelling of a group", () => {
  it("relabels overview as core", () => {
    expect(groupLabel("overview")).toBe("core")
  })

  it("passes every other group through unchanged", () => {
    expect(groupLabel("products")).toBe("products")
    expect(groupLabel("players")).toBe("players")
    expect(groupLabel("communities")).toBe("communities")
  })
})

describe("COMPANY_TYPES: which node types are a company on the map", () => {
  it("is exactly product and player — core and community are deliberately out", () => {
    expect(COMPANY_TYPES).toEqual(["product", "player"])
  })
})

/**
 * TYPE_COLOR vs globals.css: two hand-copied hex tables, never pinned to each
 * other. nodeTypes.ts's own doc comment states the invariant twice — "the
 * hexes must stay identical to app/globals.css's --type-* tokens" for
 * product/player/core (fixed across both themes), and community "kept in
 * sync with --type-community's DARK step" — but nothing checked either
 * claim. Same shape as SELF-105..109's drifted enums: a real coupling, stated
 * only in a comment, with no test standing behind it. Read out of the actual
 * stylesheet rather than restated, so a future edit to one side only fails
 * here instead of drifting silently — theme.test.ts's layout.tsx extraction
 * is the precedent for reading a real source file this way.
 */
const GLOBALS_CSS = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
)

/** First `--type-<name>` hex at or after `fromIndex`, lower-cased. */
function typeHex(name: string, fromIndex = 0): string {
  const re = /--type-([a-z]+):\s*(#[0-9a-fA-F]{6})/g
  re.lastIndex = fromIndex
  let m: RegExpExecArray | null
  while ((m = re.exec(GLOBALS_CSS))) {
    if (m[1] === name) return m[2].toLowerCase()
  }
  throw new Error(`no --type-${name} found in globals.css from index ${fromIndex}`)
}

describe("TYPE_COLOR: pinned to globals.css's --type-* tokens", () => {
  it("product, player and core match the light block, fixed across both themes", () => {
    expect(TYPE_COLOR.product.toLowerCase()).toBe(typeHex("product"))
    expect(TYPE_COLOR.player.toLowerCase()).toBe(typeHex("player"))
    expect(TYPE_COLOR.core.toLowerCase()).toBe(typeHex("core"))
  })

  it("community matches the DARK step, not the light paper step — the one --type-* that steps per theme", () => {
    // The bare string ':root[data-theme="dark"]' also appears in this file's
    // opening doc comment (prose explaining the theme toggle), well before the
    // real selector — anchoring on that alone would find the comment, not the
    // dark block, and silently compare the light value against itself.
    const darkBlockAt = GLOBALS_CSS.search(/:root\[data-theme="dark"\]\s*\{/)
    expect(darkBlockAt).toBeGreaterThan(-1)
    const lightCommunity = typeHex("community")
    const darkCommunity = typeHex("community", darkBlockAt)
    expect(lightCommunity).not.toBe(darkCommunity) // sanity: the steps really differ
    expect(TYPE_COLOR.community.toLowerCase()).toBe(darkCommunity)
  })
})
