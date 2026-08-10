import { describe, it, expect } from "vitest"
import { BreakerTable } from "../src/breaker.js"

// The reason strings below are the fetch-failure vocabulary the swarm's fetch
// tool emits (empty-200, content-mismatch, thin-render — the design's names for
// what sniff detects). The table never imports them: reasons are opaque text it
// repeats back, so the vocabulary can grow without touching this module.

describe("BreakerTable", () => {
  it("ships empty: nothing is asserted about any site until this run watches it fail", () => {
    const t = new BreakerTable()
    const r = t.open("stripe.com", "unlock")
    expect(r.open).toBe(false)
    expect(r.because).toBeUndefined()
  })

  it("one strike is not enough", () => {
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    expect(t.open("stripe.com", "unlock").open).toBe(false)
  })

  it("two strikes open the pair, and the sentence names host, mode, and reason", () => {
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "empty-200")
    const r = t.open("stripe.com", "unlock")
    expect(r.open).toBe(true)
    expect(r.because).toBe("stripe.com refuses the unlock tier this run: two empty-200 responses")
  })

  it("mixed reasons still name the last one", () => {
    const t = new BreakerTable()
    t.strike("adyen.com", "direct", "content-mismatch")
    t.strike("adyen.com", "direct", "thin-render")
    const r = t.open("adyen.com", "direct")
    expect(r.open).toBe(true)
    expect(r.because).toBe("adyen.com refuses the direct tier this run: 2 strikes, most recently thin-render")
  })

  it("keys on {host, mode}: the unlock breaker leaves the free GET alone", () => {
    // The measured asymmetry this exists to reproduce: unlock refused twice
    // while a plain GET still serves 65KB from the same host.
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "empty-200")
    expect(t.open("stripe.com", "direct").open).toBe(false)
    expect(t.open("stripe.com", "browser").open).toBe(false)
  })

  it("keys on {host, mode}: another host's failures are its own", () => {
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "empty-200")
    expect(t.open("adyen.com", "unlock").open).toBe(false)
  })

  it("strikes on different modes of one host never pool into an open breaker", () => {
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "direct", "timeout")
    expect(t.open("stripe.com", "unlock").open).toBe(false)
    expect(t.open("stripe.com", "direct").open).toBe(false)
  })

  it("strike reports the running count and whether the pair just opened", () => {
    const t = new BreakerTable()
    expect(t.strike("stripe.com", "unlock", "empty-200")).toEqual({ strikes: 1, open: false })
    expect(t.strike("stripe.com", "unlock", "empty-200")).toEqual({ strikes: 2, open: true })
  })

  it("stays open past two strikes and keeps counting honestly", () => {
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "empty-200")
    const r = t.open("stripe.com", "unlock")
    expect(r.open).toBe(true)
    expect(r.because).toBe("stripe.com refuses the unlock tier this run: three empty-200 responses")
  })

  it("a later different reason updates the sentence to the most recent one", () => {
    const t = new BreakerTable()
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "empty-200")
    t.strike("stripe.com", "unlock", "thin-render")
    const r = t.open("stripe.com", "unlock")
    expect(r.because).toBe("stripe.com refuses the unlock tier this run: 3 strikes, most recently thin-render")
  })
})
