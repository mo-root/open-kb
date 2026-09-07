import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { MockLanguageModelV4 } from "ai/test"
import { composePrompt, type HostCandidate } from "@open-kb/core"
import { MapState, makeHarvestClassify } from "../src/index.js"

/**
 * The seam whose absence let 9c33d76 ship broken: that commit renamed the
 * classify doctrine's provenance slot to {{foundBy}} and updated the sweep's
 * var bag in the same change, while the swarm's makeHarvestClassify kept
 * passing `intents`. render() throws on a missing slot AND on an unused var,
 * so every harvest classify call threw — and judgeHosts absorbs a classify
 * throw as kind "unknown", so a harvest spent its full allowance to produce
 * an all-unknown roster with nothing in the output saying why. Every
 * existing harvest test scripted a fake HarvestClassify, so no test ever
 * pushed the REAL prompts/agents/classify.md through the swarm's bag.
 *
 * This file is that push: the template comes off disk through composePrompt —
 * the same call the orchestrator makes — so the next slot rename breaks HERE,
 * as a thrown render, not in production as a silent all-unknown harvest.
 */

/** Walk up to the repo's prompts/ dir, the way the sweep's prompts.test.ts does. */
function root(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "prompts", "doctrine"))) return join(dir, "prompts")
    dir = dirname(dir)
  }
  throw new Error("no prompts/")
}

const template = () => composePrompt("classify", join(root(), "agents"), join(root(), "doctrine"))

const PAGE =
  "Rival sells a fraud scoring API to online merchants. The platform scores every checkout " +
  "in real time and hands risk teams a review queue."

const ANSWER = {
  name: "Rival",
  kind: "company",
  what: "A fraud scoring vendor selling checkout risk APIs to online merchants.",
  relation: "competitor",
  why: "sells the same capability to the same buyer",
  spans: ["Rival sells a fraud scoring API"],
}

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
}

/** A mock that records the exact text each call carried, answering ANSWER. */
function scripted(): { model: MockLanguageModelV4; seen: string[] } {
  const seen: string[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const text = prompt
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>) : []))
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
      seen.push(text)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ANSWER) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      }
    },
  })
  return { model, seen }
}

const classifyOver = (model: MockLanguageModelV4) =>
  makeHarvestClassify({
    template: template(),
    model,
    pricing: { inUsdPerM: 10, outUsdPerM: 10 },
    map: new MapState("anchor.com"),
  })

describe("makeHarvestClassify over the real composed classify.md", () => {
  it("renders for a harvest-shaped candidate — no road, no intents — and the answer parses", async () => {
    const { model, seen } = scripted()
    // Exactly what harvestTool builds: intents empty, no foundBy — the shape
    // that threw on every call for as long as the bag said `intents`.
    const h: HostCandidate = { host: "rival.example", seenIn: 2, intents: [], titles: [], desc: "" }
    const { out, usd } = await classifyOver(model)(h, PAGE)

    expect(seen).toHaveLength(1)
    const prompt = seen[0]!
    // The doctrine's own provenance header, host and count bound in — the same
    // line the sweep fixture's hostOf() reads back out.
    expect(prompt).toContain("rival.example — how this run found it, 2 queries in all:")
    expect(prompt).toContain(PAGE)
    // Every slot filled: an unfilled {{placeholder}} means render was bypassed,
    // and a thrown render never reaches this line.
    expect(prompt).not.toMatch(/\{\{\w+\}\}/)
    // A bare map's orientation slots say so instead of inventing context.
    expect(prompt).toContain("(not recorded on the map yet)")
    // The road line is honest: no query text existed, and none was invented.
    expect(prompt).toContain("named in a harvest call by this run's investigator (query text not recorded)")

    expect(out).toEqual(ANSWER)
    // (1000 in + 50 out) × $10/M each — the closure's own billing arithmetic.
    expect(usd).toBeCloseTo(0.0105, 6)
  })

  it("passes a recorded road verbatim, and frames bare intents without inventing query text", async () => {
    const road = `  "fraud scoring alternatives" (rival, market: fraud scoring)`
    const withRoad = scripted()
    await classifyOver(withRoad.model)(
      { host: "rival.example", seenIn: 1, intents: [], titles: [], desc: "", foundBy: road },
      PAGE,
    )
    expect(withRoad.seen[0]).toContain(road)

    const intentsOnly = scripted()
    await classifyOver(intentsOnly.model)(
      { host: "second.example", seenIn: 3, intents: ["rival", "pain"], titles: [], desc: "" },
      PAGE,
    )
    // The intents name how the searches were framed; the caveat says the query
    // text itself was never recorded — the honest middle the fix committed to.
    expect(intentsOnly.seen[0]).toContain("surfaced by rival, pain searches this run (query text not recorded)")
  })

  it("bills and reports ok:true on a landed call, and ok:false-then-rethrows on a failed one", async () => {
    // Both branches of the closure's own try/catch (agent.ts's makeHarvestClassify)
    // report through deps.hooks.onModel — but every test above left hooks unset,
    // so `deps.hooks?.onModel?.(...)` short-circuited before ever building the
    // report object, on both the landed AND the failed path. Neither had run once.
    const seen: Array<{ role: string; label: string; ok: boolean; tokensIn: number; tokensOut: number; usd: number }> = []
    const hooks = { onModel: (info: (typeof seen)[number]) => seen.push(info) }

    const { model } = scripted()
    const landed = makeHarvestClassify({ template: template(), model, pricing: { inUsdPerM: 10, outUsdPerM: 10 }, map: new MapState("anchor.com"), hooks })
    const h: HostCandidate = { host: "rival.example", seenIn: 1, intents: [], titles: [], desc: "" }
    await landed(h, PAGE)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ role: "investigator", label: "classify rival.example", ok: true, tokensIn: 1000, tokensOut: 50, usd: 0.0105 })

    const boom = new Error("the classify model API failed")
    const failing = new MockLanguageModelV4({ doGenerate: async () => { throw boom } })
    const crashed = makeHarvestClassify({ template: template(), model: failing, pricing: { inUsdPerM: 10, outUsdPerM: 10 }, map: new MapState("anchor.com"), hooks })
    await expect(crashed(h, PAGE)).rejects.toBe(boom) // the original error, not swallowed
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ role: "investigator", label: "classify rival.example", ok: false, tokensIn: 0, tokensOut: 0, usd: 0 })
  })

  it("turns DeepSeek's reasoning off; every model in the tests above kept the default and never sent the override", async () => {
    // agent.ts's turn loop (oneTurn) carries the identical ternary on the same
    // measured cost (314 hidden tokens, 9.2s vs 4.9s off); this is the harvest
    // classify call's own copy, and nothing above ever set a modelId, so this
    // arm had never run — every prior call here took the `{}` fallback.
    const model = new MockLanguageModelV4({
      modelId: "deepseek/deepseek-chat",
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify(ANSWER) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      }),
    })
    const h: HostCandidate = { host: "rival.example", seenIn: 1, intents: [], titles: [], desc: "" }
    await classifyOver(model)(h, PAGE)

    expect(model.doGenerateCalls[0]!.providerOptions).toEqual({
      openrouter: { reasoning: { enabled: false }, provider: { order: ["parasail", "novita", "siliconflow"], allow_fallbacks: true } },
    })
  })
})
