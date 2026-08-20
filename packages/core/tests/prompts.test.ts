import { describe, it, expect } from "vitest"
import { readdirSync } from "node:fs"
import { loadPrompt, composePrompt } from "../src/prompts.js"

const DOCTRINE = "prompts/doctrine"
const AGENTS = "prompts/agents"

/** Distinctive text from each doctrine file. If an include is silently dropped, one of these vanishes. */
const FINGERPRINTS: Record<string, string> = {
  "01-the-thesis": "The anchor is the ceiling, not the count",
  "02-relations": "shaper",
  "03-evidence": "A finding you did not record did not happen",
  "04-search-craft": "would a buyer who had never heard of this company type this",
  "05-reading-the-web": "Cost and success do not move together",
  "06-breadth": "The map is the ecosystem, not the shortlist",
}

/**
 * The composed prompt is the agent's whole world. It is loaded at runtime from markdown, so
 * nothing in the type system stops a file from being renamed, mis-declared, or quietly dropped
 * from the includes list, the failure would surface as an agent behaving oddly in production,
 * which is exactly how a previous run researched twelve competitors and recorded none.
 */
describe("prompt files", () => {
  const doctrineFiles = readdirSync(DOCTRINE)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))

  it("has doctrine files on disk", () => {
    expect(doctrineFiles.length).toBeGreaterThan(0)
  })

  it("every doctrine file declares the identity its filename claims", () => {
    for (const name of doctrineFiles) {
      const p = loadPrompt(name, DOCTRINE)
      expect(p.frontmatter.doctrine, `${name}.md frontmatter`).toBe(name)
      expect(p.body.length, `${name}.md body`).toBeGreaterThan(200)
    }
  })

  it("throws rather than silently loading a prompt whose declared name disagrees", () => {
    // The identity guard is the only thing standing between a rename and an agent
    // running a prompt nobody thinks it runs.
    expect(() => loadPrompt("01-the-thesis", AGENTS)).toThrow()
  })

  it("every name in the investigator's includes resolves to a real doctrine file", () => {
    const agent = loadPrompt("investigator", AGENTS)
    const includes = (agent.frontmatter.includes ?? "")
      .replace(/[[\]]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    expect(includes.length).toBeGreaterThan(0)
    for (const name of includes) {
      expect(doctrineFiles, `includes names "${name}"`).toContain(name)
    }
  })

  it("the composed prompt carries text from every file it includes", () => {
    const composed = composePrompt("investigator", AGENTS, DOCTRINE)
    for (const [file, fingerprint] of Object.entries(FINGERPRINTS)) {
      expect(composed, `${file} missing from composed prompt`).toContain(fingerprint)
    }
  })

  it("the composed prompt asks for an ecosystem rather than a list of rivals", () => {
    // The other live failure: four nodes, all of kind `company`, joined by six `competitor`
    // edges and nothing else. The doctrine that answers it is the easiest kind of file to drop
    // from an includes list, and nothing in the type system would notice.
    const composed = composePrompt("investigator", AGENTS, DOCTRINE)
    expect(composed).toContain("The map is the ecosystem, not the shortlist")
    expect(composed).toContain("Communities are first-class")
    expect(composed).toContain("One relation type is a suspicious map")
  })

  it("the composed prompt states that recording is the job", () => {
    // This assertion exists because of a live failure: the agent researched twelve real
    // competitors, recorded none, and returned an essay. Emphasis is the fix, and this
    // pins the sentence that carries it.
    const composed = composePrompt("investigator", AGENTS, DOCTRINE)
    expect(composed).toContain("A finding you did not record did not happen")
    expect(composed).toContain("Recording is the job")
  })

  it("stays within a size a model will actually read", () => {
    const composed = composePrompt("investigator", AGENTS, DOCTRINE)
    // Every line competes with every other for attention. Length is emphasis: the live
    // failure happened partly because search guidance was long and recording was one line.
    expect(composed.length).toBeGreaterThan(4_000)
    // Raised from 20,000 once, deliberately, to admit the section telling the agent a search
    // result is citable evidence. That one passage is worth its length: without it a measured
    // run saw 91 companies and recorded 14, because it believed only a page it had opened could
    // be cited and it had budget to open thirteen. Redundancy in the breadth file was trimmed
    // first; this is what remained. Raise it again only for something that earns as much.
    //
    // Raised again, to 23,000, for the channel relations, `covers`, `lists`, `discusses`. The
    // vocabulary described commercial stance only, so of 438 hosts on a measured run 144 came
    // back unplaceable: every publication, directory and forum, 37% of the map, dropped for want
    // of a word. Recovering it clears the bar the previous raise set. Duplication that the new
    // vocabulary made redundant was trimmed out of 05 and 06 first, as before.
    //
    // Raised again, to 24,000, for `adjacent`. An audit of one run's competitor verdicts found
    // 27% were a company that sells into the anchor's world but was never on its shortlist — a
    // customer-support platform, a backup vendor, a WebRTC consultancy — forced into competitor
    // because the ladder had no other word for "real business here, not a rival". Same rule as
    // both prior raises: it earns its length or it does not get raised for it.
    expect(composed.length).toBeLessThan(24_000)
  })
})

describe("query-families doctrine", () => {
  it("catalog includes the families doctrine and keeps its placeholder set", () => {
    const p = loadPrompt("catalog", "prompts/agents")
    expect(p.body).toContain("plain")
    expect(p.body).toContain("debranded")
    expect(p.body).toContain("branded")
    // the catalog call's render keys — sweep.ts passes exactly these.
    // `knownPlayers` joined 2026-08-16: the collision shape asked the model to
    // cross names it knows while the call carried none of the names the run
    // had harvested.
    for (const k of ["anchor", "target", "product", "productDoes", "market", "centrality", "sells", "buyer", "siblings", "coinages", "knownPlayers"]) {
      expect(p.body).toContain(`{{${k}}}`)
    }
  })
  it("assess gained the family table placeholders", () => {
    const p = loadPrompt("assess", "prompts/agents")
    expect(p.body).toContain("{{families}}")
    expect(p.body).toContain("{{reserve}}")
  })
})
