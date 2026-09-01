import { describe, it, expect } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { FakeFetch } from "../src/testing/fake-provider.js"
import { discover } from "../src/discovery.js"

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
})
