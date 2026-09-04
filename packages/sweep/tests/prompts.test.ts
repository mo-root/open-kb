import { describe, it, expect, afterEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { composePrompt } from "@open-kb/core"
import { RELATIONS, ENTITY_KINDS, CLASSIFY_MAX_OUTPUT_TOKENS, makePrompt } from "../src/sweep.js"

/**
 * The prompts are the product.
 *
 * Every instruction a paid model run receives lives in `prompts/` so it can be
 * read and edited without touching TypeScript. That only stays true if something
 * checks, the four sweep prompts spent their whole life as template literals
 * buried in `sweep.ts` while `prompts/` sat beside them describing an agent that
 * this pipeline never runs, and nothing noticed.
 *
 * These are the checks that would have noticed.
 */

function root(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "prompts", "doctrine"))) return join(dir, "prompts")
    dir = dirname(dir)
  }
  throw new Error("no prompts/")
}

const AGENTS = ["understand", "catalog", "assess", "classify", "triage", "drop-confirm", "listicle"]

describe("the sweep's prompts", () => {
  it.each(AGENTS)("%s composes with its doctrine", (agent) => {
    const composed = composePrompt(agent, join(root(), "agents"), join(root(), "doctrine"))
    expect(composed.length).toBeGreaterThan(200)
    // Placeholders survive composition, they are filled at call time, not here.
    expect(composed).toMatch(/\{\{\w+\}\}/)
  })

  /**
   * The drift this exists to catch, stated plainly: `02-relations.md` opened with
   * "The five relations" for as long as the code had eight, and then eleven. The
   * classifier was being handed a vocabulary list that was missing most of the
   * words it was required to choose from.
   */
  it("documents every relation the code will accept", () => {
    const doc = readFileSync(join(root(), "doctrine", "02-relations.md"), "utf8")
    const undocumented = RELATIONS.filter((r) => r !== "none" && !doc.includes(`**${r}**`))
    expect(undocumented).toEqual([])
  })

  it("documents the escape hatch and what it costs", () => {
    const doc = readFileSync(join(root(), "doctrine", "02-relations.md"), "utf8")
    expect(doc).toContain("**none**")
  })

  it("names every entity kind the classifier must choose between", () => {
    const p = readFileSync(join(root(), "agents", "classify.md"), "utf8")
    const unnamed = ENTITY_KINDS.filter((k) => !p.includes(k))
    expect(unnamed).toEqual([])
  })
})

/**
 * The classify prompt is sent once per host. A measured live run made 740 such
 * calls, and ~75% of its 3.19M input tokens were the same ~13K chars of
 * composed doctrine re-sent every time — breadth doctrine, search craft,
 * reading-the-web narrative, none of which a per-host judge can act on: it
 * fetches nothing and plans nothing. The prompt was trimmed to carry only what
 * one judgement needs. These tests keep the win from silently regressing and
 * keep the trim from cutting the one thing that must never be cut: the full
 * relation vocabulary, because a judge choosing from words it was never given
 * poisons every judgement.
 */
describe("the composed classify prompt", () => {
  const composed = () => composePrompt("classify", join(root(), "agents"), join(root(), "doctrine"))

  it("stays small enough to send 740 times without dominating the bill", () => {
    // Measured 12,996 chars before the trim; ~4K after. The ceiling leaves
    // headroom for wording, not for re-including a doctrine file.
    //
    // Raised 6,000 -> 6,500 for the 734 chars that separate `company` from
    // `product`. The trim took the doctrine out but left the two kinds
    // divided by a single clause, which gemini-3.5-flash did not need and
    // deepseek-v4-flash does: on real fetched front pages the default model
    // called 0/15 vendors a company, and 15/15 with those chars restored.
    // The 734 chars are ~165 input tokens, ~$0.06 on a 2,500-host run at
    // deepseek's $0.14/M — against ~$0.29 for putting the three doctrine
    // files back.
    //
    // Raised 6,500 -> 7,500 for the provenance block and the stance ladder
    // (2026-08-16, ~970 chars): the judge now sees the queries a host arrived
    // by — family, market, platform — and is told to walk the committed
    // relations before reaching for a refusal. On the run that argued for it,
    // 234 of 765 judged hosts left the map as `none` while the judge was
    // never told which market's door each walked in through. ~220 tokens,
    // ~$0.013 per 740-host run. The ceiling still cannot hide a doctrine
    // file: the smallest is 1,779 chars, so re-including one lands past 9,100.
    //
    // Raised 7,500 -> 8,300 for the competitor gate (2026-08-23, ~750 chars;
    // one of the two trims that paid for it had to be given back — the seller
    // boundary below is pinned by its own test, and for a measured reason). A 28-row re-judge of finished stripe.com and
    // figma.com maps found 19 of 27 competitor verdicts wrong, every one
    // inflated and none under-called: things the anchor is an INPUT to
    // (a Figma-to-code plugin), things bought by a different buyer (a
    // consumer wallet beside Stripe), and things overlapping one add-on
    // rather than the core. Moving `adjacent` to the bottom of the ladder a
    // week earlier stopped it being the dumping ground and handed the job
    // straight to `competitor` at rung one, so the remedy is a gate above
    // rung one rather than another reorder. ~180 input tokens against a
    // 1,300-call run at deepseek's $0.14/M is ~$0.033 — on runs that cost
    // $0.44 to $1.06, against the map's most consequential relation.
    //
    // The last ~200 of those chars were bought back by a re-judge of the same
    // 28 rows against the gated prompt and live pages: the first draft moved
    // 13 of 27 off `competitor` but still called a Figma-to-code plugin one,
    // stating the input relationship in its own reasoning while doing it. So
    // disqualifier 1 now names that shape outright ("consumes the anchor's
    // output"), and the competitor rung points back at the gate — the model
    // was reaching the rung and matching "same capability, same buyer"
    // without re-reading a block it had passed six lines earlier.
    expect(composed().length).toBeLessThan(8_300)
  })

  it("still carries the whole relation vocabulary, every word the schema will accept", () => {
    const c = composed()
    const missing = RELATIONS.filter((r) => !c.includes(`**${r}**`))
    expect(missing).toEqual([])
  })

  it("keeps the de-branding warning — ranking market vocabulary is not selling", () => {
    expect(composed()).toContain("RANKS, COMPARES or REVIEWS")
  })

  it("keeps the seller boundary, which is the one the doctrine trim left standing on a clause", () => {
    // HISTORY, because this pin has moved once and the reason matters. The
    // trim (f8fd2ba) left "A vendor is a company; a single named tool or
    // dataset sold on its own is a product" as the only text dividing those two
    // kinds. gemini-3.5-flash held that line unaided; deepseek-v4-flash — the
    // default since 772a9e6 — does not, and every map after it filed vendors as
    // products (stripe-com-202608070005: 1 company, 1,273 products).
    //
    // Restoring the boundary fixed it, and then the boundary itself was
    // removed: `product` is no longer a kind the model may choose, because a
    // front page is product marketing by construction and the choice was a coin
    // flip every downstream consumer immediately re-merged. See CLASSIFY_KINDS
    // in packages/sweep/src/sweep.ts.
    //
    // WHAT STILL HAS TO HOLD is the other half of that paragraph — seller
    // against publisher, directory and community — which is doing the work the
    // measurements credited it with. Dropping it to save 300 chars took
    // payyd.co from directory 8/8 to 2/8 on the same page, and `directory` is
    // what verdict.ts routes on.
    const c = composed()
    expect(c).toContain("does not promote it to a seller")
    expect(c).toContain("Anything that sells into this market is a company")
    // And the prompt must not offer a kind the schema will reject.
    expect(c).not.toContain("is a product")
  })

  it("teaches the writing doctrine: lead with what it IS, why as evidence, no self-praise", () => {
    // The corpus these rules answer: of 740 model-judged entities on the
    // 2026-08-05 brightdata sweep, 81 whats opened with a bare verb or a
    // keyword list instead of saying what the host is, 57 carried the page's
    // self-praise or a vendor-counted number ("premium", "70M+ IPs"), and 274
    // whys spent their first clause restating the what. The description meter
    // measures the what against the page; these sentences tell the judge what
    // the meter will find. Each pin holds one rule.
    const c = composed()
    expect(c).toContain("leads with what the host IS")
    expect(c).toContain("evidence for the relation")
    expect(c).toContain("self-praise")
    expect(c).toContain("padding")
  })

  it("teaches the span contract: verbatim receipts, checked in code, or the what drops", () => {
    // The guarantee's other half lives in rank.ts; this half tells the judge
    // the check exists so it copies instead of paraphrasing. Each pin holds
    // one clause of the contract.
    const c = composed()
    expect(c).toContain("character-for-character")
    expect(c).toContain("literal substring")
    expect(c).toContain("`spans`")
  })

  it("pins the classify output ceiling — sized for the answer plus its receipts", () => {
    // 350 before spans; spans add up to three ~120-char verbatim quotes
    // (~100 output tokens, priced 6x input), so the ceiling grows once, here,
    // deliberately. Note the wire floor in call() is 6,000 either way — this
    // number documents the answer's size, not the reasoning budget.
    expect(CLASSIFY_MAX_OUTPUT_TOKENS).toBe(450)
  })

  it("keeps exactly the placeholders the rank call renders with", () => {
    // render() throws on any mismatch between these and the call-site's vars,
    // so a drift here would fail at runtime, on a paid call. Fail here instead.
    const found = new Set([...composed().matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))
    expect([...found].sort()).toEqual(["anchor", "buyer", "foundBy", "host", "page", "seenIn", "sells"])
  })
})

/**
 * The per-run compose memo. The classify prompt is rendered once per residue
 * host from inside the rank pool, and composing there meant re-reading the
 * same unchanging files for every host a model judged. `makePrompt` composes
 * each agent's template once per run and leaves only the placeholder fill per
 * call — these tests pin that arithmetic with a counting fake, since the real
 * file reads are not cleanly observable from a test.
 */
describe("makePrompt (the per-run compose memo)", () => {
  it("composes an agent's template once for N per-host renders, and still fills per host", () => {
    let compositions = 0
    const prompt = makePrompt((agent) => {
      compositions += 1
      return `judge {{host}} as ${agent}`
    })
    const hosts = Array.from({ length: 40 }, (_, i) => `host${i}.test`)
    const rendered = hosts.map((h) => prompt("classify", { host: h }))
    expect(compositions).toBe(1)
    // The render is the per-host half and must stay per-host: memoising the
    // template can never memoise the fill.
    expect(rendered[0]).toBe("judge host0.test as classify")
    expect(rendered[39]).toBe("judge host39.test as classify")
    expect(new Set(rendered).size).toBe(40)
  })

  it("keeps agents separate — each composes its own template, once", () => {
    const composed: string[] = []
    const prompt = makePrompt((agent) => {
      composed.push(agent)
      return `${agent}: {{x}}`
    })
    prompt("classify", { x: 1 })
    prompt("understand", { x: 2 })
    prompt("classify", { x: 3 })
    prompt("understand", { x: 4 })
    expect(composed).toEqual(["classify", "understand"])
  })

  it("two renderers share nothing — a new run re-reads the disk, so a prompt edit lands next run", () => {
    let compositions = 0
    const compose = () => {
      compositions += 1
      return "{{x}}"
    }
    makePrompt(compose)("classify", { x: 1 })
    makePrompt(compose)("classify", { x: 2 })
    expect(compositions).toBe(2)
  })

  it("the default compose renders the real classify prompt, every placeholder filled", () => {
    const prompt = makePrompt()
    const out = prompt("classify", {
      anchor: "anchor.test",
      sells: "a scraping api",
      buyer: "a data engineer",
      host: "rival.test",
      seenIn: "2",
      foundBy: '  "scraping api alternatives" (plain, market: scraping api)',
      page: "the page text",
    })
    expect(out).toContain("rival.test")
    expect(out).not.toMatch(/\{\{\w+\}\}/)
  })

  /**
   * `promptsRoot` (packages/sweep/src/sweep.ts:136) has three strategies, in
   * order: `OPENKB_PROMPTS_DIR`, the walk from this module, the walk from
   * cwd. The test above exercises the second (the only one that ever ran:
   * `grep -rn OPENKB_PROMPTS_DIR packages/sweep/tests/` before this test
   * matched nothing but the source file itself), which means the first —
   * the one strategy the file's own doctoring comment calls "the only one
   * that works when the prompts are somewhere no walk would guess," i.e.
   * the one a serverless deploy with a nonstandard layout actually needs —
   * had zero coverage on either of its outcomes.
   */
  const ENV_VAR = "OPENKB_PROMPTS_DIR"
  const originalPromptsDir = process.env[ENV_VAR]

  afterEach(() => {
    if (originalPromptsDir === undefined) delete process.env[ENV_VAR]
    else process.env[ENV_VAR] = originalPromptsDir
  })

  it("OPENKB_PROMPTS_DIR set to a real prompts root composes from there, not the walk", () => {
    process.env[ENV_VAR] = root()
    const prompt = makePrompt()
    const out = prompt("classify", {
      anchor: "anchor.test",
      sells: "a scraping api",
      buyer: "a data engineer",
      host: "rival.test",
      seenIn: "2",
      foundBy: '  "scraping api alternatives" (plain, market: scraping api)',
      page: "the page text",
    })
    expect(out).toContain("rival.test")
    expect(out).not.toMatch(/\{\{\w+\}\}/)
  })

  it("OPENKB_PROMPTS_DIR set to a directory with no doctrine/ throws, naming the path", () => {
    process.env[ENV_VAR] = tmpdir()
    const prompt = makePrompt()
    expect(() => prompt("classify", {})).toThrow(
      `OPENKB_PROMPTS_DIR is set to ${tmpdir()}, which has no doctrine/ in it`,
    )
  })
})
