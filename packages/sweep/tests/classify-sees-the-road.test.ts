import { describe, expect, it } from "vitest"
import { runFixture, HOSTS } from "./fixture.js"

/**
 * The judge is handed the road a host arrived by — the query texts, each with
 * its family, market and platform — not just a count of them.
 *
 * The join existed at report time ("attribute every entity to the markets
 * whose queries surfaced it") and was withheld from the one model that could
 * use it as evidence. On the run that surfaced this, 234 of 765 judged hosts
 * left the map as `none` while the judge was never told which market's door
 * each of them walked in through.
 */
describe("classify sees how the run found the host", () => {
  it("renders the surfacing queries with family and market into the classify prompt", async () => {
    const h = await runFixture()
    const classify = h.calls.filter((c) => c.phase === "classify")
    expect(classify.length).toBeGreaterThan(0)

    const forGrepstack = classify.find((c) => c.subject === HOSTS.grepstack)
    expect(forGrepstack, "a classify call for grepstack").toBeDefined()
    const p = forGrepstack!.prompt
    expect(p).toContain("how this run found it")
    // The fixture surfaces grepstack through the plain family's opener, whose
    // market is stamped by the catalog call that dealt it.
    expect(p).toMatch(/"[^"]+" \((plain|debranded|branded|rival)/)
    expect(p).toContain("market: ")
    // The guidance that makes the block usable rides with it.
    expect(p).toContain("the page outranks the query when they disagree")
  })

  it("caps the road at three queries and says how many more there were", async () => {
    const h = await runFixture()
    // Hosts seen in >3 queries get the ellipsis line rather than the full list.
    const busy = h.calls.filter(
      (c) => c.phase === "classify" && /…and \d+ more/.test(c.prompt),
    )
    // The fixture's SERP table surfaces grepstack in 4+ queries, so at least
    // one judged host crosses the cap.
    expect(busy.length).toBeGreaterThan(0)
  })
})
