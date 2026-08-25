import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * FOUR SCRIPTS SNIFF A RUN FILE'S SHAPE THE SAME WAY, AND SAY SO IN COMMENTS
 * THAT NOTHING ENFORCES.
 *
 * `scripts/audit.ts`, `scripts/diff-runs.ts`, `scripts/read.ts` and
 * `scripts/calibrate-kernel.ts` each parse a `runs/*.json` file and accept
 * either shape on disk — top-level `entities` (sweep, swarm) or the kernel
 * wrapper's `result.entities` — refusing anything else with the identical
 * sentence: "no entities at the top level or under result — not a run file
 * this reads". `read.ts`'s own comment names the contract out loud
 * ("diff-runs.ts and audit.ts both refuse by name at this point, and this is
 * their sentence"), which is a claim about four files agreeing, made in one
 * of them, checked by none of them. An edit to any one copy — a typo, a
 * rewording, a dash swapped for a hyphen — silently breaks the doctrine while
 * every file still refuses correctly on its own; nothing short of grepping
 * all four by hand would notice. Source-string assertions rather than an
 * import: all four now guard their CLI body behind an `invokedDirectly` check
 * (calibrate-kernel.ts was the last to get one) and could in principle be
 * imported for this one sentence, but the check itself is a string embedded
 * in each file's own argv-handling branch — importing would still mean
 * exercising `usage()`/`process.exit` paths just to reach it, which is more
 * than a source-string assertion needs. Same reason
 * `tests/the-cli-entrypoints-have-a-dollar-bound.test.ts` checks its three
 * entrypoints by source text instead of by running them.
 *
 * `scripts/bench.ts` recognises the same two shapes but is deliberately NOT
 * in this set: it is a bulk scanner over every file in `runs/`, one bad file
 * must not stop the scan, so it returns a `Skipped` row naming the offending
 * file's keys instead of throwing, and its message is worded for that —
 * checked below to guard against the two drifting into each other by a
 * future edit that makes bench.ts throw the shared sentence too.
 */

const SENTENCE = "no entities at the top level or under result — not a run file this reads"

const source = (name: string) => readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), "utf8")

describe("four run-file readers refuse an unrecognised shape with one sentence", () => {
  it.each(["audit.ts", "diff-runs.ts", "read.ts", "calibrate-kernel.ts"])("%s carries the shared refusal, verbatim", (name) => {
    expect(source(name)).toContain(SENTENCE)
  })

  it("bench.ts stays out of the shared sentence — it skips a bad file rather than refusing the whole run", () => {
    const src = source("bench.ts")
    expect(src).not.toContain(SENTENCE)
    expect(src).toContain("no entities at the top level or under result (keys:")
  })
})
