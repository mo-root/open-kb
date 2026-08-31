import { describe, it, expect } from "vitest"
import { outboundHosts, admit } from "../src/verdict.js"

const CTX = { anchor: "anchor.com", aggregatorThreshold: 12 }

function aggregatorHtml(n: number): string {
  return Array.from({ length: n }, (_, i) => `<a href="https://vendor${i}.com/x">v${i}</a>`).join("\n")
}

describe("outboundHosts", () => {
  it("counts distinct external registrable hosts", () => {
    const html = `<a href="https://a.com/1"><a href="https://docs.a.com/2"><a href="https://b.io/">
      <a href="/relative"><a href="https://self.com/page">`
    expect(outboundHosts(html, "https://self.com/").sort()).toEqual(["a.com", "b.io"])
  })
  it("ignores same-host and relative links", () => {
    expect(outboundHosts(`<a href="/pricing"><a href="https://self.com/docs">`, "https://self.com/")).toEqual([])
  })
  it("does not throw on an unparseable page URL", () => {
    expect(outboundHosts(`<a href="https://a.com/">`, "not a url")).toEqual(["a.com"])
  })
  it("counts protocol-relative links", () => {
    expect(outboundHosts(`<a href="//b.com/x">`, "https://self.com/")).toEqual(["b.com"])
  })
  it("stops the host at a query string when no path precedes it", () => {
    // The shipped bug: bestscrapingtools.com links vendors as
    // https://scrapingdog.com?ref=bestscrapingtools.com — no slash before the
    // `?`. The capture must yield the real host, not "com?ref=…" junk.
    const html = `<a href="https://scrapingdog.com?ref=bestscrapingtools.com">Scrapingdog</a>`
    expect(outboundHosts(html, "https://bestscrapingtools.com/")).toEqual(["scrapingdog.com"])
  })
  it("stops the host at a fragment when no path precedes it", () => {
    expect(outboundHosts(`<a href="https://a.com#pricing">`, "https://self.com/")).toEqual(["a.com"])
  })
})

describe("admit", () => {
  it("passes a vendor claim backed by its own readable page", () => {
    const page = { url: "https://vendor.com/", readable: true, outboundHosts: ["cdn.com"] }
    expect(admit({ host: "vendor.com", kind: "company", relation: "competitor" }, page, CTX)).toEqual({ ok: true })
  })
  it("refuses competitor/substitute with no readable own page", () => {
    const out = admit({ host: "vendor.com", kind: "company", relation: "substitute" }, null, CTX)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.relation).toBe("unknown")
      expect(out.because).toContain("its own site")
    }
  })
  it("downgrades an aggregator-shaped page to directory/lists", () => {
    const page = {
      url: "https://lists.com/",
      readable: true,
      outboundHosts: Array.from({ length: 23 }, (_, i) => `vendor${i}.com`),
    }
    const out = admit({ host: "lists.com", kind: "company", relation: "competitor" }, page, CTX)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.kind).toBe("directory")
      expect(out.relation).toBe("lists")
      expect(out.because).toContain("23")
    }
  })
  it("the aggregator threshold is >=, not >: the boundary count trips it and one below does not", () => {
    // Every other fixture in this file is 23 against a threshold of 12 — far
    // enough above that a regression from `>=` to `>` would never fail it.
    // This is the actual line `admit` draws.
    const page = (n: number) => ({
      url: "https://x.com/",
      readable: true,
      outboundHosts: Array.from({ length: n }, (_, i) => `vendor${i}.com`),
    })
    const claim = { host: "x.com", kind: "company", relation: "competitor" }
    expect(admit(claim, page(CTX.aggregatorThreshold), CTX).ok).toBe(false)
    expect(admit(claim, page(CTX.aggregatorThreshold - 1), CTX).ok).toBe(true)
  })
  it("does not fire the aggregator rule on non-company kinds", () => {
    const page = { url: "https://forum.com/", readable: true, outboundHosts: Array.from({ length: 30 }, (_, i) => `v${i}.com`) }
    expect(admit({ host: "forum.com", kind: "community", relation: "discusses" }, page, CTX)).toEqual({ ok: true })
  })
  it("channel relations do not need an own page", () => {
    expect(admit({ host: "blog.com", kind: "publisher", relation: "covers" }, null, CTX)).toEqual({ ok: true })
  })
})
