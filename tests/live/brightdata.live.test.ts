import { describe, it, expect } from "vitest"
// Relative, not "@open-kb/providers" / "@open-kb/core": the root package.json declares no
// dependency on either workspace package, so a bare specifier from here does not resolve
// (there is nothing to hoist it into root node_modules). Both packages' "exports" map
// unconditionally to "./src/index.ts" anyway — no build step sits between the two forms — so
// this reaches the exact same module a bare import would.
import { brightDataSearch, brightDataFetch } from "../../packages/providers/src/index.js"
import { sniff } from "../../packages/core/src/index.js"

const live = process.env.OPENKB_LIVE === "1"

describe.skipIf(!live)("brightdata live", () => {
  const creds = {
    token: process.env.BRIGHTDATA_API_TOKEN!,
    serpZone: process.env.BRIGHTDATA_SERP_ZONE!,
    unlockerZone: process.env.BRIGHTDATA_UNLOCKER_ZONE!,
  }

  it("returns organic results for a real query", async () => {
    const [r] = await brightDataSearch(creds).search(["anti-bot bypass api"])
    expect(r!.ok).toBe(true)
    expect(r!.hits.length).toBeGreaterThan(3)
  }, 60_000)

  it("reads a real machine-readable summary with a free direct fetch", async () => {
    const raw = await brightDataFetch(creds).get("https://stripe.com/llms.txt", "direct")
    const s = sniff(raw)
    expect(s.status).toBe("found")
    expect(s.text.length).toBeGreaterThan(10_000)
    expect(raw.usd).toBe(0)
  }, 60_000)

  it("detects the measured silent block on a hostile site", async () => {
    const raw = await brightDataFetch(creds).get("https://docs.stripe.com/radar", "unlocked")
    const s = sniff(raw)
    expect(["blocked", "not_found"]).toContain(s.status)
  }, 120_000)
})
