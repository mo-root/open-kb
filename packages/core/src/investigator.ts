import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai"
import { makeTools, type RunContext } from "./tools.js"
import { composePrompt } from "./prompts.js"

export interface InvestigateOptions {
  anchor: string
  mission: string
  ctx: RunContext
  model: LanguageModel
  maxSteps?: number
  agentsDir?: string
  doctrineDir?: string
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
    // the implicit index signature. The alternative — widening `Tools` in tools.ts — would
    // undo a deliberate declaration-emit fix documented there.
    tools: { ...makeTools(ctx) },
    stopWhen: stepCountIs(opts.maxSteps ?? 24),
  })

  const result = await agent.generate({
    prompt: `The map is anchored on: ${anchor}\n\nYour mission: ${mission}\n\nGO.`,
  })

  return {
    summary: result.text,
    nodes: ctx.graph.nodes.size - beforeNodes,
    edges: ctx.graph.edges.length - beforeEdges,
    usd: ctx.spans.totalUsd() - beforeUsd,
  }
}
