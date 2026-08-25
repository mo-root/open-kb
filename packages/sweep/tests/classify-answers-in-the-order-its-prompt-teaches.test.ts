import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runFixture } from "./fixture.js"

/**
 * MEASURED: `reasoning` filled on only 26% of
 * classified entities (202 of 776, cursor.com run) against 85% for
 * `relationSpan`, the schema's other optional field. classify.md:65-66 has
 * always told the model to answer `name, kind, what, relation, reasoning,
 * why, spans, relationSpan` — decisive fact first, evidence after — but the
 * zod schema declared `reasoning` AFTER `why` and `spans`, contradicting its
 * own prompt. Structured-output decoding fills an object in schema
 * declaration order, not prompt-mention order, so the model was asked for
 * `reasoning` only once it had already spent its output on two required
 * fields — the exact spot an optional field goes unfilled. This test pins
 * the schema back to the order its own prompt teaches, so a future edit that
 * reintroduces the mismatch fails here rather than being found again on a
 * paid run.
 */
describe("classify's schema answers in the order classify.md teaches", () => {
  it("declares reasoning right after relation, before why and spans", async () => {
    const h = await runFixture()
    const classify = h.calls.find((c) => c.phase === "classify")
    expect(classify).toBeDefined()
    expect(classify!.schemaKeys).toEqual([
      "name",
      "kind",
      "what",
      "relation",
      "reasoning",
      "why",
      "spans",
      "relationSpan",
    ])
  })

  it("matches the order classify.md's own 'Answer with' line promises", () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const doc = readFileSync(join(dir, "..", "..", "..", "prompts", "agents", "classify.md"), "utf8")
    const line = /^Answer with: (.+?)\.$/ms.exec(doc)?.[1]
    expect(line).toBeDefined()
    const fields = [...line!.matchAll(/`(\w+)`/g)].map((m) => m[1])
    expect(fields).toEqual(["name", "kind", "what", "relation", "reasoning", "why", "spans", "relationSpan"])
  })
})
