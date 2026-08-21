import { describe, it, expect } from "vitest"
import { nodeKey } from "../src/index.js"

/**
 * nodeKey is the one place a node's identity is minted (map.ts). No dedicated
 * coverage existed before this — every prior test reaches it only through
 * rememberTool with a bare-hostname domain, so the scheme-strip branch itself
 * was never exercised.
 */
describe("nodeKey", () => {
  it("strips a lowercase scheme before keying", () => {
    expect(nodeKey("company", "Example", "https://example.com")).toBe("example.com")
  })

  it("strips an uppercase or mixed-case scheme the same way — a model echoing a URL it just read keeps its capitals", () => {
    expect(nodeKey("company", "Example", "HTTPS://example.com")).toBe("example.com")
    expect(nodeKey("company", "Example", "Http://Example.com")).toBe("example.com")
  })

  it("a bare hostname needs no stripping at all", () => {
    expect(nodeKey("company", "Example", "example.com")).toBe("example.com")
  })
})
