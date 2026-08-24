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
 * All rebuilt 2026-08-23 on one engine generation, replacing a set from
 * 2026-08-18/19. What changed between them is not size — the old set was
 * 741-1,107 entities and this one is 919-1,236 — but whether a reader can
 * check any of it:
 *
 *              old set        this set
 *   competitor share      35-56%         13-36%
 *   `reasoning` written        0%         83-87%
 *   relation quoted from a page 0%        76-79%
 *
 * The old maps carried no reasoning and no relation quote at all, and called
 * between a third and a half of every market a competitor — 619 of stripe's
 * 1,102 rows. `adjacent` did not exist when they were built, so a partner, a
 * vendor and a neighbour had nowhere to go but `competitor` or off the map.
 *
 * Six markets rather than six dev-tools companies, because a gallery that is
 * all one shape reads as a tool that only works on one shape — payments,
 * design, commerce, AI, edge infrastructure, observability.
 *
 * ONE CAVEAT WORTH READING BEFORE THE DATADOG MAP: at 36% it has the highest
 * competitor share of the six, and a sample of eighteen of those rows found
 * roughly five defensible. Its decomposition declared eleven of twelve markets
 * `core` — including Cloud Security and SIEM — and listed `security analysts`
 * among its buyers, which between them defeat all three of the disqualifiers
 * classify.md gates `competitor` behind. It is the most honest illustration in
 * the set of where the classifier still fails, which is why it is kept rather
 * than quietly swapped for an easier anchor.
 *
 * WHAT WAS TRIED AGAINST IT, since the next reader will have the same two
 * ideas. Both were bought and run rather than argued about.
 *
 * The mechanism is real and reproducible. Re-classifying six of those rows off
 * their live pages, changing NOTHING but the anchor's own description:
 *
 *   sells/buyer as the run had them   akamai=competitor  todyl=competitor
 *   sells/buyer narrowed to the core  akamai=adjacent    todyl=adjacent
 *
 * with blackfire.io — a real observability rival — staying `competitor` in
 * both. So the inflation enters at `understand`, not at the gate: a `sells`
 * spanning "observability and security" and a `buyer` listing "security
 * analysts" hand every security vendor a pass through disqualifiers 2 and 3.
 *
 * The obvious fix does not follow, and was dropped for two measured reasons.
 * Telling understand.md that core is at most three capabilities DOES hold —
 * datadog came back 3 of 6 and 3 of 7 with the line against 5 of 12 and 3 of 4
 * without it — but "Security and Threat Management" survives as core either
 * way, so akamai and todyl would still pass. And `centrality: "core"` is not
 * only a label: `openingHand` deals a core product's second strip term into
 * the opening hand instead of the reserve, so demoting markets buys fewer
 * queries. A change that narrows the map to fix a precision bug it does not
 * actually fix is the wrong trade.
 *
 * What would work is giving classify.md the core capability NAMES rather than
 * the `sells` sentence, so disqualifier 3 tests against the market list the
 * decomposition already computed. Left unbuilt: it needs an A/B, and
 * `scripts/recall.ts --by family` shows a single run cannot judge one.
 */
/**
 * EVERY PICK BELOW PREDATES THE 2026-08-24 CHANGES, and refreshing them is a
 * judgement call rather than an obvious win — which is why it has not been
 * made here.
 *
 * cloudflare.com is the one anchor with a run on both sides of those changes,
 * so it is the honest sample:
 *
 *                        stats.kept  placed rows  edges  snippet-guessed
 *   2026-08-23 (picked)        1122         1111   3343              144
 *   2026-08-24                 1165         1056   2834               38
 *
 * The new map is more honest and visibly smaller. 106 rows that were guessed
 * from a search snippet are gone, 32 of them replaced by rows a real page
 * settled — but the net is 55 fewer placed entities and 509 fewer edges,
 * because a withheld row cannot be one end of a pair.
 *
 * Which of those a gallery should show is a product question. A visitor
 * counts nodes and edges; a buyer who checks ten rows finds fewer wrong ones.
 * The `because` lines here quote entity counts, so refreshing means those
 * numbers go DOWN while the maps get better, and someone has to want that
 * trade before it ships. The runs are on disk either way.
 */
const PICKS: { file: string; because: string }[] = [
  { file: "sweep-shopify-com-20260823201634.json", because: "1,236 entities — commerce, and the first map built off four strip terms" },
  { file: "sweep-openai-com-20260823191503.json", because: "1,194 entities — the AI field, 3,201 edges" },
  { file: "sweep-stripe-com-20260823130137.json", because: "1,123 entities — payments, 22% competitor against the old map's 56%" },
  { file: "sweep-cloudflare-com-20260823162255.json", because: "1,122 entities — edge and CDN, 8 of its 10 known rivals surfaced" },
  { file: "sweep-datadoghq-com-20260823193440.json", because: "1,077 entities — observability, the densest edges of the set at 3,754" },
  { file: "sweep-figma-com-20260823125953.json", because: "919 entities — design, 92% of its known field found" },
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
