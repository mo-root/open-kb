import { describe, expect, it } from "vitest"
import { COMPANY_TYPES, groupLabel, nodeTypeOf } from "./nodeTypes"

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
