import { describe, it, expect } from "vitest"
import { judgeHosts, type HostCandidate } from "../src/rank.js"
import type { FetchPort } from "@open-kb/core"

const cand = (host: string): HostCandidate => ({ host, seenIn: 2, intents: ["evaluation"], titles: ["t"], desc: "d" })

// Padded past core's THIN_TEXT floor (200 extracted chars — see
// packages/core/src/sniff.ts) so sniff() calls these `found` rather than
// `blocked: thin-render`; the brief's shorter fixtures fall under that floor.
const vendorHtml = `<html><body><h1>Acme Scraper</h1><p>We sell a scraping API to developers. Our platform helps engineering teams collect structured web data at scale, handling proxies, browser rendering, retries, and anti-bot challenges automatically so a small team can run large crawls without maintaining infrastructure.</p>
  <a href="https://twitter.com/acme">tw</a></body></html>`
const aggregatorHtml =
  "<html><body><p>anchor.com is our #1 pick for this job, chosen after comparing dozens of vendors across pricing, reliability, and support quality so buyers do not have to run their own bake-off before choosing a tool.</p>" +
  Array.from({ length: 25 }, (_, i) => `<a href="https://vendor${i}.com/">v${i}</a>`).join(" ") +
  "</body></html>"

// core's RawResponse carries `httpStatus`, not `status` — see packages/core/src/sniff.ts.
function fakeFetcher(pages: Record<string, string>): FetchPort {
  return {
    async get(url) {
      const body = pages[url]
      if (body === undefined) return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
      return { url, httpStatus: 200, body, contentType: "text/html", ms: 1, usd: 0 }
    },
  }
}

describe("judgeHosts", () => {
  it("settles an aggregator by predicate — the model is never called", async () => {
    let modelCalls = 0
    const out = await judgeHosts([cand("listicle.com")], {
      fetcher: fakeFetcher({ "https://listicle.com/": aggregatorHtml }),
      classify: async () => { modelCalls++; return { name: "x", kind: "company", what: "", relation: "competitor", why: "" } },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(modelCalls).toBe(0)
    expect(out.entities[0]!).toMatchObject({ kind: "directory", relation: "lists", settledBy: "predicate" })
    expect(out.entities[0]!.because).toContain("25")
    expect(out.stats.aggregators).toBe(1)
  })

  it("settles an unreadable host as unknown — no model call", async () => {
    let modelCalls = 0
    const out = await judgeHosts([cand("dead.com")], {
      fetcher: fakeFetcher({}),
      classify: async () => { modelCalls++; return { name: "x", kind: "company", what: "", relation: "competitor", why: "" } },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(modelCalls).toBe(0)
    expect(out.entities[0]!).toMatchObject({ kind: "unknown", relation: "unknown", settledBy: "predicate" })
    expect(out.stats.unreadable).toBe(1)
  })

  it("sends a readable vendor page to the model and gates its answer", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async (_h, text) => {
        expect(text).toContain("scraping API")
        return { name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "sells the same job" }
      },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.entities[0]!).toMatchObject({ kind: "company", relation: "competitor", settledBy: "model" })
    expect(out.stats.modelJudged).toBe(1)
  })

  it("keeps anchor-naming pages as recall probes", async () => {
    const out = await judgeHosts([cand("listicle.com")], {
      fetcher: fakeFetcher({ "https://listicle.com/": aggregatorHtml }),
      classify: async () => ({ name: "", kind: "noise", what: "", relation: "none", why: "" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.probePages).toHaveLength(1)
    expect(out.probePages[0]!.url).toBe("https://listicle.com/")
  })

  it("a model classify failure downgrades to unknown instead of losing the host", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => { throw new Error("model down") },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.entities[0]!).toMatchObject({ kind: "unknown", relation: "unknown" })
    expect(out.entities[0]!.because).toContain("model")
  })

  // The measured calibration result: the aggregator threshold came back NULL —
  // no separation between vendor and directory front pages. `null` disables the
  // predicate rule entirely, so an aggregator-shaped page must fall through to
  // the model instead of being settled for free. This is the live default path,
  // not a corner case.
  it("with aggregatorThreshold null, the aggregator page is not settled by predicate and reaches the model", async () => {
    let modelCalls = 0
    const out = await judgeHosts([cand("listicle.com")], {
      fetcher: fakeFetcher({ "https://listicle.com/": aggregatorHtml }),
      classify: async () => { modelCalls++; return { name: "x", kind: "directory", what: "", relation: "lists", why: "" } },
      anchor: "anchor.com",
      aggregatorThreshold: null,
    })
    expect(modelCalls).toBe(1)
    expect(out.entities[0]!.settledBy).toBe("model")
    expect(out.stats.aggregators).toBe(0)
  })
})
