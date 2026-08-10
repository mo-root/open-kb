import { afterEach, describe, expect, it } from "vitest"
import { DEMO_ASIDE, DEMO_REFUSAL, DEMO_REPO, isDemo } from "./demo"

/* The flag itself, read the way the app reads it.
   ---------------------------------------------------------------------------
   Worth a file of its own because this one boolean decides whether a public URL
   can spend the owner's money. Everything else in the feature — the 403, the
   runs directory, the notice on the map page — is downstream of it, so a wrong
   answer here is wrong everywhere at once and in the expensive direction. */

const saved = process.env.OPENKB_DEMO

afterEach(() => {
  if (saved === undefined) delete process.env.OPENKB_DEMO
  else process.env.OPENKB_DEMO = saved
})

function withFlag(value: string | undefined): boolean {
  if (value === undefined) delete process.env.OPENKB_DEMO
  else process.env.OPENKB_DEMO = value
  return isDemo()
}

describe("isDemo", () => {
  it("is off when the variable is unset — the default is a working app", () => {
    // The load-bearing case. A clone, a dev server and every existing
    // deployment set nothing, and all three must behave exactly as before.
    expect(withFlag(undefined)).toBe(false)
  })

  it("is on for OPENKB_DEMO=1, which is what the docs tell an operator to set", () => {
    expect(withFlag("1")).toBe(true)
  })

  it.each(["true", "TRUE", "yes", "on", " 1 ", "True"])(
    "is on for %j, because a host that spells it this way meant yes",
    (value) => {
      // Not politeness. Reading `true` as off hands a spending endpoint to
      // someone who believed they had closed it; reading `0` as on costs
      // nothing but a demo. The tolerance runs one way on purpose.
      expect(withFlag(value)).toBe(true)
    },
  )

  it.each(["", "0", "false", "no", "off", "  ", "maybe"])(
    "is off for %j — including the spellings that plainly mean no",
    (value) => {
      // `false` is the one that matters. "Any non-empty string is on" is the
      // obvious implementation and it turns `OPENKB_DEMO=false` into a demo,
      // which is a worse surprise than the one the case above guards.
      expect(withFlag(value)).toBe(false)
    },
  )

  it("is read per call, not captured at import", () => {
    // The bug this pins is the one `ceilingUsd()` in the map route already
    // shipped once: a module-scope `process.env` read is inlined at build time
    // and the guard compiles to a constant. Here the constant would be `false`
    // in an image built without the variable — a deployment that calls itself a
    // demo in the UI and still spends on POST. Flipping the environment between
    // two calls is the only way to see the difference from a test.
    expect(withFlag("1")).toBe(true)
    expect(withFlag(undefined)).toBe(false)
    expect(withFlag("1")).toBe(true)
  })
})

describe("the sentence a refused visitor reads", () => {
  it("says what this is and what to do, and does not claim a fault", () => {
    // The refusal is not an error report and must not read as one: nothing
    // broke, the deployment is doing exactly what it was configured to do.
    expect(DEMO_REFUSAL).toMatch(/read-only demo/i)
    expect(DEMO_REFUSAL).toMatch(/clone/i)
    for (const lie of ["error", "failed", "try again", "temporarily", "coming soon"]) {
      expect(DEMO_REFUSAL.toLowerCase()).not.toContain(lie)
    }
  })

  it("names the real cost rather than hiding behind a policy", () => {
    // "Disabled by configuration" is true and useless. The visitor is owed the
    // actual reason: minutes of wall clock and real money at two providers.
    expect(DEMO_REFUSAL).toMatch(/minutes/i)
    expect(DEMO_REFUSAL).toMatch(/money/i)
  })

  it("points at a repository over https and nothing else", () => {
    expect(DEMO_REPO).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
  })
})

const words = (s: string): number => s.trim().split(/\s+/).length

describe("the line the demo home shows instead of it", () => {
  it("is short enough to be a footnote, which is the whole point of it", () => {
    // The refusal runs to about sixty words and used to be the first thing a
    // stranger read: a paragraph explaining an absence, above a disabled input,
    // on a page whose six finished maps were nowhere in sight. It is still a
    // paragraph, because an API caller who asked for a run is owed one — and
    // this, which sits under the maps instead, is a line.
    expect(words(DEMO_REFUSAL)).toBeGreaterThan(45)
    expect(words(DEMO_ASIDE)).toBeLessThanOrEqual(30)
  })

  it("makes the same two claims the refusal makes, so the two cannot drift", () => {
    // Two strings saying one thing is how a demo tells a visitor something on
    // the page and something else in the network tab. They are allowed to
    // differ in length and in what they ask of the reader — not in the facts.
    for (const s of [DEMO_ASIDE, DEMO_REFUSAL]) {
      expect(s, s).toMatch(/paid for|already paid|real money/i)
      expect(s, s).toMatch(/money/i)
      expect(s, s).toMatch(/minutes|several minutes/i)
    }
  })

  it("claims no fault either, and does not ask for anything back", () => {
    for (const lie of ["error", "failed", "try again", "temporarily", "coming soon", "sorry"]) {
      expect(DEMO_ASIDE.toLowerCase()).not.toContain(lie)
    }
    // The instruction to clone belongs to the link this sits beside, not to the
    // sentence — DemoHome renders them together, and saying it twice is how a
    // quiet line stops being one.
    expect(DEMO_ASIDE.toLowerCase()).not.toContain("clone")
  })
})
