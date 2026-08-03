import { tool, type Tool } from "ai"
import { z } from "zod"
import { sniff } from "./sniff.js"
import { EvidenceStore, CitationError, type Evidence } from "./evidence.js"
import type { SpanStream } from "./spans.js"
import type { SearchPort, FetchPort } from "./ports.js"

export interface RunContext {
  evidence: EvidenceStore
  spans: SpanStream
  search: SearchPort
  fetch: FetchPort
  runId: string
  agentId: string
  parentId: string | null
  /** nodes and edges written so far, keyed by id */
  graph: { nodes: Map<string, StoredNode>; edges: StoredEdge[] }
}

export const RELATIONS = ["competitor", "substitute", "dependency", "integration", "shaper"] as const
export type Relation = (typeof RELATIONS)[number]

export interface StoredNode {
  id: string
  kind: "company" | "capability" | "buyer"
  name: string
  what: string
  whyHere: string
  howFound: string
  evidence: Evidence[]
}

export interface StoredEdge {
  from: string
  to: string
  relation: Relation
  whyHere: string
  howFound: string
  evidence: Evidence[]
}

export interface NodeInput {
  kind: "company" | "capability" | "buyer"
  name: string
  what: string
  whyHere: string
  howFound: string
  evidence: Array<{ handle: string; quote: string }>
}

export interface EdgeInput {
  from: string
  to: string
  relation: Relation
  whyHere: string
  howFound: string
  evidence: Array<{ handle: string; quote: string }>
}

export interface Finding {
  nodes: NodeInput[]
  edges: EdgeInput[]
}

// Explicit input/output shapes for each tool, named so `makeTools` can carry an explicit
// return type annotation. Without one, `tsc -b`'s declaration emit has to synthesize a
// portable name for the AI SDK's inferred `Tool<...>` instantiation itself and fails
// (TS2742) because that name would have to reach into pnpm's nested store for
// `@ai-sdk/provider-utils`/`@ai-sdk/provider`, which are not direct dependencies here.
// Spelling the shapes out ourselves keeps the reference to the portable `Tool` type
// import from `ai` (a direct dependency) instead.
export interface SearchToolInput {
  queries: string[]
  why: string
}
export interface SearchHitOut {
  url: string
  title: string
  description: string
}
export interface SearchResultOut {
  query: string
  ok: boolean
  error?: string
  hits: SearchHitOut[]
}
export interface SearchToolOutput {
  results: SearchResultOut[]
}

export interface FetchToolInput {
  urls: string[]
  mode: "direct" | "unlocked"
  why: string
}
export interface FetchFoundResult {
  url: string
  status: "found"
  handle: string
  bytes: number
  truncated: boolean
  slice: string
}
export interface FetchBlockedResult {
  url: string
  status: "blocked" | "not_found"
  reason?: string
  hint: string
}
export type FetchResultItem = FetchFoundResult | FetchBlockedResult
export interface FetchToolOutput {
  results: FetchResultItem[]
}

export interface ReadToolInput {
  handle: string
  offset: number
}
export type ReadToolOutput = { ok: false; reason: string } | { ok: true; slice: string; bytes: number; offset: number }

export interface RememberToolInput {
  nodes: NodeInput[]
  edges: EdgeInput[]
}
export interface RememberToolOutput {
  written: { nodes: number; edges: number }
  rejected: string[]
}

// The fields below are typed as the bare, generics-defaulted `Tool` rather than
// `Tool<SearchToolInput, SearchToolOutput>` etc. The AI SDK's `Tool` union carries an
// optional `toModelOutput` callback whose parameter is contravariant in OUTPUT, plus an
// `outputSchema`-bearing union member with no `execute` — pinning the generics here makes
// assignment from the real, inferred tool objects fight that contravariance and those
// union members for no benefit, since the input/output shapes are already documented
// above and enforced structurally by each tool's own `execute` body and zod schema.
export interface Tools {
  search: Tool
  fetch: Tool
  read: Tool
  remember: Tool
}

/** How much of a fetched page reaches the model. Pages run to 900KB; contexts do not. */
const SLICE = 8_000

const evidenceRef = z.object({
  handle: z.string().describe("the handle returned by fetch for the page this quote is on"),
  quote: z.string().min(8).describe("text copied verbatim from that page"),
})

export function makeTools(ctx: RunContext): Tools {
  const span = (
    kind: Parameters<SpanStream["emit"]>[0]["kind"],
    name: string,
    argsDigest: string,
    extra: { ms: number; usd?: number; ok: boolean; error?: string },
  ) => ctx.spans.emit({ runId: ctx.runId, agentId: ctx.agentId, parentId: ctx.parentId, kind, name, argsDigest, ...extra })

  const search = tool({
    description:
      "Run several web searches at once. Cheap and fast — this is how you find out what exists. " +
      "Batch every query you want in one call; one call buys a whole wave.",
    inputSchema: z.object({
      queries: z.array(z.string()).min(1).max(12),
      why: z.string().describe("what you expect these queries to buy, and why it is worth it"),
    }),
    execute: async ({ queries }) => {
      const results = await ctx.search.search(queries)
      for (const r of results) {
        span("search", "serp", r.query, { ms: r.ms, usd: r.usd, ok: r.ok, error: r.error })
      }
      return {
        results: results.map((r) => ({
          query: r.query,
          ok: r.ok,
          error: r.error,
          hits: r.hits.map((h) => ({ url: h.url, title: h.title, description: h.description })),
        })),
      }
    },
  })

  const fetchTool = tool({
    description:
      "Read web pages. mode 'direct' is FREE and instant but fails on sites that block or render in the browser. " +
      "mode 'unlocked' gets through almost anything but costs money and takes 13-16 seconds per page. " +
      "You choose. Spend an unlock on a page that will name many things at once; do not spend one to find out what a company is.",
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(8),
      mode: z.enum(["direct", "unlocked"]),
      why: z.string().describe("why these pages, and why this mode is worth its cost"),
    }),
    execute: async ({ urls, mode }) => {
      const out = await Promise.all(
        urls.map(async (url) => {
          const raw = await ctx.fetch.get(url, mode)
          const s = sniff(raw)
          const rec = ctx.evidence.record({ url, text: s.text, status: s.status, reason: s.reason })
          span("fetch", mode, url, {
            ms: raw.ms,
            usd: raw.usd,
            ok: s.status === "found",
            error: s.status === "found" ? undefined : `${s.status}: ${s.reason ?? "unknown"}`,
          })
          if (s.status !== "found") {
            return {
              url,
              status: s.status,
              reason: s.reason,
              hint:
                s.reason === "empty-body"
                  ? "the site refused us; try a different page or accept that this one is unreadable"
                  : s.reason === "thin-render"
                    ? "this page is assembled in the browser; an unlocked fetch may work, but costs 13-16s"
                    : "nothing usable came back",
            }
          }
          return {
            url,
            status: s.status,
            handle: rec.handle,
            bytes: s.text.length,
            truncated: s.text.length > SLICE,
            slice: s.text.slice(0, SLICE),
          }
        }),
      )
      return { results: out }
    },
  })

  const read = tool({
    description: "FREE. Re-read a page you already fetched, from a given offset. Costs nothing — use it instead of re-fetching.",
    inputSchema: z.object({
      handle: z.string(),
      offset: z.number().int().min(0).default(0),
    }),
    execute: async ({ handle, offset }) => {
      const rec = ctx.evidence.get(handle)
      span("read", "slice", handle, { ms: 0, usd: 0, ok: !!rec })
      if (!rec) return { ok: false, reason: `no such handle: ${handle}` }
      if (rec.status !== "found") return { ok: false, reason: `that page was ${rec.status} (${rec.reason ?? "unknown"})` }
      return { ok: true, slice: rec.text.slice(offset, offset + SLICE), bytes: rec.text.length, offset }
    },
  })

  const remember = tool({
    description:
      "Write what you found onto the map. Every node and edge needs a reason it belongs here and a quote " +
      "from a page you actually fetched. Anything you cannot prove is rejected and told back to you.",
    inputSchema: z.object({
      nodes: z
        .array(
          z.object({
            kind: z.enum(["company", "capability", "buyer"]),
            name: z.string(),
            what: z.string().describe("what it sells, and to whom"),
            whyHere: z.string().describe("why it belongs on THIS map, stated against the company we started from"),
            howFound: z.string().describe("the query or page that surfaced it"),
            evidence: z.array(evidenceRef).min(1),
          }),
        )
        .default([]),
      edges: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            relation: z.enum(RELATIONS),
            whyHere: z.string(),
            howFound: z.string(),
            evidence: z.array(evidenceRef).min(1),
          }),
        )
        .default([]),
    }),
    execute: async ({ nodes, edges }) => {
      const rejected: string[] = []
      let wroteNodes = 0
      let wroteEdges = 0

      const mint = (refs: Array<{ handle: string; quote: string }>, label: string): Evidence[] | null => {
        const out: Evidence[] = []
        for (const r of refs) {
          try {
            out.push(ctx.evidence.cite(r.handle, r.quote))
          } catch (e) {
            rejected.push(`${label}: ${(e as CitationError).message}`)
            return null
          }
        }
        return out
      }

      for (const n of nodes) {
        const ev = mint(n.evidence, `node "${n.name}"`)
        if (!ev) continue
        const id = `${n.kind}:${n.name.toLowerCase().replace(/\s+/g, "-")}`
        const existing = ctx.graph.nodes.get(id)
        if (existing) existing.evidence.push(...ev)
        else ctx.graph.nodes.set(id, { id, kind: n.kind, name: n.name, what: n.what, whyHere: n.whyHere, howFound: n.howFound, evidence: ev })
        wroteNodes++
      }

      for (const e of edges) {
        const ev = mint(e.evidence, `edge ${e.from}->${e.to}`)
        if (!ev) continue
        ctx.graph.edges.push({ from: e.from, to: e.to, relation: e.relation, whyHere: e.whyHere, howFound: e.howFound, evidence: ev })
        wroteEdges++
      }

      span("remember", "write", `${wroteNodes}n/${wroteEdges}e`, { ms: 0, usd: 0, ok: rejected.length === 0 })
      return { written: { nodes: wroteNodes, edges: wroteEdges }, rejected }
    },
  })

  return { search, fetch: fetchTool, read, remember }
}
