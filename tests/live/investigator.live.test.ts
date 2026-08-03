import { describe, it, expect } from "vitest"
import { openrouter } from "@openrouter/ai-sdk-provider"
// Relative, not "@open-kb/core" / "@open-kb/providers": the root package.json declares no
// dependency on either workspace package, so a bare specifier from here does not resolve
// (there is nothing to hoist it into root node_modules). Both packages' "exports" map
// unconditionally to "./src/index.ts" anyway — no build step sits between the two forms — so
// this reaches the exact same module a bare import would.
import { EvidenceStore, SpanStream, investigate } from "../../packages/core/src/index.js"
import { brightDataSearch, brightDataFetch } from "../../packages/providers/src/index.js"

const live = process.env.OPENKB_LIVE === "1"

describe.skipIf(!live)("investigator, live", () => {
  it("finds real companies with real citations", async () => {
    const creds = {
      token: process.env.BRIGHTDATA_API_TOKEN!,
      serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
      unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
    }
    const ctx = {
      evidence: new EvidenceStore(),
      spans: new SpanStream(),
      search: brightDataSearch(creds),
      fetch: brightDataFetch(creds),
      runId: "live1",
      agentId: "inv1",
      parentId: null,
      graph: { nodes: new Map(), edges: [] },
    }

    const out = await investigate({
      anchor: "resend.com",
      mission:
        "Find companies selling the same capability: an API developers call to send transactional email from an application. " +
        "Describe that capability to the search engine several different ways rather than naming the anchor.",
      ctx,
      model: openrouter(process.env.OPENKB_MODEL ?? "google/gemini-3-flash-preview"),
      maxSteps: 20,
    })

    expect(out.nodes).toBeGreaterThanOrEqual(3)

    // Every claim must be provable — this is the whole promise.
    for (const n of ctx.graph.nodes.values()) {
      expect(n.evidence.length).toBeGreaterThan(0)
      expect(n.whyHere.length).toBeGreaterThan(20)
      for (const e of n.evidence) expect(ctx.evidence.hasFetched(e.url)).toBe(true)
    }

    console.log(`nodes=${out.nodes} edges=${out.edges} usd=$${out.usd.toFixed(4)}`)
  }, 300_000)
})
