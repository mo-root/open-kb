/**
 * Rebuild `demo/maps/` — the six committed maps a read-only deployment serves.
 *
 * WHY A COMMITTED DIRECTORY AND NOT `runs/`. `runs/` is gitignored, 125MB, and
 * 83 files deep in half-finished experiments. A clone has none of it, so a
 * deployment built from a clone has an empty gallery, and the only way to fill
 * it is to spend four to nineteen minutes and $0.30-$5.00 per visitor. The
 * product experience is the MAP, not the wait: 2,551 entities clustered by
 * market with every node carrying its sources, which is instant to serve and
 * already exists on disk. So six of them are copied out, trimmed, and committed.
 *
 * WHY A SCRIPT AND NOT SIX `cp`s. The trim below is a claim about what the app
 * reads, and a claim that lives in a shell command someone ran once is a claim
 * nobody can re-check. This file is the record of which runs were chosen, why
 * each one, and what was dropped; `pnpm demo:maps` reproduces the directory
 * byte for byte from `runs/`, and tests/demo-maps.test.ts reads the committed
 * output back and fails if it drifts from what this writes.
 *
 * READ-ONLY ON `runs/`. It opens the six sources and writes nowhere near them.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const FROM = join(ROOT, "runs")
const TO = join(ROOT, "demo", "maps")

/**
 * The six, and why each one is here rather than any of the other files.
 *
 * All rebuilt 2026-08-18/19 on one engine generation — agent discovery, the
 * orphan ask (36% unlinked fell to 3-8%), docs-cited integration edges,
 * prominence counts and per-entity roads — replacing a set that spanned two
 * generations and predates every one of those. Each cost $0.83-$1.24 and its
 * numbers below are its own report's. cursor.com is deliberately absent: its
 * market's head-on rival (windsurf) is named in 101 SERP snippets and appears
 * in zero organic rows, so until mentions-to-leads lands that map would be
 * wrong in the one way its audience would spot instantly.
 */
const PICKS: { file: string; because: string }[] = [
  { file: "sweep-stripe-com-20260818214527.json", because: "1,102 entities — payments, mapped for $0.96" },
  { file: "sweep-vercel-com-20260818212925.json", because: "1,107 entities and the densest edges of the set" },
  { file: "sweep-supabase-com-20260818210215.json", because: "899 entities — 12 of its 14 known rivals surfaced" },
  { file: "sweep-sentry-io-20260818232602.json", because: "892 entities — a perfect 10/10 against the field its owners know" },
  { file: "sweep-neon-tech-20260818225808.json", because: "741 entities, and the docs' own integrations drawn as edges" },
  { file: "sweep-brightdata-com-20260818131026.json", because: "882 entities — 19 of 20 known players, ranked by prominence" },
]

/**
 * `searched` is dropped, and it is the only thing dropped.
 *
 * WHAT IT IS: one row per query fired, with the query, its intent, its cost and
 * its hits — written by scripts/sweep.ts, which harvests the `ui:results`
 * frames off the span stream and appends them to the run JSON. It is a terminal
 * user's transcript of the search phase.
 *
 * WHY IT GOES: nothing in the web app reads it. `grep -rn '\.searched'` over
 * packages/web and packages/core returns no code — the only readers on this
 * disk are scripts/bench.ts (`searched.length`) and packages/swarm's
 * from-sweep.ts, both of which run from a terminal against `runs/`, never
 * against this directory. It is also, by a distance, the largest thing in the
 * file: 2.0MB of stripe's 5.3MB and 2.2MB of vercel's 6.2MB.
 *
 * WHY NOTHING ELSE GOES. `spans`, `descSpans`, `settledBy` and
 * `unreadableReason` were measured as candidates too and kept. `spans` and
 * `report.recall` are read by core's exportKbFiles, which the download button
 * on every map calls. The other two are read by nothing today and together save
 * 0.4MB across all six — not worth serving a map that is quietly less than the
 * run it claims to be. One dead field, named and justified, beats a
 * hand-tightened subset nobody can audit.
 *
 * MINIFIED, for the same reason the field is dropped: these are generated
 * files that no one reads by hand and no diff will ever be useful on, and the
 * whitespace is 2.4MB of the total. 19.4MB of source becomes 8.4MB on disk and
 * in the lambda.
 */
const DROP = "searched"

function main(): void {
  mkdirSync(TO, { recursive: true })

  // Cleared first, so a pick removed from the list above disappears from the
  // directory instead of lingering as a map the gallery still serves and this
  // file no longer mentions.
  for (const name of readdirSync(TO)) {
    if (name.endsWith(".json")) rmSync(join(TO, name))
  }

  let before = 0
  let after = 0
  const rows: string[] = []

  for (const { file, because } of PICKS) {
    const src = join(FROM, file)
    let raw: string
    try {
      raw = readFileSync(src, "utf8")
    } catch {
      // Loud, not skipped. A missing source means the committed directory is
      // about to lose a map, and a half-rebuilt gallery that still looks fine
      // is exactly the failure this script exists to make impossible.
      throw new Error(`${file} is not in runs/ — cannot rebuild demo/maps/ without it`)
    }
    const run = JSON.parse(raw) as Record<string, unknown> & {
      anchor?: string
      entities?: unknown[]
      edges?: unknown[]
    }
    if (typeof run.anchor !== "string" || !Array.isArray(run.entities)) {
      throw new Error(`${file} is not a sweep result — it has no anchor and entities`)
    }

    const { [DROP]: _dropped, ...kept } = run
    const out = JSON.stringify(kept)
    // The filename carries the run's identity: lib/runs.ts reads the id off it
    // (`sweep-` stripped, stamp kept) and dates the run from the stamp. Renaming
    // these would silently re-date every map to whenever the page was loaded.
    writeFileSync(join(TO, file), out, "utf8")

    before += raw.length
    after += out.length
    rows.push(
      `  ${file.padEnd(42)} ${String(run.entities.length).padStart(5)} entities  ` +
        `${String(run.edges?.length ?? 0).padStart(5)} edges  ` +
        `${mb(raw.length)} → ${mb(out.length)}   ${because}`,
    )
  }

  console.log(`demo/maps/ — ${PICKS.length} maps\n`)
  for (const row of rows) console.log(row)
  console.log(
    `\n  ${"total".padEnd(42)} ${mb(before)} → ${mb(after)} ` +
      `(${Math.round((1 - after / before) * 100)}% smaller; \`${DROP}\` dropped, whitespace dropped)`,
  )

  const onDisk = readdirSync(TO)
    .filter((n) => n.endsWith(".json"))
    .reduce((n, name) => n + statSync(join(TO, name)).size, 0)
  console.log(`  ${"on disk".padEnd(42)} ${mb(onDisk)}`)
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)}MB`
}

main()
