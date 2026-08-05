import { describe, it, expect } from "vitest"
import { answerKeyRecall } from "../src/coverage.js"

const page = (vendors: string[], namesAnchor = true) => ({
  url: "https://listicle.com/best",
  html:
    (namesAnchor ? "The top pick is anchor.com. " : "") +
    vendors.map((v) => `<a href="https://${v}/x">${v}</a>`).join(" "),
})

describe("answerKeyRecall", () => {
  it("scores map coverage against a probe page's vendor list", () => {
    const r = answerKeyRecall([page(["a.com", "b.com", "c.com", "d.com", "e.com"])], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com", "b.com", "c.com"]),
      minVendors: 5,
    })
    expect(r.probes).toHaveLength(1)
    expect(r.probes[0]!.recall).toBeCloseTo(0.6)
    expect(r.pooled).toBeCloseTo(0.6)
  })
  it("ignores pages that do not name the anchor", () => {
    const r = answerKeyRecall([page(["a.com", "b.com", "c.com", "d.com", "e.com"], false)], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com"]),
    })
    expect(r.probes).toHaveLength(0)
    expect(r.pooled).toBeNull()
  })
  it("ignores pages listing fewer than minVendors", () => {
    const r = answerKeyRecall([page(["a.com", "b.com"])], {
      anchor: "anchor.com",
      mapHosts: new Set(["a.com"]),
      minVendors: 5,
    })
    expect(r.probes).toHaveLength(0)
  })
  it("excludes the anchor and the probe's own host from the key", () => {
    const r = answerKeyRecall(
      [{ url: "https://listicle.com/best", html: `anchor.com <a href="https://anchor.com/"><a href="https://listicle.com/other"><a href="https://a.com/"><a href="https://b.com/"><a href="https://c.com/"><a href="https://d.com/"><a href="https://e.com/">` }],
      { anchor: "anchor.com", mapHosts: new Set(["a.com"]), minVendors: 5 },
    )
    expect(r.probes[0]!.vendors).not.toContain("anchor.com")
    expect(r.probes[0]!.vendors).not.toContain("listicle.com")
  })
})
