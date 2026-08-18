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
      classify: async () => { modelCalls++; return { name: "x", kind: "company", what: "", relation: "competitor", why: "", spans: [] } },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(modelCalls).toBe(0)
    expect(out.entities[0]!).toMatchObject({ kind: "directory", relation: "lists", settledBy: "predicate" })
    expect(out.entities[0]!.because).toContain("25")
    expect(out.stats.aggregators).toBe(1)
  })

  it("refuses a host the model named after the anchor, and everything it said with it", async () => {
    // Real: Figma's map carried a "Figma" whose domain was egnyte.com, and the
    // linker gave that node 273 of the map's 2,461 edges because it resolves a
    // mention to an entity by name. Six of the nine runs on disk had one.
    const out = await judgeHosts([cand("egnyte.com")], {
      fetcher: fakeFetcher({ "https://egnyte.com/": vendorHtml }),
      classify: async () => ({
        name: "Figma",
        kind: "product",
        what: "the collaborative interface design tool",
        relation: "shaper",
        why: "defines the category every other vendor positions against",
        spans: [],
      }),
      anchor: "figma.com",
      aggregatorThreshold: null,
    })
    const e = out.entities[0]!
    expect(e.domain).toBe("egnyte.com")
    // Not renamed and left standing: a model that answered with the wrong
    // subject was not describing this page, so its kind, relation and reasons
    // are about that same wrong subject.
    expect(e.name).toBe("egnyte.com")
    expect(e.kind).toBe("unknown")
    expect(e.relation).toBe("unknown")
    expect(e.what).toBe("")
    expect(e.why).toBe("")
    expect(e.because).toContain("anchor's own identity")
  })

  it("lets the anchor's own host keep the anchor's name", async () => {
    const out = await judgeHosts([cand("figma.com")], {
      fetcher: fakeFetcher({ "https://figma.com/": vendorHtml }),
      classify: async () => ({
        name: "Figma", kind: "company", what: "design tool", relation: "competitor",
        why: "it is the anchor", spans: [],
      }),
      anchor: "figma.com",
      aggregatorThreshold: null,
    })
    expect(out.entities[0]!.name).toBe("Figma")
  })

  it("does not fire on a two-letter anchor, where the name would be a coincidence", async () => {
    // "x.com" reduces to "x", which matches any entity anyone called X. The
    // rule declines rather than renaming real entities on a collision.
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({
        name: "X", kind: "company", what: "a thing", relation: "competitor", why: "w", spans: [],
      }),
      anchor: "x.com",
      aggregatorThreshold: null,
    })
    expect(out.entities[0]!.name).toBe("X")
  })

  it("settles an unreadable host as unknown — no model call", async () => {
    let modelCalls = 0
    const out = await judgeHosts([cand("dead.com")], {
      fetcher: fakeFetcher({}),
      classify: async () => { modelCalls++; return { name: "x", kind: "company", what: "", relation: "competitor", why: "", spans: [] } },
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
        return { name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "sells the same job", spans: ["We sell a scraping API"] }
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
      classify: async () => ({ name: "", kind: "noise", what: "", relation: "none", why: "", spans: [] }),
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
      classify: async () => ({ name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "same job", spans: ["We sell a scraping API"] }),
      anchor: "io.com",
      aggregatorThreshold: 12,
    })
    expect(out.probePages).toHaveLength(0)
  })

  it("a page naming the anchor on a word boundary still becomes a probe", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml.replace("</p>", " We benchmark against io.com/pricing weekly.</p>") }),
      classify: async () => ({ name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "same job", spans: ["We sell a scraping API"] }),
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
      classify: async () => { modelCalls++; return { name: "x", kind: "directory", what: "", relation: "lists", why: "", spans: [] } },
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
      classify: async () => ({ name: "x", kind: "company", what: "", relation: "competitor", why: "", spans: [] }),
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
      classify: async () => ({ name: "x", kind: "company", what: "", relation: "competitor", why: "", spans: [] }),
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
      classify: async (h) => ({ name: h.host, kind: "company", what: "", relation: "competitor", why: "", spans: [] }),
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
        classify: async () => ({ name: "x", kind: "company", what: "", relation: "competitor", why: "", spans: [] }),
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
      classify: async () => ({ name: "", kind: "noise", what: "", relation: "none", why: "", spans: [] }),
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
        return { name: `Name-${h.host}`, kind: "company", what: "scraping api", relation: "competitor", why: "sells the same job", spans: ["We sell a scraping API"] }
      },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const domains = new Set(out.entities.map((e) => e.domain))
    expect(domains.size).toBe(6)
    expect(out.entities).toHaveLength(6)
  })
})

/**
 * The dead-end taxonomy. The kernel's live run settled 127 of 867 hosts as
 * unreadable with one flattened sentence each — "could not be read this run
 * (blocked)" — while sniff had already derived WHY and rank threw the code
 * away. These tests hold the code on the entity (`unreadableReason`) and the
 * per-reason split on the stats (`unreadableByReason`), with the reader-facing
 * sentence unchanged.
 */
describe("judgeHosts dead-end taxonomy", () => {
  /** A fetcher whose hosts fail in every way the taxonomy names. */
  const mixedFetcher = (): FetchPort => ({
    async get(url) {
      const base = { url, ms: 1, usd: 0, contentType: "text/html" }
      if (url === "https://botwalled.com/") return { ...base, httpStatus: 200, body: "" }
      if (url === "https://jsonly.com/")
        return { ...base, httpStatus: 200, body: "<html><body><div id='root'></div></body></html>" }
      if (url === "https://gone.com/") return { ...base, httpStatus: 404, body: "nope" }
      if (url === "https://flaky.com/") return { ...base, httpStatus: 503, body: "" }
      if (url === "https://silent.com/") return { ...base, httpStatus: 0, body: "", contentType: undefined }
      if (url === "https://boom.com/") throw new Error("getaddrinfo ENOTFOUND boom.com")
      return { ...base, httpStatus: 200, body: vendorHtml }
    },
  })

  it("each unreadable entity carries the sniffer's code; the readable one carries none", async () => {
    const hosts = ["botwalled.com", "jsonly.com", "gone.com", "flaky.com", "silent.com", "boom.com", "acme.com"].map(cand)
    const out = await judgeHosts(hosts, {
      fetcher: mixedFetcher(),
      classify: async (h) => ({ name: h.host, kind: "company", what: "scraping api", relation: "competitor", why: "same job", spans: ["We sell a scraping API"] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      concurrency: 2,
    })
    const by = (d: string) => out.entities.find((e) => e.domain === d)!
    expect(by("botwalled.com").unreadableReason).toBe("empty-body")
    expect(by("jsonly.com").unreadableReason).toBe("thin-render")
    expect(by("gone.com").unreadableReason).toBe("http-404")
    expect(by("flaky.com").unreadableReason).toBe("server-error")
    expect(by("silent.com").unreadableReason).toBe("no-response")
    expect(by("boom.com").unreadableReason).toBe("fetch-failed")
    expect("unreadableReason" in by("acme.com")).toBe(false)
  })

  it("the reader-facing sentence is unchanged — the code rides beside it, never replaces it", async () => {
    const out = await judgeHosts([cand("botwalled.com"), cand("gone.com")], {
      fetcher: mixedFetcher(),
      classify: async () => { throw new Error("unreachable — both hosts are unreadable") },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const by = (d: string) => out.entities.find((e) => e.domain === d)!
    // Byte-pinned: this is the sentence the live run's 127 entities wear, and
    // the taxonomy was scoped to add a field, not to rewrite the because.
    expect(by("botwalled.com").because).toBe("its front page could not be read this run (blocked)")
    expect(by("gone.com").because).toBe("its front page could not be read this run (not_found)")
  })

  it("stats split the unreadable count by reason, and the split sums to the whole", async () => {
    const hosts = ["botwalled.com", "jsonly.com", "gone.com", "flaky.com", "silent.com", "boom.com", "acme.com"].map(cand)
    const out = await judgeHosts(hosts, {
      fetcher: mixedFetcher(),
      classify: async (h) => ({ name: h.host, kind: "company", what: "scraping api", relation: "competitor", why: "same job", spans: ["We sell a scraping API"] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      concurrency: 3,
    })
    expect(out.stats.unreadable).toBe(6)
    expect(out.stats.unreadableByReason).toEqual({
      "empty-body": 1,
      "thin-render": 1,
      "http-404": 1,
      "server-error": 1,
      "no-response": 1,
      "fetch-failed": 1,
    })
    const summed = Object.values(out.stats.unreadableByReason).reduce<number>((a, b) => a + (b ?? 0), 0)
    expect(summed).toBe(out.stats.unreadable)
  })

  it("counts per reason, not per host — two bot-walled hosts land in one bucket", async () => {
    const fetcher: FetchPort = {
      async get(url) {
        if (url === "https://thin.com/")
          return { url, httpStatus: 200, body: "<html><body><p>tiny</p></body></html>", contentType: "text/html", ms: 1, usd: 0 }
        return { url, httpStatus: 200, body: "", contentType: "text/html", ms: 1, usd: 0 }
      },
    }
    const out = await judgeHosts([cand("wall1.com"), cand("wall2.com"), cand("thin.com")], {
      fetcher,
      classify: async () => { throw new Error("unreachable — every host here is unreadable") },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.stats.unreadableByReason).toEqual({ "empty-body": 2, "thin-render": 1 })
    expect(out.stats.unreadable).toBe(3)
  })

  it("a run with nothing unreadable reports an empty split, not a missing one", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({ name: "Acme", kind: "company", what: "scraping api", relation: "competitor", why: "same job", spans: ["We sell a scraping API"] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.stats.unreadableByReason).toEqual({})
  })
})

// MEASUREMENT ONLY — descGrounded rides along on model-judged entities and
// nothing gates on it. The residual error class it meters: an embellished
// description inside a correctly-placed entity (a real competitor whose `what`
// invented "custom dataset delivery" its page nowhere offers). The page text
// is already in hand at classify time, so the number costs $0.
describe("judgeHosts description grounding", () => {
  it("a model-judged entity carries descGrounded measured against the page the model saw", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      // Every content term ("scraping", "api", "developers", "scraping api")
      // appears on the page — fully grounded.
      classify: async () => ({ name: "Acme", kind: "company", what: "a scraping api for developers", relation: "competitor", why: "same job", spans: ["a scraping API to developers"] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.entities[0]!.descGrounded).toBe(1)
    expect(out.stats.groundingMean).toBe(1)
  })

  it("an invented description scores low — the meter sees what the page never said", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      // Nothing here appears on the vendor page: the quanticdata.io shape.
      classify: async () => ({ name: "Acme", kind: "company", what: "custom dataset delivery for enterprises", relation: "competitor", why: "same job", spans: ["custom dataset delivery"] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.entities[0]!.descGrounded).toBe(0)
    expect(out.stats.groundingMean).toBe(0)
  })

  it("an unreadable page carries no descGrounded and does not move the mean", async () => {
    const out = await judgeHosts([cand("dead.com")], {
      fetcher: fakeFetcher({}),
      classify: async () => ({ name: "x", kind: "company", what: "anything", relation: "competitor", why: "", spans: [] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect("descGrounded" in out.entities[0]!).toBe(false)
    expect(out.stats.groundingMean).toBeNull()
  })

  it("groundingMean is the running mean across model-judged entities, 2 decimals, unreadables excluded", async () => {
    const hosts = [cand("grounded.com"), cand("invented.com"), cand("dead.com")]
    const pages: Record<string, string> = {
      "https://grounded.com/": vendorHtml,
      "https://invented.com/": vendorHtml,
    }
    const out = await judgeHosts(hosts, {
      fetcher: fakeFetcher(pages),
      classify: async (h) =>
        h.host === "grounded.com"
          ? // "browser rendering of datasets": browser, rendering and the
            // 2-gram "browser rendering" appear on the page, "datasets" does
            // not — 3 of 4, score 0.75.
            { name: "G", kind: "company", what: "browser rendering of datasets", relation: "competitor", why: "", spans: ["browser rendering, retries"] }
          : // nothing grounded — score 0.
            { name: "I", kind: "company", what: "custom dataset delivery", relation: "competitor", why: "", spans: ["custom dataset delivery"] },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      concurrency: 1,
    })
    const g = out.entities.find((e) => e.domain === "grounded.com")!
    const i = out.entities.find((e) => e.domain === "invented.com")!
    const d = out.entities.find((e) => e.domain === "dead.com")!
    expect(g.descGrounded).toBe(0.75)
    expect(i.descGrounded).toBe(0)
    expect("descGrounded" in d).toBe(false)
    // (0.75 + 0) / 2, rounded to 2 decimals.
    expect(out.stats.groundingMean).toBe(0.38)
  })

  it("a classify failure leaves no descGrounded — there is no description to ground", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => { throw new Error("model down") },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect("descGrounded" in out.entities[0]!).toBe(false)
    expect(out.stats.groundingMean).toBeNull()
  })
})

// THE GUARANTEE, not a meter: a what must carry 1-3 verbatim quotes from the
// page the model saw, each verified in code as a literal substring (the
// evidence mint's own containment check), or the what does not reach the
// reader. The class this converts from measured to impossible: the audit's
// one residual error, quanticdata.io — a real rival whose what invented
// "custom dataset delivery" its page nowhere offers. descGrounded stays as
// the regression canary; it still meters the model's own prose.
describe("judgeHosts span-bound descriptions", () => {
  it("a what whose spans all verify ships unchanged, wearing its receipts", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({
        name: "Acme", kind: "company", what: "a scraping api for developers",
        relation: "competitor", why: "same job",
        spans: ["We sell a scraping API to developers", "handling proxies, browser rendering"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    expect(e.what).toBe("a scraping api for developers")
    expect(e.spans).toEqual(["We sell a scraping API to developers", "handling proxies, browser rendering"])
    expect(e.descSpans).toEqual({ verified: 2, claimed: 2 })
  })

  it("the quanticdata shape: an invented what loses every span and is replaced by the fallback — the entity survives", async () => {
    const out = await judgeHosts([cand("quanticdata.io")], {
      fetcher: fakeFetcher({ "https://quanticdata.io/": vendorHtml }),
      // The page sells a scraping API; the what invents a capability. The one
      // span backing it fails containment, so the what cannot ship.
      classify: async () => ({
        name: "Quantic", kind: "company", what: "custom dataset delivery for enterprises",
        relation: "competitor", why: "same buyer",
        spans: ["custom dataset delivery"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    // The kind and relation survive — admit() gated those; only the prose drops.
    expect(e).toMatchObject({ kind: "company", relation: "competitor", settledBy: "model" })
    expect(e.what).toBe("Quantic — company whose description could not be tied to its page this run")
    expect(e.descSpans).toEqual({ verified: 0, claimed: 1 })
    expect("spans" in e).toBe(false)
    // The canary still meters the model's own prose, not the fallback.
    expect(e.descGrounded).toBe(0)
  })

  it("a partial failure drops the unverified span and keeps the what", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({
        name: "Acme", kind: "company", what: "a scraping api handling proxies",
        relation: "competitor", why: "same job",
        spans: ["We sell a scraping API", "handling proxies", "with white-glove onboarding"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    expect(e.what).toBe("a scraping api handling proxies")
    expect(e.spans).toEqual(["We sell a scraping API", "handling proxies"])
    expect(e.descSpans).toEqual({ verified: 2, claimed: 3 })
  })

  it("verification matches the mint's squash: case and wrapped whitespace do not defeat a real quote", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({
        name: "Acme", kind: "company", what: "a scraping api",
        relation: "competitor", why: "same job",
        spans: ["we SELL a scraping api", "structured web\n   data at scale"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    expect(out.entities[0]!.descSpans).toEqual({ verified: 2, claimed: 2 })
  })

  it("a span under the mint's 8-char minimum counts as claimed but never as verified", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({
        name: "Acme", kind: "company", what: "proxies",
        relation: "competitor", why: "same job",
        // "proxies" is 7 chars and a genuine substring — length alone refuses
        // it, same rule as the evidence mint's MIN_QUOTE_LENGTH.
        spans: ["proxies"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    expect(e.descSpans).toEqual({ verified: 0, claimed: 1 })
    expect(e.what).toBe("Acme — company whose description could not be tied to its page this run")
  })

  it("an empty what claims nothing — no fallback fires, descSpans records 0/0", async () => {
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": vendorHtml }),
      classify: async () => ({ name: "Acme", kind: "company", what: "", relation: "competitor", why: "same job", spans: [] }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    expect(e.what).toBe("")
    expect(e.descSpans).toEqual({ verified: 0, claimed: 0 })
  })

  it("stored receipts are capped at 360 chars total — whole spans kept while they fit, all still verified", async () => {
    // Three long sentences on the page; the model quotes all three (~150 chars
    // each). All verify, but only the first two fit the 360-char budget, so
    // the third is dropped from storage — the COUNT still says 3/3.
    const s1 = "Our managed extraction pipeline renders every page in a real browser and retries through residential exits until the content is fully loaded and parsed."
    const s2 = "Enterprise customers schedule recurring crawls from a dashboard and receive structured records in their own warehouse within minutes of each run finishing."
    const s3 = "A dedicated solutions team tunes selectors and anti-bot settings for every new target site so scraping keeps working when the target changes its markup."
    const longHtml = `<html><body><h1>Acme</h1><p>${s1} ${s2} ${s3}</p></body></html>`
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": longHtml }),
      classify: async () => ({
        name: "Acme", kind: "company", what: "a managed extraction pipeline",
        relation: "competitor", why: "same job",
        spans: [s1, s2, s3],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    expect(e.descSpans).toEqual({ verified: 3, claimed: 3 })
    expect(e.spans).toEqual([s1, s2])
    expect(e.spans!.reduce((n, sp) => n + sp.length, 0)).toBeLessThanOrEqual(360)
  })

  it("a single verified span longer than the budget is cut to it — a prefix of a literal substring is still literal", async () => {
    const long =
      "Our managed extraction pipeline renders every page in a real browser and retries through residential exits until the content is fully loaded, then normalises the markup, deduplicates records against previous runs, ships the rows to the customer warehouse, and alerts the on-call engineer whenever a target site changes its structure badly enough that selectors need attention."
    const longHtml = `<html><body><h1>Acme</h1><p>${long}</p></body></html>`
    const out = await judgeHosts([cand("acme.com")], {
      fetcher: fakeFetcher({ "https://acme.com/": longHtml }),
      classify: async () => ({
        name: "Acme", kind: "company", what: "a managed extraction pipeline",
        relation: "competitor", why: "same job",
        spans: [long],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    const e = out.entities[0]!
    expect(e.descSpans).toEqual({ verified: 1, claimed: 1 })
    expect(e.spans).toEqual([long.slice(0, 360)])
  })

  it("predicate-settled and failed-classify entities carry no span ledger — there was no judgement to back", async () => {
    const out = await judgeHosts([cand("dead.com"), cand("broken.com")], {
      fetcher: fakeFetcher({ "https://broken.com/": vendorHtml }),
      classify: async () => { throw new Error("model down") },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
    })
    for (const e of out.entities) {
      expect("descSpans" in e).toBe(false)
      expect("spans" in e).toBe(false)
    }
  })
})

describe("judgeHosts blocked-page recovery", () => {
  const rich = (host: string) => ({
    host,
    seenIn: 3,
    intents: ["evaluation"],
    titles: ["Acme log search — hosted full-text search", "Acme pricing and plans for platform teams"],
    desc: "Acme sells hosted log search with a year of retention to platform teams that outgrew grep.",
    topHit: `https://${host}/`,
  })

  it("escalates a corroborated 403 through the unlocker and judges the unlocked page", async () => {
    const calls: string[] = []
    const out = await judgeHosts([rich("walled.com")], {
      fetcher: {
        async get(url, mode) {
          calls.push(mode)
          return mode === "unlocked"
            ? { url, httpStatus: 200, body: vendorHtml, ms: 14_000, usd: 0.008 }
            : { url, httpStatus: 403, body: "", ms: 100, usd: 0 }
        },
      },
      classify: async () => ({
        name: "Walled", kind: "company", what: "a vendor selling hosted log search",
        relation: "competitor", why: "same job", spans: ["hosted log search"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: null,
      unlockSeenIn: 3,
    })
    expect(calls).toEqual(["direct", "unlocked"])
    expect(out.stats.unlocked).toBe(1)
    const e = out.entities[0]!
    expect(e.kind).toBe("company")
    expect(e.because).toBeUndefined()
  })

  it("spends nothing on a host below the corroboration bar", async () => {
    const calls: string[] = []
    const out = await judgeHosts([{ ...rich("walled.com"), seenIn: 1 }], {
      fetcher: {
        async get(url, mode) {
          calls.push(mode)
          return { url, httpStatus: 403, body: "", ms: 100, usd: 0 }
        },
      },
      classify: async () => { throw new Error("unreachable for a blank") },
      anchor: "anchor.com",
      aggregatorThreshold: null,
      unlockSeenIn: 3,
    })
    expect(calls).toEqual(["direct"])
    expect(out.stats.unlocked).toBe(0)
    // Still judged — from the SERP text the run already paid for.
    expect(out.stats.serpJudged + out.stats.settledFree).toBeGreaterThan(0)
  })

  it("judges an unreadable host from its SERP presence, wearing the caveat", async () => {
    const out = await judgeHosts([{ ...rich("dark.com"), seenIn: 1 }], {
      fetcher: fakeFetcher({}),
      classify: async (_h, text) => ({
        name: "Dark", kind: "company",
        what: "a vendor selling hosted log search to platform teams",
        relation: "competitor", why: "same capability to the same buyer",
        spans: ["hosted log search", "not on the serp text at all"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: null,
    })
    const e = out.entities[0]!
    expect(out.stats.serpJudged).toBe(1)
    expect(e.kind).toBe("company")
    expect(e.because).toContain("judged from the search results that surfaced it")
    expect(e.unreadableReason).toBeDefined()
    // Spans still verified — against the SERP text, same containment check.
    expect(e.descSpans).toEqual({ verified: 1, claimed: 2 })
    expect(e.spans).toEqual(["hosted log search"])
  })

  it("leaves the honest blank when even the SERP said nearly nothing", async () => {
    const out = await judgeHosts(
      [{ host: "ghost.com", seenIn: 1, intents: [], titles: ["Ghost"], desc: "", topHit: "https://ghost.com/" }],
      {
        fetcher: fakeFetcher({}),
        classify: async () => { throw new Error("unreachable — the text is too thin to judge") },
        anchor: "anchor.com",
        aggregatorThreshold: null,
      },
    )
    const e = out.entities[0]!
    expect(e.kind).toBe("unknown")
    expect(e.because).toContain("could not be read")
  })

  it("withdraws a name whose home is a different registrable domain", async () => {
    const resellerHtml = `<html><body><h1>SendGrid Japan</h1><p>Email delivery for the Japanese market, operated by KKE. SendGrid features and pricing in Japanese, with local support and billing for teams here.</p></body></html>`
    const out = await judgeHosts([{ ...rich("sendgrid.kke.co.jp"), seenIn: 2 }], {
      fetcher: fakeFetcher({ "https://sendgrid.kke.co.jp/": resellerHtml }),
      classify: async () => ({
        name: "SendGrid", kind: "company", what: "a transactional email API",
        relation: "competitor", why: "same job", spans: ["Email delivery"],
      }),
      anchor: "anchor.com",
      aggregatorThreshold: null,
    })
    const e = out.entities[0]!
    expect(e.kind).toBe("unknown")
    expect(e.because).toContain("whose home is not kke.co.jp")
    expect(e.name).toBe("sendgrid.kke.co.jp")
    // The page was thin, so this went down the SERP-judged road — which is
    // the point: a wrong door is withdrawn on BOTH judging paths.
    expect(e.unreadableReason).toBeDefined()
  })
})
