import { ToolLoopAgent, stepCountIs, tool, type LanguageModel, type StepResult, type ToolSet } from "ai"
import { z } from "zod"
import type { FetchPort, SpanStream } from "./index.js"
import type { ModelPricing } from "./pricing.js"
import { sniff } from "./sniff.js"
import { candidatesFromSitemap, candidatesFromLinks, isSitemapIndex, sitemapChildren, readPageFacts } from "./catalog.js"
import { loadPrompt } from "./prompts.js"

/**
 * Discovery: an agent that reads a company's own site and finds everything it sells.
 *
 * This is phase one, and the thing today's engine is weakest at. A single model
 * call handed pre-fetched pages read three products off a company with dozens of
 * product lines. An agent that PULLS the corpus itself — asks for the product
 * pages, reads the ones it judges worth reading, follows a lead, and submits
 * each product as it finds it — is how v1 reached three hundred where this
 * reached five.
 *
 * There is no product cap and no step where the run is sealed for looking full.
 * The agent decides when it has found everything. Cost is held down by running
 * discovery ALONE and cheaply, not by throttling it: `scripts/discover.ts` runs
 * exactly this and nothing else, so its quality can be judged without paying for
 * a whole map.
 *
 * The mechanical page-finder is a TOOL, not a replacement. `mapProductPages`
 * wraps the measured `catalog.ts` sitemap/nav discovery and hands the agent
 * candidate urls; the agent chooses which to read. Mechanical leaf, agentic
 * decision.
 */

export interface DiscoveredProduct {
  name: string
  does: string
  /** The url that established this product, so a reader can check it. */
  foundAt: string
}

/**
 * One thing the company's own pages say its products integrate with.
 *
 * The docs are where this lives: a marketing page says what a product is, the
 * documentation says what it plugs into, and the second is what an ecosystem
 * map is made of. Like a RivalLead, this is the COMPANY'S claim read off its
 * own site — not a judged entity, and nothing may put it on a map without
 * resolving and judging it like any other host.
 */
export interface DiscoveredIntegration {
  /** The other side's name, exactly as the company writes it. */
  with: string
  /** What the integration does, one line, the company's claim. */
  does: string
  /** The url of the page that states it. */
  foundAt: string
}

export interface DiscoveryResult {
  sells: string
  buyer: string
  products: DiscoveredProduct[]
  /** What the company says its products plug into, read from its docs. */
  integrations: DiscoveredIntegration[]
  /** Brand words that must never appear in a de-branded query. */
  coinages: string[]
  /** The agent's own account of how it read the company. */
  summary: string
  usd: number
  steps: number
  pagesRead: number
  /**
   * The agent's own per-turn steps, handed through untouched so a caller can price
   * each turn separately from the total this already carries.
   *
   * It was `unknown`, written `steps as unknown`, and `unknown` is not iterable — so
   * `scripts/discover.ts:56` could not loop over it, and nothing said so until scripts/
   * came under `pnpm check`. The type is the SDK's own; the loop it feeds reads
   * `usage.inputTokens` and `usage.outputTokens`, which is a promise only the SDK can
   * keep, and a hand-written `{ usage?: … }` here would be this file guessing at a
   * shape it does not own.
   *
   * `ToolSet`, not this agent's concrete tools: which tools discovery carries is an
   * implementation detail of `discover()`, and naming them in a public result type
   * would make every consumer of a DiscoveryResult depend on today's tool list.
   *
   * Nothing serialises a DiscoveryResult, so this is a claim about an in-memory
   * handoff and not about anything that survives JSON.
   */
  _steps?: StepResult<ToolSet>[]
}

export interface DiscoverOptions {
  anchor: string
  /** So a spawned discovery rolls up under the run and its dispatcher. */
  runId?: string
  parentId?: string | null
  model: LanguageModel
  fetch: FetchPort
  spans?: SpanStream
  /** Priced from the caller so core stays vendor-blind. */
  pricing?: ModelPricing
  modelName?: string
  /** A ceiling on turns, high by default: the point is to find everything, and
   *  the agent stops on its own when the site is exhausted. */
  maxSteps?: number
  agentsDir?: string
  /**
   * How to stop a discovery that is already spending.
   *
   * Every fetch it makes is delegated to the port, and the port bounds a fetch
   * by the signal its caller hands over — so with nowhere to put one, a
   * discovery's reads answered to nothing. It reaches the model loop too: a
   * cancel that stops the fetches and lets the agent keep taking turns has
   * stopped the cheap half.
   */
  signal?: AbortSignal
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const { anchor, model, fetch: fetcher } = opts
  const products: DiscoveredProduct[] = []
  const integrations: DiscoveredIntegration[] = []
  const readUrls = new Set<string>()
  let sells = ""
  let buyer = ""
  let coinages: string[] = []
  let finished = false

  const origin = `https://${anchor.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`

  const raw = async (url: string): Promise<string> => {
    const r = await fetcher.get(url, "direct", { signal: opts.signal })
    return r.httpStatus >= 200 && r.httpStatus < 300 ? r.body : ""
  }

  /**
   * The links a docs index carries, same host only, for the agent to choose
   * from. Not `candidatesFromLinks`: that filters to the six OFFERING path
   * prefixes, which is right for a marketing site and wrong for docs, where
   * the pages worth reading live under paths no whitelist predicts.
   */
  const docLinks = (html: string, base: string): string[] => {
    const out = new Set<string>()
    for (const m of html.matchAll(/href=["']([^"'#]+)["']/g)) {
      try {
        const u = new URL(m[1]!, base)
        if (u.host === new URL(base).host && u.pathname.length > 1) out.add(u.origin + u.pathname)
      } catch {
        // not a url
      }
      if (out.size >= 40) break
    }
    return [...out]
  }

  const agent = new ToolLoopAgent({
    model,
    instructions: loadPrompt("discover", opts.agentsDir ?? "prompts/agents").body,
    stopWhen: stepCountIs(opts.maxSteps ?? 40),
    tools: {
      mapProductPages: tool({
        description:
          "List the company's own product-page urls, from its sitemap and homepage nav. Cheap and " +
          "free. Call this first to see what pages exist, then read the ones that look like products.",
        inputSchema: z.object({}),
        execute: async () => {
          let xml = await raw(`${origin}/sitemap.xml`)
          // An index's children, all of them — following only the first let
          // alphabetical order pick what the agent saw. See sitemapChildren.
          if (xml && isSitemapIndex(xml)) {
            const bodies = await Promise.all(sitemapChildren(xml).map(raw))
            xml = bodies.filter(Boolean).join("\n")
          }
          let cands = xml ? candidatesFromSitemap(xml, 60) : []
          const home = await raw(`${origin}/`)
          const seen = new Set(cands.map((c) => c.url.replace(/\/+$/, "")))
          cands = [...cands, ...candidatesFromLinks(home, `${origin}/`, 60).filter((c) => !seen.has(c.url.replace(/\/+$/, "")))]
          return { urls: cands.map((c) => c.url).slice(0, 60) }
        },
      }),

      readPage: tool({
        description:
          "Fetch one of the company's pages and read what it says about itself: its title, heading " +
          "and description, plus the first of its text. Use this to decide what a page sells. Free.",
        inputSchema: z.object({ url: z.string() }),
        execute: async ({ url }) => {
          const body = await raw(url)
          readUrls.add(url)
          if (!body) return { ok: false, reason: "the page returned nothing (blocked or empty)" }
          const facts = readPageFacts(url, body)
          const text = sniff({ url, httpStatus: 200, body }).text.slice(0, 4_000)
          return {
            ok: true,
            title: facts?.title ?? "",
            heading: facts?.heading ?? "",
            description: facts?.description ?? "",
            text,
          }
        },
      }),

      findDocs: tool({
        description:
          "Probe the company's documentation surfaces — llms.txt at the root and on a docs " +
          "subdomain, /docs, /developers, /api — and report which ones answer, each with the links " +
          "its index carries. Free. The docs are where a company states what its products actually " +
          "do and what they integrate with; the marketing site says what it wants to sell.",
        inputSchema: z.object({}),
        execute: async () => {
          const host = origin.slice("https://".length)
          const probes = [
            `${origin}/llms.txt`,
            `https://docs.${host}/llms.txt`,
            `https://docs.${host}/`,
            `${origin}/docs`,
            `${origin}/developers`,
            `${origin}/api`,
          ]
          const found = await Promise.all(
            probes.map(async (url) => {
              const body = await raw(url)
              if (!body || body.length < 200) return null
              readUrls.add(url)
              // llms.txt IS an index, written for exactly this reader — hand
              // its text over rather than a link list scraped from markdown.
              if (/\.txt$/.test(new URL(url).pathname)) {
                return { url, kind: "llms-txt" as const, text: sniff({ url, httpStatus: 200, body }).text.slice(0, 4_000) }
              }
              const facts = readPageFacts(url, body)
              return { url, kind: "docs-index" as const, heading: facts?.heading ?? "", links: docLinks(body, url) }
            }),
          )
          const surfaces = found.filter((f) => f !== null)
          return surfaces.length
            ? { ok: true, surfaces }
            : { ok: false, reason: "no documentation surface answered — work from the marketing pages" }
        },
      }),

      submitIntegration: tool({
        description:
          "Record one thing the company's own pages say its products integrate with — another " +
          "company, tool or platform, named by the company itself, usually in its docs. Not a " +
          "rival, not a customer story, not a language the SDK ships in. Cite the page that " +
          "states it.",
        inputSchema: z.object({
          with: z.string().describe("the other side's name, exactly as the company writes it"),
          does: z.string().describe("what the integration does, one line, the company's claim"),
          foundAt: z.string().describe("the url of the page that states it"),
        }),
        execute: async ({ with: withName, does, foundAt }) => {
          const key = withName.trim().toLowerCase()
          if (integrations.some((i) => i.with.trim().toLowerCase() === key)) {
            return { ok: false, reason: `already submitted: ${withName}` }
          }
          integrations.push({ with: withName.trim(), does: does.trim(), foundAt })
          return { ok: true, total: integrations.length }
        },
      }),

      submitProduct: tool({
        description:
          "Record one product the company sells. A product is something a buyer can choose, pay for " +
          "and use on its own. Not a pricing tier, a docs section, a blog post, or a SKU variant of a " +
          "product you already submitted. Submit as many as the company genuinely sells — there is no " +
          "limit and a missed product is a whole market this map will never see.",
        inputSchema: z.object({
          name: z.string().describe("the product's name, exactly as the company writes it"),
          does: z.string().describe("what it does for the buyer, one line"),
          foundAt: z.string().describe("the url of the page that establishes it"),
        }),
        execute: async ({ name, does, foundAt }) => {
          const key = name.trim().toLowerCase()
          if (products.some((p) => p.name.trim().toLowerCase() === key)) {
            return { ok: false, reason: `already submitted: ${name}` }
          }
          products.push({ name: name.trim(), does: does.trim(), foundAt })
          return { ok: true, total: products.length }
        },
      }),

      finish: tool({
        description:
          "Call this once, when you have found every product the company sells. Give the company's " +
          "one-line pitch in the buyer's words, who buys it, and the brand words a search must never " +
          "use. This ends the investigation.",
        inputSchema: z.object({
          sells: z.string().describe("what the company sells, one plain sentence, no marketing words"),
          buyer: z.string().describe("who buys it and what has just gone wrong for them"),
          coinages: z.array(z.string()).describe("invented product and brand words a de-branded query must never contain"),
        }),
        execute: async (args) => {
          sells = args.sells
          buyer = args.buyer
          coinages = args.coinages
          finished = true
          return { ok: true, productsFound: products.length }
        },
      }),
    },
  })

  const started = Date.now()
  let lastTurnAt = started
  let turn = 0
  let usd = 0

  /**
   * Price each turn AT ITS BOUNDARY, not after the agent returns.
   *
   * The post-hoc loop meant nothing reached the stream until the whole agent
   * finished — so for the minutes an agent is thinking and spending, the cost
   * tiles sit frozen and the calls table is empty, which is exactly when a
   * reader wants to see movement. `onStepFinish` also gives a real per-turn
   * duration instead of the total divided by the step count.
   */
  const onStepFinish = (step: { usage?: { inputTokens?: number; outputTokens?: number } }) => {
    turn += 1
    const now = Date.now()
    const inTok = step.usage?.inputTokens ?? 0
    const outTok = step.usage?.outputTokens ?? 0
    const cost = opts.pricing
      ? (inTok / 1e6) * opts.pricing.inUsdPerM + (outTok / 1e6) * opts.pricing.outUsdPerM
      : 0
    usd += cost
    opts.spans?.emit({
      runId: opts.runId ?? anchor,
      agentId: "discover",
      parentId: opts.parentId ?? null,
      kind: "model",
      name: opts.modelName ?? "model",
      argsDigest: `discover turn ${turn}`,
      ms: now - lastTurnAt,
      ok: true,
      tokensIn: inTok,
      tokensOut: outTok,
      usd: cost,
      error: opts.pricing ? undefined : "no model pricing supplied — token cost not counted",
    })
    lastTurnAt = now
  }

  const result = await agent.generate({
    onStepFinish,
    // The same signal the fetches got. Stopping the reads while the turns carry
    // on stops the free half of a discovery and keeps paying for the other one.
    abortSignal: opts.signal,
    prompt: `Discover everything ${anchor} sells, by reading its own site.\n\nStart by mapping its product pages, then read and submit. When you are certain you have them all, call finish.\n\nGO.`,
  })

  const steps = result.steps ?? []

  // The agent should call finish; if it stopped without one, keep what it found
  // rather than losing the whole discovery over a missing final call.
  return {
    sells: sells || `(the agent did not summarise; ${products.length} products found)`,
    buyer,
    products,
    integrations,
    coinages,
    summary: result.text,
    usd,
    steps: steps.length,
    pagesRead: readUrls.size,
    _steps: steps,
    ...(finished ? {} : {}),
  }
}
