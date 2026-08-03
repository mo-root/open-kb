import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai"
import { makeTools, anchorNode, type RunContext } from "./tools.js"
import { composePrompt } from "./prompts.js"

export interface InvestigateOptions {
  anchor: string
  mission: string
  ctx: RunContext
  model: LanguageModel
  maxSteps?: number
  agentsDir?: string
  doctrineDir?: string
  /**
   * What the model costs, in dollars per million tokens. Supplied by the caller because the
   * engine must not know which vendor it is talking to. Omit it and token cost is reported as
   * zero, with an error on every model span saying so, since a silently free run is worse
   * than an obviously unpriced one.
   */
  pricing?: { inputPerMTok: number; outputPerMTok: number }
  /** Model identifier for the span log. Never used to make a decision. */
  modelName?: string
}

export interface InvestigateResult {
  summary: string
  nodes: number
  edges: number
  usd: number
}

/**
 * One agent, one mission, its own context. It writes findings as it goes, so a run that
 * dies partway still leaves everything the agent actually proved.
 *
 * Everything is counted as a delta against the context it was handed, never as an
 * absolute: several investigators share one graph and one span stream, so an absolute
 * total would credit this agent with work another one did.
 */
export async function investigate(opts: InvestigateOptions): Promise<InvestigateResult> {
  const { anchor, mission, ctx, model } = opts

  // The anchor goes on the map before the agent runs. Every edge the agent writes is stated
  // against it, so without it `from: <the anchor>` cannot resolve and the whole map hangs off
  // an endpoint that is missing by construction, which is what a live run produced.
  //
  // Seeded before the counters below are read, on purpose: the anchor is where the map starts,
  // not something this agent found, and counting it would credit the agent with a node it was
  // handed. Guarded, because several investigators share one graph and only the first arrival
  // seeds it, an unguarded write would also discard citations a previous agent proved against
  // the anchor's own id.
  const seed = anchorNode(anchor)
  if (!ctx.graph.nodes.has(seed.id)) ctx.graph.nodes.set(seed.id, seed)

  const beforeNodes = ctx.graph.nodes.size
  const beforeEdges = ctx.graph.edges.length
  const beforeUsd = ctx.spans.totalUsd()

  const instructions = composePrompt(
    "investigator",
    opts.agentsDir ?? "prompts/agents",
    opts.doctrineDir ?? "prompts/doctrine",
  )

  const agent = new ToolLoopAgent({
    model,
    instructions,
    // Spread rather than pass `makeTools(ctx)` straight through. `Tools` is an interface,
    // and an interface has no implicit index signature, so it is not assignable to the
    // SDK's `ToolSet` (`Record<string, Tool>`) even though its every member is a `Tool`.
    // Spreading into a fresh object literal gives an inferred object type, which does get
    // the implicit index signature. The alternative, widening `Tools` in tools.ts, would
    // undo a deliberate declaration-emit fix documented there.
    tools: { ...makeTools(ctx) },
    stopWhen: stepCountIs(opts.maxSteps ?? 24),
  })

  const startedAt = Date.now()
  const result = await agent.generate({
    prompt: `The map is anchored on: ${anchor}\n\nYour mission: ${mission}\n\nGO.`,
  })

  // Emit one span per model turn. Without these the run's cost is provider-only, every SERP
  // call and page fetch is accounted for and not a single token is, which makes a spend target
  // unmeasurable rather than merely approximate. Priced from a rate the caller supplies, because
  // the engine must not know which vendor or model it is talking to.
  const rate = opts.pricing
  const steps = result.steps ?? []
  const perStepMs = steps.length ? Math.round((Date.now() - startedAt) / steps.length) : 0
  let turn = 0
  for (const step of steps) {
    turn++
    const inTok = step.usage?.inputTokens ?? 0
    const outTok = step.usage?.outputTokens ?? 0
    const usd = rate ? (inTok / 1e6) * rate.inputPerMTok + (outTok / 1e6) * rate.outputPerMTok : 0
    ctx.spans.emit({
      runId: ctx.runId,
      agentId: ctx.agentId,
      parentId: ctx.parentId,
      kind: "model",
      name: opts.modelName ?? "model",
      argsDigest: `turn ${turn} of ${steps.length}`,
      ms: perStepMs,
      ok: true,
      tokensIn: inTok,
      tokensOut: outTok,
      usd,
      // A run priced at zero because nobody supplied a rate must not look like a free run.
      error: rate ? undefined : "no model pricing supplied — token cost not counted",
    })
  }

  return {
    summary: result.text,
    nodes: ctx.graph.nodes.size - beforeNodes,
    edges: ctx.graph.edges.length - beforeEdges,
    usd: ctx.spans.totalUsd() - beforeUsd,
  }
}
