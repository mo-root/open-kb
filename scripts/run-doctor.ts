/**
 * WHAT WENT WRONG IN THIS RUN, AND WHAT IT LEFT ON THE TABLE.
 *
 * A run file carries thirty-odd report fields now, most of them added this
 * week because some claim about the engine turned out to be wrong. Reading
 * them means knowing which number is normal, and that knowledge lived in
 * commit messages and in my head. This is that knowledge as a command.
 *
 *   npx tsx scripts/run-doctor.ts                 # the newest run
 *   npx tsx scripts/run-doctor.ts <path|substring>
 *   npx tsx scripts/run-doctor.ts --all           # every run, one line each
 *
 * THE RULE IT IS BUILT ON. A zero has two meanings and they must never look
 * alike: "this stage ran and found nothing" is a fact about the anchor, and
 * "this stage never ran" is a fact about the run. Every check below reports
 * its POPULATION beside its sample, and says `not recorded` rather than
 * inventing a zero when a field is absent — most runs on disk predate most
 * fields. Three wrong conclusions on this branch came from reading an absent
 * field as a measured zero.
 *
 * The thresholds are measurements, not taste. Each one cites what it is
 * against, so a norm that drifts can be re-derived rather than argued with:
 *
 *   triage skip        4.6% over 28 runs, 28,182 hosts (0.3%-13.3%)
 *   second look        35% of asked hosts never get a page, over 28 runs
 *   clock              predicted/actual median 1.44 over 41 runs (0.42-2.36)
 *   terms fired        32%-58% of terms written, over the 8 runs with wire
 *
 * WHAT IT FOUND ON ITS FIRST PASS over the 45 runs on disk (2026-08-25):
 * the two free harvest channels are the first thing a clock starves.
 *
 * Of 20 runs that harvested rival names, exactly one fired no queries from
 * them; of 27 that harvested listicle vendors, exactly one. It is the same
 * run both times — the only deadline-bound run on disk. It read 899 sitemap
 * urls, found 5 rivals, scanned 60 listicle rows, found 16 vendors, and
 * bought nothing from either.
 *
 * That matters because the web product is ALWAYS clock-bound. Both channels
 * are free reads whose whole purpose is to turn into queries, and under a
 * deadline they turn into nothing — the run pays to find the names and then
 * cannot afford to ask about them. One run is one run, and the check exists
 * so the next clock-bound run either confirms it or does not.
 *
 * (The first draft of this paragraph said every harvesting run fired zero,
 * which was false and would have sent someone after a channel that works
 * fine on 46 of 47 occasions. The check that caught it is the one below.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const runsDir = join(process.cwd(), "runs")
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const ALL = process.argv.includes("--all")

/** A finding: `level` orders the output, `norm` cites what it is judged against. */
interface Note { level: "gap" | "watch" | "ok" | "unknown"; what: string; detail: string; norm?: string }

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—")

function diagnose(r: Record<string, any>, stats: Record<string, any>): Note[] {
  const out: Note[] = []
  const absent = (what: string, why: string) =>
    out.push({ level: "unknown", what, detail: `not recorded — ${why}` })

  // ── the plan against the wire ──────────────────────────────────────────
  const w = r.wire
  if (!w) absent("wire", "run predates report.wire")
  else {
    const missed = w.products - w.productsSearched
    out.push({
      level: missed ? "gap" : "ok",
      what: "products searched",
      detail: `${w.productsSearched}/${w.products}` +
        (missed ? ` — never asked about: ${(w.productsUnsearched ?? []).join(", ") || "(names not recorded)"}` : ""),
    })
    out.push({
      level: w.termsFired / w.termsWritten < 0.3 ? "watch" : "ok",
      what: "strip terms fired",
      detail: `${w.termsFired}/${w.termsWritten} (${pct(w.termsFired, w.termsWritten)})`,
      norm: "32%-58% across the runs carrying wire",
    })
  }

  // Harvested names that bought nothing. Both channels exist to turn a free
  // read into queries, so a non-zero find with zero queries is the whole
  // channel failing silently.
  const rv = r.rivals
  if (rv) {
    if (rv.urlsScanned === 0)
      out.push({ level: "gap", what: "rival harvest", detail: "sitemap never read (0 urls scanned) — not 'no comparison pages'" })
    else if (rv.found > 0 && rv.queries === 0)
      out.push({ level: "gap", what: "rival harvest", detail: `${rv.found} names found from ${rv.urlsScanned} urls, 0 queries fired — the names bought nothing` })
    else
      out.push({ level: "ok", what: "rival harvest", detail: `${rv.found} names, ${rv.queries} queries, ${rv.reachedMap} reached the map` })
  } else absent("rival harvest", "run predates report.rivals")

  const lh = r.listicleHarvest
  if (lh) {
    if (lh.starved)
      out.push({ level: "watch", what: "listicle harvest", detail: "declined — the query ceiling was spent before it ran, so no vendor names were read" })
    else
      out.push({
        level: lh.vendorsFound > 0 && lh.queriesFired === 0 ? "gap" : "ok",
        what: "listicle harvest",
        detail: `${lh.vendorsFound} vendors from ${lh.rowsScanned} rows, ${lh.queriesFired} queries fired`,
      })
  } else absent("listicle harvest", "run predates report.listicleHarvest")

  // ── what was judged ───────────────────────────────────────────────────
  const t = r.triage
  if (t === null) out.push({ level: "ok", what: "triage", detail: "flag off — kept all hosts" })
  else if (!t) absent("triage", "run predates report.triage")
  else {
    const rate = t.skipped / t.hosts
    out.push({
      level: rate > 0.13 ? "watch" : "ok",
      what: "triage skip",
      detail: `${t.skipped}/${t.hosts} (${pct(t.skipped, t.hosts)}) in ${t.calls} calls` +
        (t.failed ? `, ${t.failed} failed open` : ""),
      norm: "4.6% over 28 runs, 0.3%-13.3%",
    })
  }

  const sl = r.secondLook
  if (sl === null) out.push({ level: "ok", what: "second look", detail: "flag off" })
  else if (!sl) absent("second look", "run predates report.secondLook")
  else if (sl.asked) {
    const failRate = (sl.failed ?? 0) / sl.asked
    out.push({
      level: failRate > 0.5 ? "watch" : "ok",
      what: "second look",
      detail: `${sl.asked} asked, ${sl.rescued} rescued, ${sl.failed ?? 0} got no page (${pct(sl.failed ?? 0, sl.asked)})`,
      norm: "35% get no page, over 28 runs",
    })
  }

  const b = r.budget
  if (b && b.unjudged > 0)
    out.push({ level: "gap", what: "hosts unjudged", detail: `${b.unjudged} of ${b.hostsFound} found were never judged — the clock ended first` })

  // ── the clock ─────────────────────────────────────────────────────────
  const c = r.clock
  if (!c) absent("clock", "run predates report.clock")
  else {
    const ratio = c.predictedSeconds / c.actualSeconds
    out.push({
      level: ratio < 1 ? "watch" : "ok",
      what: "clock model",
      detail: `predicted ${c.predictedSeconds}s, actual ${c.actualSeconds}s (${ratio.toFixed(2)}x)` +
        (ratio < 1 ? " — UNDER-predicted, a deadline run would have been cut" : ""),
      norm: "median 1.44x over 41 runs, 0.42-2.36",
    })
  }

  const paced = r.serp?.paced
  if (paced?.queries) {
    out.push({
      level: paced.ms > 300_000 ? "watch" : "ok",
      what: "provider throttle",
      detail: `${paced.queries} queries waited, ${Math.round(paced.ms / 1000)}s of cumulative pacing`,
    })
  }

  // ── linking ───────────────────────────────────────────────────────────
  if (b?.linkingSkipped) out.push({ level: "gap", what: "linking", detail: "declined entirely — the map has no model-made edges" })
  else if (b?.unlinkedPairs) out.push({ level: "gap", what: "linking", detail: `${b.unlinkedPairs} pairs started and cut off mid-flight` })
  else if (r.linking?.truncated) out.push({ level: "watch", what: "linking", detail: `${r.linking.truncated} pairs qualified and were never asked` })

  return out
}

function load(file: string) {
  const j = JSON.parse(readFileSync(join(runsDir, file), "utf8"))
  return { j, notes: diagnose(j.report ?? {}, j.stats ?? {}) }
}

const files = readdirSync(runsDir).filter((f) => f.startsWith("sweep-") && f.endsWith(".json"))
if (!files.length) { console.log("no runs in runs/"); process.exit(0) }

if (ALL) {
  console.log(`\n${files.length} runs — gaps per run\n`)
  for (const f of files.sort()) {
    let notes: Note[]
    try { notes = load(f).notes } catch { continue }
    const gaps = notes.filter((n) => n.level === "gap")
    const watch = notes.filter((n) => n.level === "watch")
    // The unknown count has to be on this line. Without it a run that
    // predates the instrumentation prints "0 gaps" and reads exactly like a
    // clean one, which is the confusion this whole script is against — and
    // the first draft of this view had it.
    const unknown = notes.filter((n) => n.level === "unknown")
    console.log(
      "  " + f.replace(/^sweep-|\.json$/g, "").padEnd(32) +
      `${gaps.length} gap${gaps.length === 1 ? " " : "s"}`.padStart(8) + `${watch.length} watch`.padStart(10) +
      `${unknown.length} unchecked`.padStart(14) +
      "   " + gaps.map((g) => g.what).join(", "),
    )
  }
  console.log(`\n  unchecked = fields the run predates. NOT the same as clean —`)
console.log(`  a run with 8 unchecked and 0 gaps has been asked almost nothing.\n`)
  process.exit(0)
}

const want = args[0]
const pick = want
  ? (files.find((f) => f === want || f.includes(want)) ?? null)
  : files.map((f) => ({ f, t: statSync(join(runsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]!.f
if (!pick) { console.log(`no run matching ${want}`); process.exit(1) }

const { j, notes } = load(pick)
const mark = { gap: "GAP    ", watch: "watch  ", ok: "ok     ", unknown: "—      " }
console.log(`\n${pick}`)
console.log(`${j.anchor ?? "?"} — ${j.stats?.queries ?? "?"} queries, ${j.report?.entities ?? "?"} entities, $${(j.stats?.usd ?? 0).toFixed(2)}, ${Math.round(j.stats?.seconds ?? 0)}s\n`)
for (const level of ["gap", "watch", "unknown", "ok"] as const) {
  for (const n of notes.filter((x) => x.level === level)) {
    console.log(`  ${mark[n.level]}${n.what.padEnd(20)}${n.detail}`)
    if (n.norm && level !== "ok") console.log(`         ${" ".repeat(20)}norm: ${n.norm}`)
  }
}
console.log(`\n  GAP = something planned did not reach the wire, or was cut short.`)
console.log(`  —   = the field is absent, which is not the same as zero.\n`)
