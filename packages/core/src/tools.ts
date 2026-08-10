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
  /**
   * How to stop this agent's paid work mid-flight.
   *
   * The fetch port takes a signal and delegates the whole bound to whoever
   * calls it; a context with nowhere to put one made that impossible from here,
   * so a fetch started by this tool answered to nothing at all. Optional
   * because it is a capability, not a requirement — a caller with no way to
   * cancel (a script, a test) simply has nothing to pass, and gets the port's
   * own backstop. swarm's tool context carries exactly this field; core's
   * lacking it was the anomaly.
   */
  signal?: AbortSignal
}

export const RELATIONS = ["competitor", "substitute", "dependency", "integration", "shaper"] as const
export type Relation = (typeof RELATIONS)[number]

export const NODE_KINDS = ["company", "product", "capability", "buyer", "community"] as const
export type NodeKind = (typeof NODE_KINDS)[number]

/**
 * What each kind is for, in the words the model reads.
 *
 * This is not documentation for us. It is spliced into the `remember` tool's schema, because a
 * kind the model is never told about is a kind that stays empty: `capability` and `buyer` were
 * in the enum for the whole of the first live run against a payments company, nothing anywhere
 * said what they were for, and that run recorded four nodes, all of them `company`.
 *
 * Keyed by `NodeKind`, so a kind cannot be added to `NODE_KINDS` without the compiler demanding
 * the sentence that tells the model what to put in it.
 */
export const NODE_KIND_GUIDE: Record<NodeKind, string> = {
  company: "a firm — the vendor itself, not the thing it sells",
  product:
    "one named thing a company sells, recorded apart from its vendor, because a company can compete " +
    "with the anchor on one product and be irrelevant on the rest",
  capability: "the job being done, in brand-free words — what a buyer is actually trying to get done",
  buyer: "who spends the money: the role, team or kind of business, not a named customer",
  community:
    "where this market's buyers gather and talk — a subreddit, forum, Slack or Discord, conference, " +
    "trade body, newsletter or trade publication. Record the place, not a post in it",
}

export interface StoredNode {
  id: string
  kind: NodeKind
  name: string
  what: string
  whyHere: string
  howFound: string
  evidence: Evidence[]
  /**
   * Competing accounts of the same thing, kept when two agents record one entity. With a single
   * writer these stay empty. With thirty provers working different angles at once, a collision is
   * usually two true descriptions of one company rather than a duplicate, and keeping only the
   * first-arrived silently discards the second agent's whole contribution.
   */
  alsoWhat: string[]
  alsoWhyHere: string[]
  /**
   * Set only on the node a run seeds for its anchor (see `anchorNode`). It is the one node
   * on the map that carries no evidence, because nothing was fetched to prove it, it is
   * where the map starts, not something the map found. A surface rendering "0 citations" as
   * a defect needs this flag to tell the anchor apart from an unproven claim; nothing else
   * can reach the graph without citations, since `remember` is the only other way in.
   */
  isAnchor?: true
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
  kind: NodeKind
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

/**
 * The one place a node id is minted. Both `remember` and `anchorNode` go through it, so a
 * node written by the agent and a node seeded by the run cannot drift into two id spellings
 * of the same company.
 */
export function nodeId(kind: NodeKind, name: string): string {
  return `${kind}:${name.trim().toLowerCase().replace(/\s+/g, "-")}`
}

/**
 * The company the map is drawn around, as a node.
 *
 * It is a real entity on the map, every edge is stated against it, but it is the only node
 * with an empty `evidence` array, because nothing was fetched to prove it. That is honest
 * rather than convenient: the alternative was to invent a citation for it, which is exactly
 * the failure `cite()` exists to prevent. It is seeded straight onto the graph rather than
 * through `remember`, so the tool's "at least one verified quote" rule is untouched for
 * every node the agent discovers.
 */
export function anchorNode(anchor: string): StoredNode {
  const name = anchor.trim()
  return {
    id: nodeId("company", name),
    kind: "company",
    name,
    what: "Not established by this run — no page was fetched to describe the anchor itself.",
    whyHere: "This is the anchor. The map exists to explain this company's position, and every other node here is stated against it.",
    howFound: "Seeded as the anchor of this run, before any search ran. Not discovered, and carries no evidence.",
    evidence: [],
    alsoWhat: [],
    alsoWhyHere: [],
    isAnchor: true,
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//
/** A leading `www.`, whether the endpoint carries a kind prefix (`company:www.x.com`) or not. */
const LEADING_WWW = new RegExp(`^((?:${NODE_KINDS.join("|")}):)?www\\.`)
const TRAILING_SLASH = /\/+$/

/**
 * Reduce an edge endpoint, or a node's own id or name, to a comparison key.
 *
 * Every step here is a reversible spelling difference, never a similarity: case, surrounding
 * and interior whitespace, a URL scheme, a leading `www.`, a trailing slash. Nothing is
 * dropped that could distinguish two companies, so two keys are equal only when the two
 * strings name the same thing. Deliberately absent: prefix, substring and edit-distance
 * matching. A wrong edge asserts a relationship nobody can trace back to a page, which is
 * worse than an edge the model has to write again.
 */
function endpointKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(SCHEME, "")
    .replace(LEADING_WWW, "$1")
    .replace(TRAILING_SLASH, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Every spelling that unambiguously names a node on the graph, mapped to the ids that claim
 * it. A key claimed by two different nodes is kept as both, never resolved to whichever was
 * seen first: `company:checkout` and `capability:checkout` both answer to "checkout", and
 * guessing between them would silently attach the edge to the wrong entity.
 */
function endpointIndex(nodes: Iterable<StoredNode>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  const add = (spelling: string, id: string) => {
    const key = endpointKey(spelling)
    if (!key) return
    const claimed = index.get(key)
    if (claimed) claimed.add(id)
    else index.set(key, new Set([id]))
  }
  for (const n of nodes) {
    add(n.id, n.id)
    add(n.name, n.id)
    // The id without its kind prefix, `checkout.com` for `company:checkout.com`. This is how
    // a model that is thinking about a company writes it, and it is an exact slice of the id
    // rather than a guess at one.
    add(n.id.slice(n.kind.length + 1), n.id)
  }
  return index
}

type Resolved = { ok: true; id: string } | { ok: false; problem: string }

/**
 * Turn what the model wrote into a node id that is really on the graph, or say what to do
 * about it. Never creates the node: an edge to a company nobody recorded is a claim with no
 * page behind it, and inventing the node would launder it into a fact.
 */
function resolveEndpoint(raw: string, index: Map<string, Set<string>>): Resolved {
  const claimed = index.get(endpointKey(raw))
  if (!claimed || claimed.size === 0) {
    return {
      ok: false,
      problem:
        `"${raw}" is not a node on this map. Record that company as a node first, with a quote from a page you ` +
        `fetched, then write this edge again using the name you gave it.`,
    }
  }
  if (claimed.size > 1) {
    return {
      ok: false,
      problem: `"${raw}" names more than one node (${[...claimed].sort().join(", ")}). Write the exact node id you mean.`,
    }
  }
  return { ok: true, id: [...claimed][0]! }
}

/** One refused claim: what the model called it, and why it did not land. */
interface Rejection {
  label: string
  reason: string
}

/** How many rejections a span spells out in full before the rest are named but not explained. */
/** The provider's own sentence in front of ours, when there is one. Kept as a
 *  function so both halves of this file — and the reader — see that a detail
 *  never replaces the advice; it only precedes it. */
function withDetail(detail: string | undefined, generic: string): string {
  return detail ? `${detail} — ${generic}` : generic
}

const REJECTIONS_IN_FULL = 3

/**
 * One line for a span's `error` field. Every rejected claim is named, a log that says
 * "3 rejected" without saying which is the invisible failure this exists to end, while only
 * the first few carry their full reason, so one bad batch cannot flood the log.
 */
function summariseRejections(rejections: Rejection[]): string {
  const parts = rejections.slice(0, REJECTIONS_IN_FULL).map((r) => `${r.label}: ${r.reason}`)
  const rest = rejections.slice(REJECTIONS_IN_FULL)
  if (rest.length) parts.push(`+${rest.length} more rejected: ${rest.map((r) => r.label).join(", ")}`)
  return `${rejections.length} rejected — ${parts.join(" | ")}`
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
  /** Present when truncated: the offset `read` should resume from to continue past this slice. */
  nextOffset?: number
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
// optional `toModelOutput` callback whose parameter is contravariant in output, plus an
// `outputSchema`-bearing union member with no `execute`, pinning the generics here makes
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
      "Batch every query you want in one call; one call buys a whole wave. " +
      "EVERY HIT COMES BACK WITH A HANDLE, so you can record what a result tells you without " +
      "opening the page. Quote the title or description you were given. Opening the page is " +
      "stronger evidence and worth it when a result matters, but a search result is real " +
      "evidence and recording from it is how a run covers a whole market rather than the " +
      "handful of pages it had time to read.",
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
          hits: r.hits.map((h) => {
            // A search result is a retrieval this run performed: the engine returned this title
            // and description for this URL. Recording it makes the whole result bag citable
            // instead of only the few pages a run has time to open, measured at 91 domains seen
            // against 14 recorded, because nothing but a fetched page could be cited.
            // Tiered `snippet` so a reader can tell it from a page the run actually read.
            const rec = ctx.evidence.record({
              url: h.url,
              text: `${h.title}\n${h.description}`,
              status: "found",
              tier: "snippet",
            })
            return { url: h.url, title: h.title, description: h.description, handle: rec.handle }
          }),
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
          const raw = await ctx.fetch.get(url, mode, { signal: ctx.signal })
          const s = sniff(raw)
          const rec = ctx.evidence.record({ url, text: s.text, status: s.status, reason: s.reason })
          span("fetch", mode, url, {
            ms: raw.ms,
            usd: raw.usd,
            ok: s.status === "found",
            // The reason code says which dead end; the detail says who called
            // it. A refusal the provider spelled out is worth more in a span
            // than "blocked: empty-body" repeated a hundred times.
            error: s.status === "found" ? undefined : `${s.status}: ${s.reason ?? "unknown"}${s.detail ? ` — ${s.detail}` : ""}`,
          })
          if (s.status !== "found") {
            return {
              url,
              status: s.status,
              reason: s.reason,
              // Given to the model verbatim where it exists: a stated refusal
              // tells it whether to try another page or another mode, which is
              // the decision the generic sentences below can only guess at.
              // Appended, not substituted. The provider's sentence names WHICH
              // way the host answered with nothing; the generic sentence carries
              // what to do about it, which the header never does. Swapping one
              // for the other hands the model a diagnosis and takes away the
              // advice — see tools-paid.ts, which draws the same line.
              hint: withDetail(
                s.detail,
                s.reason === "empty-body"
                  ? "the site refused us; try a different page or accept that this one is unreadable"
                  : s.reason === "thin-render"
                    ? "this page is assembled in the browser; an unlocked fetch may work, but costs 13-16s"
                    : "nothing usable came back",
              ),
            }
          }
          const truncated = s.text.length > SLICE
          return {
            url,
            status: s.status,
            handle: rec.handle,
            bytes: s.text.length,
            truncated,
            slice: s.text.slice(0, SLICE),
            ...(truncated ? { nextOffset: SLICE } : {}),
          }
        }),
      )
      return { results: out }
    },
  })

  const read = tool({
    description:
      "FREE. Re-read a page you already fetched, from a given offset. When a fetch comes back truncated, pass its " +
      "nextOffset here to continue exactly where that slice cut off. Costs nothing — use it instead of re-fetching.",
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
      "Write what you found onto the map. A map is an ecosystem, not a shortlist of rivals: it holds " +
      `${NODE_KINDS.join(", ")} — see the "kind" field for what each one is for, and use all of them. ` +
      "Every node and edge needs a reason it belongs here and a quote from a page you actually fetched. " +
      "Anything you cannot prove is rejected and told back to you. An edge may only join things that are " +
      "already on the map, so record something as a node before you draw an edge to it — the same call is " +
      "fine, nodes are written first.",
    inputSchema: z.object({
      nodes: z
        .array(
          z.object({
            kind: z.enum(NODE_KINDS).describe(NODE_KINDS.map((k) => `${k} — ${NODE_KIND_GUIDE[k]}`).join(". ")),
            name: z.string(),
            what: z
              .string()
              .describe("what it is: for a company or product, what it sells and to whom; for a community, who gathers there and what about"),
            whyHere: z.string().describe("why it belongs on THIS map, stated against the company we started from"),
            howFound: z.string().describe("the query or page that surfaced it"),
            evidence: z.array(evidenceRef).min(1),
          }),
        )
        .default([]),
      edges: z
        .array(
          z.object({
            from: z.string().describe("something already on the map, written by the exact name you recorded it under"),
            to: z.string().describe("something already on the map, written by the exact name you recorded it under"),
            relation: z.enum(RELATIONS),
            whyHere: z.string(),
            howFound: z.string(),
            evidence: z.array(evidenceRef).min(1),
          }),
        )
        .default([]),
    }),
    execute: async ({ nodes, edges }) => {
      const rejections: Rejection[] = []
      let wroteNodes = 0
      let wroteEdges = 0

      const mint = (refs: Array<{ handle: string; quote: string }>, label: string): Evidence[] | null => {
        const out: Evidence[] = []
        for (const r of refs) {
          try {
            out.push(ctx.evidence.cite(r.handle, r.quote))
          } catch (e) {
            rejections.push({ label, reason: (e as CitationError).message })
            return null
          }
        }
        return out
      }

      for (const n of nodes) {
        const ev = mint(n.evidence, `node "${n.name}"`)
        if (!ev) continue
        const id = nodeId(n.kind, n.name)
        const existing = ctx.graph.nodes.get(id)
        if (existing) {
          // Two agents found the same thing. Keep both accounts rather than letting whoever
          // arrived first own the record: with one writer a collision is a duplicate, but with
          // thirty provers running at once it is usually two different angles on one company,
          // and silently keeping only the earlier one throws away the deliverable.
          existing.evidence.push(...ev)
          if (n.what && n.what !== existing.what) existing.alsoWhat.push(n.what)
          if (n.whyHere && n.whyHere !== existing.whyHere) existing.alsoWhyHere.push(n.whyHere)
          if (n.howFound && !existing.howFound.includes(n.howFound)) existing.howFound += ` · ${n.howFound}`
        } else {
          ctx.graph.nodes.set(id, {
            id, kind: n.kind, name: n.name, what: n.what, whyHere: n.whyHere,
            howFound: n.howFound, evidence: ev, alsoWhat: [], alsoWhyHere: [],
          })
        }
        wroteNodes++
      }

      // Built after the nodes land, so an edge can join two companies recorded in this very
      // call, which is how a model writes a finding: the nodes and the relation together.
      const index = endpointIndex(ctx.graph.nodes.values())

      for (const e of edges) {
        // The label quotes the endpoints as the model wrote them, so the rejection it reads
        // back names the strings it can find in its own last message.
        const label = `edge ${e.from}->${e.to}`
        const ev = mint(e.evidence, label)
        if (!ev) continue
        const from = resolveEndpoint(e.from, index)
        const to = resolveEndpoint(e.to, index)
        if (!from.ok || !to.ok) {
          // A Set, because `from` and `to` can be the same unresolved string and saying so
          // twice reads like two different problems.
          const problems = new Set<string>()
          if (!from.ok) problems.add(from.problem)
          if (!to.ok) problems.add(to.problem)
          rejections.push({ label, reason: [...problems].join(" ") })
          continue
        }
        ctx.graph.edges.push({ from: from.id, to: to.id, relation: e.relation, whyHere: e.whyHere, howFound: e.howFound, evidence: ev })
        wroteEdges++
      }

      // The reasons go to the model and to the log. A refusal recorded only in the reply is
      // invisible the moment the run ends: the live stripe.com run logged eleven failed
      // `remember` spans with an empty error field, and nothing anywhere said why.
      span("remember", "write", `${wroteNodes}n/${wroteEdges}e`, {
        ms: 0,
        usd: 0,
        ok: rejections.length === 0,
        error: rejections.length ? summariseRejections(rejections) : undefined,
      })
      return { written: { nodes: wroteNodes, edges: wroteEdges }, rejected: rejections.map((r) => `${r.label}: ${r.reason}`) }
    },
  })

  return { search, fetch: fetchTool, read, remember }
}
