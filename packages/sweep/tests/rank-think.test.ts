import { describe, it, expect } from "vitest"
import { judgeHosts, type Judged, type HostCandidate } from "../src/rank.js"
import { rankThinkLine } from "../src/sweep.js"
import { emitUi, readUi, type UiFrame } from "../src/ui.js"
import { SpanStream, type FetchPort, type Span } from "@open-kb/core"

/**
 * The rank phase's reading panel, restored.
 *
 * The batch classifier emitted a think frame per kept classification and the
 * per-host rewrite dropped it, so the live panel went silent through the
 * longest phase of the run. These tests run the real judge pool against a fake
 * port, wire `onJudged` the way sweep() does — `rankThinkLine` into the same
 * `ui:agent` / `text-delta` frame the panel already reads (AgentPanel keys on
 * `type === "text-delta"` and `delta`; readUi returns ns "agent") — and assert
 * what lands on the stream.
 *
 * The choice, pinned here: predicate-settled hosts ARE shown, wearing their
 * `because`. The batch era showed every kept classification (the predicate
 * concept did not exist to filter on), and the `ranked` results frame beside
 * this one already streams predicate-settled entities with `because ?? why` —
 * the two surfaces must not disagree about the same event. Noise stays off
 * the panel, as it always was.
 */

const cand = (host: string): HostCandidate => ({ host, seenIn: 2, intents: ["evaluation"], titles: ["t"], desc: "d" })

// Padded past core's THIN_TEXT floor so sniff() calls the page found.
const vendorHtml = `<html><body><h1>Acme Scraper</h1><p>We sell a scraping API to developers. Our platform helps engineering teams collect structured web data at scale, handling proxies, browser rendering, retries, and anti-bot challenges automatically so a small team can run large crawls without maintaining infrastructure.</p></body></html>`
const aggregatorHtml =
  "<html><body><p>We compared dozens of vendors across pricing, reliability, and support quality so buyers do not have to run their own bake-off before choosing a web scraping tool for their team.</p>" +
  Array.from({ length: 25 }, (_, i) => `<a href="https://vendor${i}.com/">v${i}</a>`).join(" ") +
  "</body></html>"

function fakeFetcher(pages: Record<string, string>): FetchPort {
  return {
    async get(url) {
      const body = pages[url] ?? ""
      return { url, httpStatus: 200, body, contentType: "text/html", ms: 1, usd: 0 }
    },
  }
}

/** A SpanStream whose every emitted span is also kept for the assertions. */
function capturingStream(): { spans: SpanStream; emitted: Span[] } {
  const spans = new SpanStream()
  const emitted: Span[] = []
  const orig = spans.emit.bind(spans)
  spans.emit = (input) => {
    const s = orig(input)
    emitted.push(s)
    return s
  }
  return { spans, emitted }
}

/** Exactly sweep()'s wiring: the line, into the frame shape its `think` emits. */
function thinkJudged(spans: SpanStream, runId: string): (e: Judged) => void {
  return (e) => {
    const line = rankThinkLine(e)
    if (line) emitUi(spans, runId, "agent", "rank", { type: "text-delta", delta: `${line}\n` })
  }
}

const agentFrames = (emitted: Span[]): UiFrame[] =>
  emitted.map(readUi).filter((f): f is UiFrame => f !== null && f.ns === "agent")

describe("rank think frames", () => {
  it("emits one panel-shaped frame per model-judged host, carrying the entity's name", async () => {
    const hosts = [cand("acme.com"), cand("rival.com")]
    const pages: Record<string, string> = {
      "https://acme.com/": vendorHtml,
      "https://rival.com/": vendorHtml,
    }
    const names: Record<string, string> = { "acme.com": "Acme Scraper", "rival.com": "Rival Co" }
    const { spans, emitted } = capturingStream()
    await judgeHosts(hosts, {
      fetcher: fakeFetcher(pages),
      classify: async (h) => ({ name: names[h.host]!, kind: "company", what: "a scraping api", relation: "competitor", why: "sells the same job" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      onJudged: thinkJudged(spans, "run-1"),
    })
    const frames = agentFrames(emitted)
    expect(frames).toHaveLength(2)
    for (const f of frames) {
      // The exact vocabulary AgentPanel and readUi already consume — ns
      // "agent", type "text-delta", newline-terminated delta. Nothing new.
      expect(f.frame.type).toBe("text-delta")
      expect(String(f.frame.delta)).toMatch(/\n$/)
    }
    const text = frames.map((f) => String(f.frame.delta)).join("")
    expect(text).toContain("Acme Scraper (acme.com) — company/competitor: sells the same job")
    expect(text).toContain("Rival Co (rival.com) — company/competitor: sells the same job")
  })

  it("includes predicate-settled hosts, wearing their because", async () => {
    const hosts = [cand("dead.com"), cand("listicle.com")]
    // dead.com gets an empty body (unreadable); listicle.com is the
    // 25-outbound-link aggregator shape, settled free with the threshold on.
    const { spans, emitted } = capturingStream()
    await judgeHosts(hosts, {
      fetcher: fakeFetcher({ "https://listicle.com/": aggregatorHtml }),
      classify: async () => {
        throw new Error("classify must not be reached — both hosts settle by predicate")
      },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      onJudged: thinkJudged(spans, "run-1"),
    })
    const frames = agentFrames(emitted)
    expect(frames).toHaveLength(2)
    const text = frames.map((f) => String(f.frame.delta)).join("")
    // The refusal is the content: an unreadable host says so, an
    // aggregator-shaped one says what settled it.
    expect(text).toMatch(/dead\.com — unknown\/unknown: its front page could not be read/)
    expect(text).toMatch(/listicle\.com — directory\/lists: /)
  })

  it("emits nothing for a host the model judged noise", async () => {
    const { spans, emitted } = capturingStream()
    await judgeHosts([cand("spam.com")], {
      fetcher: fakeFetcher({ "https://spam.com/": vendorHtml }),
      classify: async () => ({ name: "Spam", kind: "noise", what: "", relation: "none", why: "" }),
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      onJudged: thinkJudged(spans, "run-1"),
    })
    expect(agentFrames(emitted)).toHaveLength(0)
  })

  it("a mixed pool yields exactly one frame per kept host — none doubled, none dropped", async () => {
    const hosts = [cand("acme.com"), cand("dead.com"), cand("spam.com")]
    const { spans, emitted } = capturingStream()
    await judgeHosts(hosts, {
      fetcher: fakeFetcher({
        "https://acme.com/": vendorHtml,
        "https://spam.com/": vendorHtml,
      }),
      classify: async (h) =>
        h.host === "spam.com"
          ? { name: "Spam", kind: "noise", what: "", relation: "none", why: "" }
          : { name: "Acme", kind: "company", what: "a scraping api", relation: "competitor", why: "same job" },
      anchor: "anchor.com",
      aggregatorThreshold: 12,
      onJudged: thinkJudged(spans, "run-1"),
    })
    const deltas = agentFrames(emitted).map((f) => String(f.frame.delta))
    expect(deltas).toHaveLength(2)
    expect(deltas.filter((d) => d.includes("acme.com"))).toHaveLength(1)
    expect(deltas.filter((d) => d.includes("dead.com"))).toHaveLength(1)
    expect(deltas.filter((d) => d.includes("spam.com"))).toHaveLength(0)
  })
})

describe("rankThinkLine", () => {
  it("prints the host alone when the judgement carries no separate name", () => {
    const line = rankThinkLine({
      name: "dead.com", domain: "dead.com", kind: "unknown", what: "", relation: "unknown",
      why: "", because: "its front page could not be read this run (blocked)", settledBy: "predicate",
    })
    expect(line).toBe("dead.com — unknown/unknown: its front page could not be read this run (blocked)")
  })

  it("prefers the because over the why on a downgraded claim — the refusal is the news", () => {
    const line = rankThinkLine({
      name: "Rival", domain: "rival.com", kind: "company", what: "a vendor", relation: "unknown",
      why: "sells the same job", because: "claimed competitor without its own page read this run",
      settledBy: "model",
    })
    expect(line).toContain("claimed competitor without its own page")
    expect(line).not.toContain("sells the same job")
  })

  it("is null for noise — the panel never showed it and still does not", () => {
    expect(
      rankThinkLine({ name: "x", domain: "x.com", kind: "noise", what: "", relation: "none", why: "", settledBy: "model" }),
    ).toBeNull()
  })
})
