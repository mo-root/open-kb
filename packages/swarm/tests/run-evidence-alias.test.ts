import { describe, it, expect } from "vitest"
import { RunEvidence, recallProbePool } from "../src/index.js"

/**
 * The recall probe pool learns the anchor's structural aliases from the pages
 * this run already stored — nothing is fetched to grade a map. An anchor
 * whose ccTLD property reciprocates (mutual hreflang) must see that property
 * excluded from the pool exactly as the anchor's own pages are, and the alias
 * set must ride out of the pool function so answerKeyRecall can subtract the
 * same hosts from every probe's vendor list.
 */

const pad =
  "This body only needs to exist as stored bytes; the pool does not sniff. ".repeat(3)

const ANCHOR_HTML =
  `<html><head><link rel="alternate" hreflang="es" href="https://anchor.es/"></head>` +
  `<body>${pad}</body></html>`
const ES_HTML =
  `<html><head><link rel="alternate" hreflang="en" href="https://anchor.com/"></head>` +
  `<body>${pad}</body></html>`
const ROUNDUP_HTML = `<html><body>anchor.com compared. ${pad}</body></html>`

const store = () => {
  const ev = new RunEvidence()
  ev.record({ url: "https://anchor.com/", text: pad, raw: ANCHOR_HTML, status: "found", tier: "page" })
  ev.record({ url: "https://anchor.es/", text: pad, raw: ES_HTML, status: "found", tier: "page" })
  ev.record({ url: "https://roundup.example/best", text: pad, raw: ROUNDUP_HTML, status: "found", tier: "page" })
  return ev
}

describe("recallProbePool with structural aliases", () => {
  it("computes the anchor's alias set from stored pages and excludes those hosts from the pool", () => {
    const pool = recallProbePool(store(), "anchor.com")
    expect([...pool.anchorAliases].sort()).toEqual(["anchor.com", "anchor.es"])
    expect(pool.pages.map((p) => p.url)).toEqual(["https://roundup.example/best"])
  })
  it("a one-sided assertion changes nothing — the pool still only excludes the anchor itself", () => {
    const ev = new RunEvidence()
    ev.record({ url: "https://anchor.com/", text: pad, raw: ANCHOR_HTML, status: "found", tier: "page" })
    // anchor.es was never fetched: reciprocity is unprovable, so no alias.
    ev.record({ url: "https://roundup.example/best", text: pad, raw: ROUNDUP_HTML, status: "found", tier: "page" })
    const pool = recallProbePool(ev, "anchor.com")
    expect([...pool.anchorAliases]).toEqual(["anchor.com"])
    expect(pool.pages.map((p) => p.url)).toEqual(["https://roundup.example/best"])
  })

  // record()'s canonicalUrl() call falls back to the raw string on a parse
  // failure (url.ts:12), so nothing stops a page from entering the store under
  // a URL that will not parse. recallProbePool's own `new URL(p.url)` call
  // (run-evidence.ts:498) is the only place this run re-parses it, and until
  // now nothing ever fed it a string that fails there — every other test file
  // and aliasSets' own try/catch (alias.ts:163-167) sidestep it by skipping
  // (not excluding) an unparseable page. Excluding is the safer of the two
  // readings a filter can give a thing it cannot evaluate, so it is pinned.
  it("excludes a page whose URL will not parse, rather than throwing", () => {
    const ev = new RunEvidence()
    ev.record({ url: "https://anchor.com/", text: pad, raw: ANCHOR_HTML, status: "found", tier: "page" })
    ev.record({ url: "not a url", text: pad, raw: "<html><body>junk</body></html>", status: "found", tier: "page" })
    expect(ev.pages().map((p) => p.url)).toContain("not a url")
    expect(() => recallProbePool(ev, "anchor.com")).not.toThrow()
    const pool = recallProbePool(ev, "anchor.com")
    expect(pool.pages.map((p) => p.url)).toEqual([])
  })
})
