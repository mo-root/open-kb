import { describe, it, expect } from "vitest"
import { ANCHOR, runFixture } from "./fixture.js"

/**
 * sweep.ts's final "could not read" throw (line 2704) had no test anywhere,
 * and — until this file's `dnsResolves` fixture option existed — could not
 * have one: every `runFixture` call blocks `dns.promises.lookup` so `resolves()`
 * (sweep.ts:1388) always returns `false`, which routes every unreadable anchor
 * into the OTHER throw, "does not resolve" (line 2651, covered by
 * an-anchor-that-does-not-resolve-fails-by-name.test.ts). The DNS-preflight
 * branch's own test file, added for SELF-253, named this exact gap: "the
 * companion branch... needs dns.promises.lookup to resolve inside the same run
 * that blockTheNetwork() makes throw, which the fixture has no seam for... Left
 * for a fire that wants to build that seam on purpose." SELF-255 builds it.
 *
 * With `dnsResolves: true`, `resolves()` returns `true` — the DNS-preflight
 * throw is skipped — so the run falls through to the 2-second retry and then
 * the unlocked fetch, both routed to the same failure by the fetch table
 * (`unlocked` is omitted, which answers both fetch modes identically, per
 * FixtureOptions' own doc comment). Only once all three attempts still find
 * nothing does sweep.ts throw the generic "could not read" error — the message
 * a genuinely temporary block or network blip produces, as opposed to a typo.
 *
 * Unlike the DNS-preflight error, this one is NOT marked reader-safe
 * (`Symbol.for("open-kb.named-fault")` — compare sweep.ts:2664-2670, which has
 * no equivalent around line 2704): a real deployment would show this one as a
 * generic "quote ref" crash rather than the message asserted below. That is
 * this test's honest scope — what the engine does — not a claim that the web
 * layer surfaces it; changing that marking is a separate decision this fire
 * does not make.
 */
describe("an anchor that resolves but has nothing readable anywhere", () => {
  it("fails with the generic retry-worth-it message, not the DNS one", async () => {
    await expect(
      runFixture({
        dnsResolves: true,
        fetchTable: {
          [`https://${ANCHOR}/llms.txt`]: { httpStatus: 404, body: "" },
          [`https://${ANCHOR}/`]: { httpStatus: 404, body: "" },
        },
      }),
    ).rejects.toThrow(
      `could not read ${ANCHOR}. Tried https://${ANCHOR}/llms.txt, https://docs.${ANCHOR}/llms.txt, https://${ANCHOR}/ directly`,
    )
  })

  it("does not mark that error reader-safe — it is not the DNS case", async () => {
    try {
      await runFixture({
        dnsResolves: true,
        fetchTable: {
          [`https://${ANCHOR}/llms.txt`]: { httpStatus: 404, body: "" },
          [`https://${ANCHOR}/`]: { httpStatus: 404, body: "" },
        },
      })
      expect.unreachable("expected the run to reject")
    } catch (e) {
      expect((e as Record<symbol, boolean>)[Symbol.for("open-kb.named-fault")]).toBeUndefined()
    }
  })
})
