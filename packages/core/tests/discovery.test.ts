import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { FakeFetch } from "../src/testing/fake-provider.js"
import { discover } from "../src/discovery.js"
import { SpanStream } from "../src/spans.js"

/**
 * `discover()` had no dedicated test at all — every other caller of a
 * ToolLoopAgent in this package (investigate, catalog) has one, this did not.
 *
 * The gap that mattered: the file tracks `finished` (did the agent call its
 * own `finish` tool, or did it run out of turns?) but never returned it — the
 * comment right above the return says a run that stops without calling finish
 * still hands back whatever it found, which means a reader NEEDS to be able
 * to tell a complete list from a truncated one, and nothing exposed that. The
 * field existed, was written, and was thrown away by a no-op
 * `...(finished ? {} : {})` spread. Fixed by returning it; these two tests
 * pin both branches so it cannot regress the same way twice.
 */
describe("discover", () => {
  const call = (id: string, toolName: string, input: unknown) => [
    { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
  ]
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  }

  it("reports finished: true and the submitted facts when the agent calls finish", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "submitProduct", { name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" })
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: ["Widgetify"] })
              : [{ type: "text" as const, text: "Found one product." }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 6 })

    expect(out.finished).toBe(true)
    expect(out.products).toEqual([{ name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" }])
    expect(out.sells).toBe("widgets")
    expect(out.buyer).toBe("widget buyers")
  })

  it("reports finished: false but keeps what it found when the turn ceiling is hit first", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        // Never calls finish — always another product, so the ceiling is what stops it.
        return {
          content: call(String(turn + 1), "submitProduct", {
            name: `Widget ${turn}`,
            does: "does widget things",
            foundAt: "https://acme.com/widget",
          }),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 2 })

    expect(out.finished).toBe(false)
    // Truncated, not empty: the whole point of keeping a result on a missing
    // `finish` call is that the partial list still ships.
    expect(out.products.length).toBeGreaterThan(0)
    expect(out.sells).toContain("did not summarise")
  })

  /**
   * `submitProduct` and `submitIntegration` both dedup on
   * `name.trim().toLowerCase()` before pushing — the one guard standing
   * between an agent that re-describes something it already found and a map
   * that lists it twice. Neither branch had a test anywhere in the repo
   * (checked: no test file references the "already submitted" reject path),
   * so a rewrite of either guard could silently start doubling entries and
   * nothing would fail.
   */
  it("submitProduct rejects a name that only differs by case or whitespace from one already submitted", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "submitProduct", { name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" })
            : turn === 1
              ? call("2", "submitProduct", { name: "  WIDGET ", does: "same thing, reworded", foundAt: "https://acme.com/widget-2" })
              : turn === 2
                ? call("3", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
                : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 3 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 6 })

    // The near-duplicate never landed: still one product, the first one.
    expect(out.products).toEqual([{ name: "Widget", does: "does widget things", foundAt: "https://acme.com/widget" }])

    // And it was refused, not silently ignored — the model saw why.
    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const rejected = results.find((r) => r.toolCallId === "2")
    expect(rejected?.output).toEqual({ ok: false, reason: expect.stringContaining("already submitted") })
  })

  it("submitIntegration rejects a name that only differs by case or whitespace from one already submitted", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "submitIntegration", { with: "PagerDuty", does: "pages on-call", foundAt: "https://acme.com/docs" })
            : turn === 1
              ? call("2", "submitIntegration", { with: " pagerduty ", does: "reworded", foundAt: "https://acme.com/docs/2" })
              : turn === 2
                ? call("3", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
                : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 3 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), maxSteps: 6 })

    expect(out.integrations).toEqual([{ with: "PagerDuty", does: "pages on-call", foundAt: "https://acme.com/docs" }])

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const rejected = results.find((r) => r.toolCallId === "2")
    expect(rejected?.output).toEqual({ ok: false, reason: expect.stringContaining("already submitted") })
  })

  /**
   * `mapProductPages` and `readPage` are the two tools that actually touch a
   * company's site — sitemap/nav discovery and page fetching — and neither had
   * ever been invoked by any test in the repo: the tests above only ever
   * script `submitProduct`/`submitIntegration`/`finish`, and the sweep's
   * agent-mode fixture (packages/sweep/tests/discovery-agent-mode.test.ts)
   * only ever scripts `findDocs` and the same three. Confirmed with
   * `vitest run --coverage`: both `execute` bodies read 0 for function count
   * (fn 3 and fn 4 in coverage/coverage-final.json's fnMap for this file),
   * i.e. zero statements of either had ever run.
   */
  it("mapProductPages merges the sitemap with the homepage nav, dropping a link the sitemap already gave it", async () => {
    const sitemap =
      `<?xml version="1.0"?><urlset>` +
      `<loc>https://acme.com/products/gadget</loc>` +
      `<loc>https://acme.com/products/widget</loc>` +
      `<loc>https://acme.com/blog/post-1</loc>` +
      `</urlset>`
    // The nav repeats /products/widget (already in the sitemap) and adds
    // /pricing, which the sitemap did not carry.
    const home = `<html><body><a href="/products/widget">Widget</a><a href="/pricing">Pricing</a></body></html>`

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "mapProductPages", {})
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
              : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({
      anchor: "acme.com",
      model,
      fetch: new FakeFetch({
        "https://acme.com/sitemap.xml": { httpStatus: 200, body: sitemap },
        "https://acme.com/": { httpStatus: 200, body: home },
      }),
      maxSteps: 6,
    })

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const mapped = results.find((r) => r.toolCallId === "1")
    // Sitemap candidates first (gadget before widget, alphabetical within the
    // same tier/depth), then the one nav link the sitemap did not already
    // supply — /products/widget from the nav is dropped as a repeat.
    expect(mapped?.output).toEqual({
      urls: ["https://acme.com/products/gadget", "https://acme.com/products/widget", "https://acme.com/pricing"],
    })
  })

  /**
   * `mapProductPages`' `isSitemapIndex` branch (discovery.ts:180-183: fetch
   * every child, join their bodies, then run `candidatesFromSitemap` on the
   * joined text) had never run anywhere in the repo. Confirmed with `vitest
   * run --coverage`: discovery.ts reported those three lines uncovered
   * (98.25% stmts) while `isSitemapIndex` and `sitemapChildren` themselves
   * are unit-tested in catalog.test.ts as pure functions — the integration
   * that actually follows an index down to its children was untested. The
   * merge test above only ever hands the tool a leaf `<urlset>`.
   */
  it("mapProductPages follows a sitemap index down to its children and reads candidates out of the merged body", async () => {
    const index =
      `<?xml version="1.0"?><sitemapindex>` +
      `<loc>https://acme.com/sitemap-blog.xml</loc>` +
      `<loc>https://acme.com/sitemap-products.xml</loc>` +
      `</sitemapindex>`
    const products = `<?xml version="1.0"?><urlset><loc>https://acme.com/products/widget</loc></urlset>`
    // A child sitemap the reorder pushes last (CONTENT-named) — present to
    // prove both children are fetched and merged, not just the first.
    const blog = `<?xml version="1.0"?><urlset><loc>https://acme.com/blog/post-1</loc></urlset>`

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "mapProductPages", {})
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
              : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const fetch = new FakeFetch({
      "https://acme.com/sitemap.xml": { httpStatus: 200, body: index },
      "https://acme.com/sitemap-products.xml": { httpStatus: 200, body: products },
      "https://acme.com/sitemap-blog.xml": { httpStatus: 200, body: blog },
      "https://acme.com/": { httpStatus: 200, body: "<html><body></body></html>" },
    })

    const out = await discover({ anchor: "acme.com", model, fetch, maxSteps: 6 })

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const mapped = results.find((r) => r.toolCallId === "1")
    // The product from the products child made it through; the blog child
    // was fetched too (both children's urls are in fetch.calls below) but
    // its /blog/ path is dropped by rank()'s own CONTENT filter, same as a
    // leaf sitemap would drop it.
    expect(mapped?.output).toEqual({ urls: ["https://acme.com/products/widget"] })
    expect(fetch.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining(["https://acme.com/sitemap-products.xml", "https://acme.com/sitemap-blog.xml"]),
    )
  })

  it("readPage fetches a batch concurrently and reports a page that came back empty, direct and then unlocked", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "readPage", { urls: ["https://acme.com/products/widget", "https://acme.com/dead"] })
            : turn === 1
              ? call("2", "readPage", { urls: ["https://acme.com/dead"], unlock: true })
              : turn === 2
                ? call("3", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
                : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 3 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({
      anchor: "acme.com",
      model,
      fetch: new FakeFetch({
        "https://acme.com/products/widget": {
          httpStatus: 200,
          body:
            "<title>Widget</title><h1>Widget</h1><meta name='description' content='does widget things'>" +
            "the widget page's own body text",
        },
        // "https://acme.com/dead" is absent from the table, so FakeFetch
        // answers it 404/empty under either fetch mode.
      }),
      maxSteps: 6,
    })

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])

    // The direct batch: one page read, one page empty with the direct-mode
    // reason (which points at the unlock:true retry).
    const direct = results.find((r) => r.toolCallId === "1")?.output as { pages: unknown[] }
    expect(direct.pages).toEqual([
      {
        url: "https://acme.com/products/widget",
        ok: true,
        title: "Widget",
        heading: "Widget",
        description: "does widget things",
        text: expect.stringContaining("widget page's own body text"),
      },
      {
        url: "https://acme.com/dead",
        ok: false,
        reason: "returned nothing (blocked or empty) — worth one unlock:true retry if this page matters",
      },
    ])

    // The unlocked retry of the same dead page: a different reason, since the
    // caller already paid for the escalation.
    const unlocked = results.find((r) => r.toolCallId === "2")?.output as { pages: unknown[] }
    expect(unlocked.pages).toEqual([{ url: "https://acme.com/dead", ok: false, reason: "even the unlocker got nothing usable" }])

    // Both fetches — one answer, one empty — count toward pages read; a
    // failed read is still a read.
    expect(out.pagesRead).toBe(2)
  })

  /**
   * `findDocs`' own execute body had no test in this package (grepped: only
   * the comment above mentions it by name), and the one place it does run —
   * packages/sweep/tests/discovery-agent-mode.test.ts's "reads the docs" test
   * — only ever hands it a docs-index page whose hrefs all parse. That leaves
   * `docLinks`' own try/catch around `new URL(m[1]!, base)` (discovery.ts,
   * inside findDocs) unexercised anywhere in the repo: nothing had ever
   * handed a docs index a href `new URL()` rejects. A docs page is
   * third-party markup the run does not control, same class of input as the
   * sitemap `<loc>` fixed for `pathOf` in catalog.ts (SELF-231).
   */
  it("findDocs drops a docs-index href that isn't a url instead of throwing, and keeps the ones that are", async () => {
    const docsHtml =
      `<html><head><title>Docs</title></head><body><h1>Acme Docs</h1>` +
      `<a href="/guide">Guide</a><a href="http://[bad">Bad</a>` +
      `<p>Padding text so this docs index clears the two-hundred-byte floor findDocs requires before treating a probe as a real answer.</p></body></html>`

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "findDocs", {})
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
              : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({
      anchor: "acme.com",
      model,
      fetch: new FakeFetch({
        "https://docs.acme.com/": { httpStatus: 200, body: docsHtml },
      }),
      maxSteps: 6,
    })

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const found = results.find((r) => r.toolCallId === "1")?.output as {
      ok: boolean
      surfaces: Array<{ url: string; kind: string; heading: string; links: string[] }>
    }
    expect(found.ok).toBe(true)
    expect(found.surfaces).toEqual([
      { url: "https://docs.acme.com/", kind: "docs-index", heading: "Acme Docs", links: ["https://docs.acme.com/guide"] },
    ])
  })

  /**
   * `findDocs`'s llms.txt branch (discovery.ts:269-272) had never run: every
   * existing findDocs test in this file and in
   * packages/sweep/tests/discovery-agent-mode.test.ts only ever answers a
   * probe with an HTML docs-index page, so the file always took the
   * `docs-index` fork of the `if (/\.txt$/.test(...))` check and never the
   * `llms-txt` one. Confirmed with `vitest run --coverage
   * --coverage.include='packages/core/src/discovery.ts'`: branch id 40
   * (269:56-272:15) read 0 hits at 84.84% branch overall for the file — the
   * only remaining gap that was a whole untested code path rather than a
   * dead-by-construction fallback.
   *
   * Closing that branch exposed a second, narrower one underneath it: the
   * `cap` ternary at line 270 (`/llms-full/.test(url) ? 12_000 : 4_000`) had
   * only its `4_000` side proven, since a plain `llms.txt` probe never
   * matches `llms-full`. Both urls are asserted here in one call so the two
   * caps are checked against the same probe order the tool actually runs.
   */
  it("findDocs reads llms.txt and llms-full.txt as llms-txt surfaces, capped at 4,000 and 12,000 chars respectively", async () => {
    const llmsTxt = "# Acme\n" + "Acme sells widgets. ".repeat(15)
    expect(llmsTxt.length).toBeGreaterThanOrEqual(200)
    expect(llmsTxt.length).toBeLessThan(4_000)
    // Longer than the plain cap but shorter than the full one, so only a port
    // that actually reads `llms-full` in the url (not just the 4,000 cap)
    // would return this untruncated.
    const llmsFullTxt = "# Acme (full)\n" + "Acme sells widgets, in detail. ".repeat(200)
    expect(llmsFullTxt.length).toBeGreaterThan(4_000)
    expect(llmsFullTxt.length).toBeLessThan(12_000)

    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "findDocs", {})
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
              : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({
      anchor: "acme.com",
      model,
      fetch: new FakeFetch({
        "https://acme.com/llms.txt": { httpStatus: 200, body: llmsTxt },
        "https://acme.com/llms-full.txt": { httpStatus: 200, body: llmsFullTxt },
      }),
      maxSteps: 6,
    })

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const found = results.find((r) => r.toolCallId === "1")?.output as {
      ok: boolean
      surfaces: Array<{ url: string; kind: string; text: string }>
    }
    expect(found.ok).toBe(true)
    expect(found.surfaces).toEqual([
      { url: "https://acme.com/llms.txt", kind: "llms-txt", text: llmsTxt },
      { url: "https://acme.com/llms-full.txt", kind: "llms-txt", text: llmsFullTxt },
    ])
  })

  /**
   * `findDocs`'s failure branch had never run. A `vitest --coverage` pass over
   * the whole repo (looking for what 263 nights of self-discovered work had
   * missed) put discovery.ts at 51/65 branches (78.46%) with exactly one
   * uncovered statement: line 280's `{ ok: false, reason: "no documentation
   * surface answered..." }`. Every existing findDocs test, including the one
   * above, hands it at least one probe that answers; nothing had ever handed
   * it silence on all seven (llms.txt x2, docs-subdomain llms.txt and root,
   * /docs, /developers, /api).
   */
  it("findDocs reports ok: false when none of its seven probes answer", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const turn = prompt.filter((m) => m.role === "tool").length
        const content =
          turn === 0
            ? call("1", "findDocs", {})
            : turn === 1
              ? call("2", "finish", { sells: "widgets", buyer: "widget buyers", coinages: [] })
              : [{ type: "text" as const, text: "done" }]
        return {
          content,
          finishReason: { unified: turn >= 2 ? ("stop" as const) : ("tool-calls" as const), raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const out = await discover({
      anchor: "acme.com",
      model,
      fetch: new FakeFetch({}), // every probe 404s — FakeFetch's default for an unlisted url
      maxSteps: 6,
    })

    const results = (out._steps ?? []).flatMap((s) => s.toolResults ?? [])
    const found = results.find((r) => r.toolCallId === "1")?.output as { ok: boolean; reason: string }
    expect(found).toEqual({ ok: false, reason: "no documentation surface answered — work from the marketing pages" })
  })

  /**
   * `onStepFinish` (discovery.ts ~361-385) prices every turn and, when `opts.spans`
   * is supplied, emits a span for it — but every test above calls `discover()`
   * without `spans` at all, so `opts.spans?.emit(...)` short-circuits and the whole
   * block (the pricing ternary, the `runId`/`parentId`/`modelName` fallbacks, the
   * "no model pricing supplied" error text) had never run once: a `vitest --coverage`
   * pass over the whole repo put discovery.ts at 80.3% branch with exactly this block
   * named (lines 365, 371, 375-395). That is the one path that turns discovery's own
   * tokens into dollars and tells a run what phase-one specifically cost, so a broken
   * rate formula — or a span silently never reaching the stream — would ship silent.
   *
   * Two tests, like investigator.test.ts's own fix for the identical gap: one with a
   * rate supplied (the ternary's true side, and the caller-given runId/parentId/
   * modelName), one without (the false side, and every `??` fallback).
   */
  it("prices a model turn against the rate the caller supplies, and emits a span naming the run", async () => {
    const spans = new SpanStream()
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Nothing to report." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 500_000, noCache: 500_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100_000, text: 100_000, reasoning: 0 },
        },
        warnings: [],
      }),
    })

    const out = await discover({
      anchor: "acme.com",
      model,
      fetch: new FakeFetch({}),
      runId: "r1",
      parentId: "lead",
      spans,
      pricing: { inUsdPerM: 2, outUsdPerM: 10 },
      modelName: "test-model",
    })

    // (500_000 / 1e6) * 2 + (100_000 / 1e6) * 10 = 1.0 + 1.0
    expect(out.usd).toBeCloseTo(2, 6)
    expect(spans.totalUsd()).toBeCloseTo(2, 6)

    spans.close()
    const emitted = []
    for await (const s of spans.stream()) emitted.push(s)
    expect(emitted).toHaveLength(1)
    const span = emitted[0]!
    expect(span.runId).toBe("r1")
    expect(span.parentId).toBe("lead")
    expect(span.agentId).toBe("discover")
    expect(span.kind).toBe("model")
    expect(span.name).toBe("test-model")
    expect(span.tokensIn).toBe(500_000)
    expect(span.tokensOut).toBe(100_000)
    expect(span.error).toBeUndefined()
  })

  it("without a rate, reports the turn as free and names why on the span — and falls back to the anchor, null, and 'model'", async () => {
    const spans = new SpanStream()
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Nothing to report." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 500_000, noCache: 500_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100_000, text: 100_000, reasoning: 0 },
        },
        warnings: [],
      }),
    })

    // No runId, parentId, modelName or pricing — every fallback in the block at once.
    const out = await discover({ anchor: "acme.com", model, fetch: new FakeFetch({}), spans })

    expect(out.usd).toBe(0)
    expect(spans.totalUsd()).toBe(0)

    spans.close()
    const emitted = []
    for await (const s of spans.stream()) emitted.push(s)
    expect(emitted).toHaveLength(1)
    const span = emitted[0]!
    expect(span.runId).toBe("acme.com")
    expect(span.parentId).toBeNull()
    expect(span.name).toBe("model")
    expect(span.usd).toBe(0)
    expect(span.error).toBe("no model pricing supplied — token cost not counted")
  })
})
