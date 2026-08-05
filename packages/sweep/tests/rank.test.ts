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

  it("a page containing the anchor only inside a larger token is not a probe", async () => {
    // The substring era: anchor "io.com" matched "radio.com" and the map was
    // graded against a page that never named the anchor at all. Same boundary
    // semantics as core's answerKeyRecall, now shared.
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml.replace("</p>", " As covered on radio.com last week.</p>") }),
      classify: async () => ({ name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "same job" }),
      anchor: "io.com",
      aggregatorThreshold: 12,
    })
    expect(out.probePages).toHaveLength(0)
  })

  it("a page naming the anchor on a word boundary still becomes a probe", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml.replace("</p>", " We benchmark against io.com/pricing weekly.</p>") }),
      classify: async () => ({ name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "same job" }),
      anchor: "io.com",
      aggregatorThreshold: 12,
    })
    expect(out.probePages.map((p) => p.url)).toEqual(["https://acme.com/"])
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

// The single-host tests above never exercise the worker pool itself: with one
// candidate there is exactly one fetch, so the concurrency bound, the drain
// loop's completeness, and the abort check at the top of `worker()` are all
// unreached. These tests use many hosts specifically to put the pool under
// load.
describe("judgeHosts pool", () => {
  it("bounds in-flight fetches to the configured concurrency", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetcher: FetchPort = {
      async get(url) {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        // Empty body -> sniff() reads this as unreadable, settling every host
        // by predicate. The point of this test is the pool's shape, not the
        // judging path, so classify is never meant to be reached.
        return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 5, usd: 0 }
      },
    }
    const hosts = Array.from({ length: 8 }, (_, i) => cand(`host${i}.com`))
    const out = await judgeHosts(hosts, {
      fetcher,
      classify: async () => { throw new Error("classify should not be reached — every host here is unreadable") },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      concurrency: 2,
    })
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(out.entities).toHaveLength(8)
  })

  it("drains every host exactly once, and settledFree + modelJudged accounts for all of them", async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => cand(`host${i}.com`))
    // Even-indexed hosts get the padded vendor page and reach the model;
    // odd-indexed hosts get no entry in the page map, so fakeFetcher returns
    // an empty body and sniff() reads them as unreadable.
    const pages: Record<string, string> = {}
    hosts.forEach((h, i) => {
      if (i % 2 === 0) pages[`https://${h.host}/`] = vendorHtml
    })
    const out = await judgeHosts(hosts, {
      fetcher: fakeFetcher(pages),
      classify: async () => ({ name: "x", kind: "company", what: "", relation: "competitor", why: "" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      concurrency: 4,
    })
    expect(out.entities).toHaveLength(12)
    expect(out.stats.fetched).toBe(12)
    expect(out.stats.settledFree + out.stats.modelJudged).toBe(out.stats.fetched)
  })

  it("returns immediately when the signal is already aborted — the fetcher is never called", async () => {
    let fetchCalls = 0
    const fetcher: FetchPort = {
      async get(url) {
        fetchCalls++
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const hosts = [cand("a.com"), cand("b.com"), cand("c.com")]
    const out = await judgeHosts(hosts, {
      fetcher,
      classify: async () => ({ name: "x", kind: "company", what: "", relation: "competitor", why: "" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      // Every worker checks `deps.signal?.aborted` at the top of its loop,
      // before ever popping the queue — so an already-aborted signal means
      // no host is ever fetched.
      signal: AbortSignal.abort(),
    })
    expect(out.entities).toHaveLength(0)
    expect(fetchCalls).toBe(0)
  })

  it("a port that throws for one host downgrades that host, not the run", async () => {
    // The FetchPort contract nowhere says never-throw. The shipped provider
    // converts failures to httpStatus 0, but an alternate port that throws on
    // DNS failure must cost one host, not every entity already judged.
    const hosts = [cand("ok0.com"), cand("boom.com"), cand("ok1.com"), cand("ok2.com")]
    const fetches: Array<{ url: string; ok: boolean }> = []
    const fetcher: FetchPort = {
      async get(url) {
        if (url === "https://boom.com/") throw new Error("getaddrinfo ENOTFOUND boom.com")
        return { url, httpStatus: 200, body: vendorHtml, contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const out = await judgeHosts(hosts, {
      fetcher,
      classify: async (h) => ({ name: h.host, kind: "company", what: "", relation: "competitor", why: "" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      onFetch: (url, ok) => fetches.push({ url, ok }),
    })
    expect(out.entities).toHaveLength(4)
    const boom = out.entities.find((e) => e.domain === "boom.com")!
    expect(boom).toMatchObject({ kind: "unknown", relation: "unknown", settledBy: "predicate" })
    expect(boom.because).toContain("threw")
    expect(boom.because).toContain("ENOTFOUND")
    expect(out.entities.filter((e) => e.settledBy === "model")).toHaveLength(3)
    expect(out.stats.fetched).toBe(4)
    expect(out.stats.settledFree + out.stats.modelJudged).toBe(out.stats.fetched)
    expect(fetches.find((f) => f.url === "https://boom.com/")!.ok).toBe(false)
  })

  it("a throw caused by the abort signal rejects the run instead of settling the host", async () => {
    // An abort must stay an abort: the sweep-level guard turns it into the
    // run's rejection. Settling the host as unknown would let an aborted run
    // report a judged map.
    const ctl = new AbortController()
    const fetcher: FetchPort = {
      async get() {
        ctl.abort()
        const e = new Error("This operation was aborted")
        e.name = "AbortError"
        throw e
      },
    }
    await expect(
      judgeHosts([cand("a.com"), cand("b.com")], {
        fetcher,
        classify: async () => ({ name: "x", kind: "company", what: "", relation: "competitor", why: "" }),
        anchor: "anchor.com",
        aggregatorThreshold: 12,
        signal: ctl.signal,
      }),
    ).rejects.toThrow("aborted")
  })

  it("the anchor's own homepage is judged but never becomes a recall probe", async () => {
    // The anchor's page names the anchor by definition; letting it into the
    // probe pool would have the map grading itself.
    const out = await judgeHosts([cand("anchor.com"), cand("listicle.com")], {
      fetcher: fakeFetcher({
        "https://anchor.com/": aggregatorHtml,
        "https://listicle.com/": aggregatorHtml,
      }),
      classify: async () => ({ name: "", kind: "noise", what: "", relation: "none", why: "" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.probePages.map((p) => p.url)).toEqual(["https://listicle.com/"])
    expect(out.entities.map((e) => e.domain).sort()).toEqual(["anchor.com", "listicle.com"])
  })

  it("does not duplicate or drop hosts when classify resolves out of order under concurrency", async () => {
    const hosts = Array.from({ length: 6 }, (_, i) => cand(`vendor${i}.com`))
    const pages: Record<string, string> = {}
    for (const h of hosts) pages[`https://${h.host}/`] = vendorHtml
    const out = await judgeHosts(hosts, {
      fetcher: fakeFetcher(pages),
      classify: async (h) => {
        await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 9))
        return { name: `Name-${h.host}`, kind: "company", what: "scraping api", relation: "competitor", why: "sells the same job" }
      },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const domains = new Set(out.entities.map((e) => e.domain))
    expect(domains.size).toBe(6)
    expect(out.entities).toHaveLength(6)
  })
})
