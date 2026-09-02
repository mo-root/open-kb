import { describe, it, expect } from "vitest"
import { ANCHOR, runFixture } from "./fixture.js"

/**
 * `sweep.ts`'s DNS-preflight branch (`resolves()`, `suggest()`, and the
 * "does not resolve" throw around line 2651) had no test anywhere: every
 * existing fixture answers the anchor's own surfaces with 200s, so
 * `pages.length` is never 0 at that checkpoint and the branch is dead code
 * as far as the suite is concerned.
 *
 * `resolves()` is reachable without a real DNS lookup: `blockTheNetwork()`
 * (installed by every `runFixture` call) replaces `dns.promises.lookup` with
 * a throwing stub for the run's whole duration, so inside the fixture
 * `resolves()` always lands in its own catch and returns `false` — the exact
 * "does not resolve" case, with zero network reached. Overriding the
 * anchor's own three surfaces (`llms.txt`, `docs.` subdomain llms.txt, and
 * `/`) to 404 is what gets `pages.length` to 0 in the first place; the
 * subdomain row already 404s by default (absent from `FETCH_TABLE`).
 */
describe("an anchor with nothing readable and no DNS record", () => {
  it("fails by name instead of retrying or spending an unlocker call", async () => {
    await expect(
      runFixture({
        fetchTable: {
          [`https://${ANCHOR}/llms.txt`]: { httpStatus: 404, body: "" },
          [`https://${ANCHOR}/`]: { httpStatus: 404, body: "" },
        },
      }),
    ).rejects.toThrow(`${ANCHOR} does not resolve — there is no such domain.`)
  })

  it("marks that error reader-safe, the way the web layer expects", async () => {
    try {
      await runFixture({
        fetchTable: {
          [`https://${ANCHOR}/llms.txt`]: { httpStatus: 404, body: "" },
          [`https://${ANCHOR}/`]: { httpStatus: 404, body: "" },
        },
      })
      expect.unreachable("expected the run to reject")
    } catch (e) {
      expect((e as Record<symbol, boolean>)[Symbol.for("open-kb.named-fault")]).toBe(true)
    }
  })
})
