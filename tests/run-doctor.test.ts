import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { diagnose } from "../scripts/run-doctor.js"

/**
 * The doctor reads shapes this repo does not control: 45 run files written by
 * a dozen versions of the engine, most of them predating most report fields.
 * It is also now imported by `scripts/sweep.ts` and runs at the end of every
 * CLI run, where a throw would land after the map was written and read as a
 * failed run.
 *
 * So the contract is narrow and worth pinning: never throw, and never let an
 * absent field pass for a measured zero.
 */

const runsDir = join(process.cwd(), "runs")
const files = (() => {
  try { return readdirSync(runsDir).filter((f) => f.startsWith("sweep-") && f.endsWith(".json")) }
  catch { return [] }
})()

describe("run-doctor over the runs on disk", () => {
  // `runs/` is gitignored — a clean checkout (this branch's own sandboxed
  // overnight fires included) has none, and no fixture can stand in: every
  // assertion below is a count taken from whatever the real corpus happens to
  // contain. Ungated, this `it` failed unconditionally on such a checkout
  // ("expected 0 to be greater than 20") — not a defect in the doctor, just
  // the same absent-`runs/` gap `scripts/check-skips.mjs` already gates three
  // other suites for, minus the gate. Skipping only when the directory is
  // fully empty keeps the >20 floor meaningful: a checkout with 1-20 files
  // still fails it, on purpose (see the comment at that assertion).
  it.skipIf(files.length === 0)("survives every run file, across every engine version that wrote one", () => {
    // Without this the whole suite passes on an empty runs/ and proves
    // nothing — the exact vacuity this branch removed from four tests.
    expect(files.length, "run files to diagnose").toBeGreaterThan(20)

    let withGaps = 0
    for (const f of files) {
      const j = JSON.parse(readFileSync(join(runsDir, f), "utf8"))
      const notes = diagnose(j.report ?? {}, j.stats ?? {})
      expect(notes.length, `${f} produced no findings at all`).toBeGreaterThan(0)
      for (const n of notes) {
        expect(["gap", "watch", "ok", "unknown"]).toContain(n.level)
        expect(n.what.length, `${f}: a finding with no name`).toBeGreaterThan(0)
        expect(n.detail.length, `${f}: ${n.what} with no detail`).toBeGreaterThan(0)
      }
      if (notes.some((n) => n.level === "gap")) withGaps++
    }
    // The corpus really does contain gaps, so "never throws" is not being
    // demonstrated on a set of runs the doctor had nothing to say about.
    expect(withGaps, "runs with at least one gap").toBeGreaterThan(0)
  })

  it("calls an absent field unknown, not clean", () => {
    // The oldest runs carry none of this week's fields. Every one of those
    // has to come back `unknown`; a `gap` would be inventing a defect and an
    // `ok` would be inventing a measurement.
    const notes = diagnose({}, {})
    expect(notes.length).toBeGreaterThan(4)
    expect(notes.every((n) => n.level === "unknown")).toBe(true)
    for (const n of notes) expect(n.detail).toContain("not recorded")
  })

  it("separates a stage that ran and found nothing from one that never ran", () => {
    // The distinction the whole script is built on, and the one the listicle
    // guard added to the engine: identical zeros, opposite meanings.
    const looked = diagnose({ listicleHarvest: { starved: false, rowsScanned: 0, vendorsFound: 0, queriesFired: 0 } }, {})
    const starved = diagnose({ listicleHarvest: { starved: true, rowsScanned: 0, vendorsFound: 0, queriesFired: 0 } }, {})

    const lookedNote = looked.find((n) => n.what === "listicle harvest")!
    const starvedNote = starved.find((n) => n.what === "listicle harvest")!
    expect(lookedNote.level).toBe("ok")
    expect(starvedNote.level).toBe("watch")
    expect(starvedNote.detail).toContain("ceiling")
  })

  it("gives second look a note even when it ran and asked nobody", () => {
    // `sl.asked === 0` (every host placed on the first pass) used to fall
    // through every branch — not `ok`, not `unknown`, no note printed at
    // all, unlike every other zero-but-recorded case in this file.
    const notes = diagnose({ secondLook: { asked: 0, rescued: 0, failed: 0 } }, {})
    const note = notes.find((n) => n.what === "second look")
    expect(note).toBeDefined()
    expect(note!.level).toBe("ok")
    expect(note!.detail).toContain("0 asked")
  })

  it("computes the second look's own fail rate, not just its asked:0 escape hatch", () => {
    // The `!sl.asked` branch just above (line 78) has its own test; the branch
    // it falls out of when asked is nonzero — `failRate = (sl.failed ?? 0) /
    // sl.asked`, labelled against the file's own 0.5 threshold — had zero
    // synthetic-fixture coverage of its own. SELF-310's commit message named
    // this exact branch, alongside kernel's snippet-judged share and recall's
    // answer-key overlap, as left for a later fire once the triage-skip
    // branch (the same shape, one function up) got this same treatment.

    // 1. Above the norm (35% get no page, over 28 runs) and past the 0.5
    // threshold — watch.
    const over = diagnose({ secondLook: { asked: 10, rescued: 3, failed: 6 } }, {}).find(
      (n) => n.what === "second look",
    )!
    expect(over.level).toBe("watch")
    expect(over.detail).toBe("10 asked, 3 rescued, 6 got no page (60%)")

    // 2. Comfortably under the threshold — ok.
    const under = diagnose({ secondLook: { asked: 10, rescued: 6, failed: 3 } }, {}).find(
      (n) => n.what === "second look",
    )!
    expect(under.level).toBe("ok")
    expect(under.detail).toBe("10 asked, 6 rescued, 3 got no page (30%)")

    // 3. Exactly at the boundary — the check is `failRate > 0.5`, so a tie
    // must read `ok`, not `watch`. Pins the boundary rather than a value
    // comfortably past it.
    const boundary = diagnose({ secondLook: { asked: 10, rescued: 5, failed: 5 } }, {}).find(
      (n) => n.what === "second look",
    )!
    expect(boundary.level).toBe("ok")
    expect(boundary.detail).toBe("10 asked, 5 rescued, 5 got no page (50%)")

    // 4. `failed` absent rather than 0 — a run predating this field, still
    // with hosts asked. Mutation-checked which `?? 0` this actually pins:
    // the one inside `failRate` is inert (`undefined / asked` is NaN, and
    // `NaN > 0.5` is already false, so the level lands on `ok` with or
    // without it) — it is the DETAIL template's own two `sl.failed ?? 0`
    // uses that matter, the same "absent must not print as NaN%" trap this
    // file's triage-skip branch hit once already (see its comment ~line 132).
    // Removing either one from the detail template fails this assertion.
    const noFailedField = diagnose({ secondLook: { asked: 10, rescued: 8 } }, {}).find(
      (n) => n.what === "second look",
    )!
    expect(noFailedField.level).toBe("ok")
    expect(noFailedField.detail).toBe("10 asked, 8 rescued, 0 got no page (0%)")
  })

  it("gives triage skip a clean note when the run found no hosts at all, not NaN%", () => {
    // `t.hosts === 0` (a dead search, nothing to triage) used to compute
    // `t.skipped / t.hosts` as 0/0 = NaN and print the literal text
    // "(NaN%)" in the detail — the same zero-that-means-two-things trap the
    // second-look fix above exists to catch, just visible garbage instead
    // of a missing note.
    const notes = diagnose({ triage: { hosts: 0, skipped: 0, kept: 0, calls: 0, failed: 0 } }, {})
    const note = notes.find((n) => n.what === "triage skip")
    expect(note).toBeDefined()
    expect(note!.level).toBe("ok")
    expect(note!.detail).not.toContain("NaN")
    expect(note!.detail).toContain("0/0")
  })

  it("computes the triage skip rate itself, not just its hosts:0 escape hatch", () => {
    // The `t.hosts === 0` branch just above has its own test; the branch it
    // falls out of when hosts is nonzero — `rate = t.skipped / t.hosts`, then
    // labelled against the file's own 0.14 threshold — had never run under a
    // synthetic fixture. Every other run-doctor.test.ts case for this file's
    // watch/ok thresholds (clock model, snippet-judged, linking) pins its own
    // boundary; this one, the FIRST such threshold in the file (line ~145),
    // did not yet have one.

    // 1. Above the norm's own ceiling (13.3%) — watch, and the "failed open"
    // clause appended to the detail when t.failed is nonzero.
    const over = diagnose({ triage: { hosts: 100, skipped: 20, calls: 4, failed: 2 } }, {}).find(
      (n) => n.what === "triage skip",
    )!
    expect(over.level).toBe("watch")
    expect(over.detail).toBe("20/100 (20.0%) in 4 calls, 2 failed open")

    // 2. Comfortably inside the norm — ok, and no "failed open" clause when
    // t.failed is 0 (falsy, not just absent).
    const under = diagnose({ triage: { hosts: 100, skipped: 10, calls: 4, failed: 0 } }, {}).find(
      (n) => n.what === "triage skip",
    )!
    expect(under.level).toBe("ok")
    expect(under.detail).toBe("10/100 (10.0%) in 4 calls")

    // 3. Exactly at the threshold — the check is `rate > 0.14`, and the
    // threshold sits at 0.14 rather than the norm's 0.13 ceiling specifically
    // so a run defining that ceiling (13.3%) does not flag itself (see the
    // comment on this branch in run-doctor.ts). 14/100 must read `ok`.
    const boundary = diagnose({ triage: { hosts: 100, skipped: 14, calls: 4, failed: 0 } }, {}).find(
      (n) => n.what === "triage skip",
    )!
    expect(boundary.level).toBe("ok")
    expect(boundary.detail).toBe("14/100 (14.0%) in 4 calls")
  })

  it("computes the kernel's own snippet-judged share, not just that report.kernel is present", () => {
    // SELF-310's commit named three branches left in the same shape as the
    // triage-skip branch it fixed: computed only inside the corpus-gated
    // "survives every run file" test, no fixture test of their own —
    // second-look's failRate (closed by SELF-312), kernel's snippet-judged
    // share, and recall's answer-key overlap. This closes the second.

    // 1. Above the norm's own ceiling (15.6%) and past the 0.16 threshold —
    // watch. The comment on this branch in run-doctor.ts explains the 0.16
    // vs. 0.156 gap the same way the triage-skip branch explains its own:
    // a run defining the ceiling must not flag itself.
    const over = diagnose({ kernel: { modelJudged: 80, serpJudged: 20 } }, {}).find(
      (n) => n.what === "snippet-judged",
    )!
    expect(over.level).toBe("watch")
    expect(over.detail).toBe("20/100 hosts (20.0%) judged from a snippet, not a page")

    // 2. Comfortably under the threshold — ok.
    const under = diagnose({ kernel: { modelJudged: 90, serpJudged: 10 } }, {}).find(
      (n) => n.what === "snippet-judged",
    )!
    expect(under.level).toBe("ok")
    expect(under.detail).toBe("10/100 hosts (10.0%) judged from a snippet, not a page")

    // 3. Exactly at the boundary — the check is `share > 0.16`, so a tie
    // must read `ok`, not `watch`. Pins the boundary rather than a value
    // comfortably past it.
    const boundary = diagnose({ kernel: { modelJudged: 84, serpJudged: 16 } }, {}).find(
      (n) => n.what === "snippet-judged",
    )!
    expect(boundary.level).toBe("ok")
    expect(boundary.detail).toBe("16/100 hosts (16.0%) judged from a snippet, not a page")

    // 4. `unlocked` present appends its own clause — a distinct print branch
    // none of the three cases above exercise.
    const unlocked = diagnose({ kernel: { modelJudged: 95, serpJudged: 5, unlocked: 3 } }, {}).find(
      (n) => n.what === "snippet-judged",
    )!
    expect(unlocked.detail).toBe("5/100 hosts (5.0%) judged from a snippet, not a page, 3 recovered by the unlocker")

    // 5. `serpJudged` absent while `modelJudged` is present and nonzero — a
    // run predating this field but not predating `kernel` itself. `judged`
    // (modelJudged + (serpJudged ?? 0)) is 50, not 0, so the guard that
    // actually catches this is `k.serpJudged == null`, not `!judged` — a
    // distinct condition from case where both are absent (covered by the
    // generic "calls an absent field unknown" test above, where `k` itself
    // is undefined). Removing `k.serpJudged == null` from the guard would
    // compute `0/50 = 0%` and print `ok` instead of `unknown` here.
    const predates = diagnose({ kernel: { modelJudged: 50 } }, {}).find((n) => n.what === "snippet-judged")!
    expect(predates.level).toBe("unknown")
    expect(predates.detail).toBe("not recorded — run predates report.kernel.serpJudged")
  })

  it("reads a rival channel cut by a ceiling differently from one that failed", () => {
    // The rival family is dealt last, so under a ceiling "names found, no
    // queries" is the budget working. Uncapped, the same pair is a real gap.
    const rivals = { found: 5, urlsScanned: 899, queries: 0, reachedMap: 0 }
    const capped = diagnose({ rivals, budget: { maxQueries: 43 } }, {}).find((n) => n.what === "rival harvest")!
    const uncapped = diagnose({ rivals }, {}).find((n) => n.what === "rival harvest")!
    expect(capped.level).toBe("watch")
    expect(uncapped.level).toBe("gap")
    expect(uncapped.detail).toContain("no ceiling explains it")
  })

  it("reports the wire's own plan: unsearched products named, and the strip-terms-fired rate", () => {
    // `r.wire` is the FIRST check in `diagnose()` (~line 77) and, before this,
    // had zero test coverage of its own — both branches below ran unverified.
    // sweep.ts's own comment on this field (~line 7295) says why it exists:
    // "whether each product and each strip term got a query bought for it, or
    // was written down and abandoned" — shopify.com searched 22 of 50 planned
    // products, dropping whole markets from a map claiming completeness.

    // 1. Every planned product got a search — ok, no name list appended.
    const full = diagnose(
      { wire: { products: 3, productsSearched: 3, productsUnsearched: [], termsFired: 5, termsWritten: 10 } },
      {},
    )
    const fullNote = full.find((n) => n.what === "products searched")!
    expect(fullNote.level).toBe("ok")
    expect(fullNote.detail).toBe("3/3")

    // 2. A product the plan named but never searched — the missed COUNT is
    // not the finding, the NAME is (sweep.ts's own comment: "the names are
    // the whole finding"), so it must appear in the detail, not just tally.
    const missed = diagnose(
      { wire: { products: 3, productsSearched: 2, productsUnsearched: ["Widgets"], termsFired: 5, termsWritten: 10 } },
      {},
    )
    const missedNote = missed.find((n) => n.what === "products searched")!
    expect(missedNote.level).toBe("gap")
    expect(missedNote.detail).toBe("2/3 — never asked about: Widgets")

    // 3. Strip terms fired below the 30% threshold — watch, at the norm this
    // file cites (32%-65% across the 8 runs carrying wire, so 20% is a real
    // gap the norm itself would flag).
    const starved = diagnose({ wire: { products: 1, productsSearched: 1, termsFired: 2, termsWritten: 10 } }, {})
    const starvedNote = starved.find((n) => n.what === "strip terms fired")!
    expect(starvedNote.level).toBe("watch")
    expect(starvedNote.detail).toBe("2/10 (20%)")

    // 4. Exactly at the 30% boundary — the check is `< 0.3`, so 3/10 must NOT
    // trip watch. Pins the boundary, not just a value comfortably past it.
    const boundary = diagnose({ wire: { products: 1, productsSearched: 1, termsFired: 3, termsWritten: 10 } }, {})
    const boundaryNote = boundary.find((n) => n.what === "strip terms fired")!
    expect(boundaryNote.level).toBe("ok")
  })

  it("tells apart the three ways the link phase can lose pairs", () => {
    // Link was measured at 43% of wall time (the finding P0-2 through P0-4
    // exist to fix), and this `if / else if` chain — the only place a run's
    // diagnosis reports it — had zero test coverage of its own before this:
    // every branch below ran unverified. The three causes are distinct facts
    // sweep.ts goes out of its way to keep separate (see its comment at
    // `report.budget.unlinkedPairs`, "two different facts and a reader needs
    // both"), so a chain that collapsed them or picked the wrong one would
    // have nothing here to catch it.

    // 1. Declined before it started — the clock ruled it out entirely.
    const skipped = diagnose({ budget: { linkingSkipped: true } }, {}).find((n) => n.what === "linking")!
    expect(skipped.level).toBe("gap")
    expect(skipped.detail).toContain("no model-made edges")

    // 2. Started and cut off mid-flight by the deadline. Checked first in
    // the chain, so it must win even when `truncatedPairs`/`linking.truncated`
    // also carry a number for the same run.
    const midFlight = diagnose(
      { budget: { linkingSkipped: false, unlinkedPairs: 7, truncatedPairs: 3 }, linking: { truncated: 3 } },
      {},
    ).find((n) => n.what === "linking")!
    expect(midFlight.level).toBe("gap")
    expect(midFlight.detail).toBe("7 pairs started and cut off mid-flight")

    // 3. Neither declined nor cut off — PAIR_CAP simply qualified more pairs
    // than the paid pass was allowed to ask, a busy-market fact rather than a
    // clock or a failure, so it is only a `watch`.
    const capBound = diagnose({ budget: { linkingSkipped: false, unlinkedPairs: 0 }, linking: { truncated: 51_919 } }, {}).find(
      (n) => n.what === "linking",
    )!
    expect(capBound.level).toBe("watch")
    expect(capBound.detail).toBe("51919 pairs qualified and were never asked")

    // A clean run — every pair answered, none cut — gets no note at all,
    // unlike every other check in this file. Confirms that is deliberate
    // (a chain of `if`/`else if` with no final `else`) and not a fall-through
    // nobody noticed, matching this section's problems-only shape.
    const clean = diagnose({ budget: { linkingSkipped: false, unlinkedPairs: 0 }, linking: { truncated: 0 } }, {})
    expect(clean.find((n) => n.what === "linking")).toBeUndefined()
  })

  it("reads the clock model's own ratio, not just that report.clock is present", () => {
    // `r.clock` is populated by sweep.ts (pinned in
    // sweep-buys-the-hand-it-was-dealt.test.ts's "report.clock" describe
    // block) and its absence is covered here by the generic "calls an absent
    // field unknown" test above — but neither test drives THIS file's own
    // `ratio < 1 ? "watch" : "ok"` line, so both labels and the boundary
    // between them had never run: a doctor that always printed "ok" (or
    // always "watch") would have passed every other test in this suite.

    // 1. Under-predicted — the run took longer than the model expected, which
    // is the case that matters: a deadline-bound run would have been cut.
    const under = diagnose({ clock: { predictedSeconds: 50, actualSeconds: 100 } }, {}).find((n) => n.what === "clock model")!
    expect(under.level).toBe("watch")
    expect(under.detail).toBe("predicted 50s, actual 100s (0.50x) — UNDER-predicted, a deadline run would have been cut")

    // 2. Over-predicted — the norm case (median 1.44x per this file's own
    // citation), and the warning sentence must not leak into a clean note.
    const over = diagnose({ clock: { predictedSeconds: 150, actualSeconds: 100 } }, {}).find((n) => n.what === "clock model")!
    expect(over.level).toBe("ok")
    expect(over.detail).toBe("predicted 150s, actual 100s (1.50x)")

    // 3. Exactly 1x — the check is `ratio < 1`, so a tie must read `ok`, not
    // `watch`. Pins the boundary rather than a value comfortably past it.
    const tie = diagnose({ clock: { predictedSeconds: 100, actualSeconds: 100 } }, {}).find((n) => n.what === "clock model")!
    expect(tie.level).toBe("ok")
  })
})
