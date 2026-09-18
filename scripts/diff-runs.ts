/**
 * Map drift, from a terminal.
 *
 * The comparison lives in `packages/core` (`drift.ts`, pure); this file is
 * argv, two JSON files and a console, nothing else. Two runs of the same
 * anchor never met before: the sweep CLI stamps every run its own file so a
 * rerun cannot destroy its predecessor, and then nothing ever reads two of
 * them together — drift between an evening's map and the morning's was a
 * reader diffing JSON by eye. This prints it as sentences and a table.
 *
 * Reads any mix of run shapes: sweep and swarm files carry `entities` at the
 * top level, kernel runs wrap the same map under `result`. The shape is
 * sniffed per file, so an old kernel run diffs against last night's swarm run
 * without either being converted.
 *
 * Writes nothing. A diff is a reading, not a run.
 *
 * Usage:  npx tsx scripts/diff-runs.ts runs/swarm-a.json runs/swarm-b.json
 */
import { readFileSync } from "node:fs"
import {
  diffMaps,
  driftSentences,
  indexByKey,
  type DriftMap,
  type DriftEntityRow,
  type MapDrift,
} from "../packages/core/src/index.js"

/** Sniff one already-parsed run file into the drift shape: top-level entities
 *  (sweep, swarm) or the kernel wrapper's `result`. Anything else is refused
 *  by name — the shared sentence `tests/four-readers-refuse-a-non-run-file-
 *  with-one-sentence.test.ts` checks by source text, since this file (argv,
 *  console) could not be imported before this was pulled out. `path` is only
 *  for the error message; the parse itself never touches disk, so this is
 *  the piece the `readFileSync` in `readRun` below hands off to. */
export function parseRun(path: string, json: {
  entities?: DriftEntityRow[]
  edges?: DriftMap["edges"]
  result?: { entities?: DriftEntityRow[]; edges?: DriftMap["edges"] }
}): DriftMap {
  const map = Array.isArray(json.entities) ? json : Array.isArray(json.result?.entities) ? json.result : null
  if (!map) throw new Error(`${path}: no entities at the top level or under result — not a run file this reads`)
  return { entities: map.entities ?? [], edges: map.edges ?? [] }
}

/** The sweep's own display rule: noise rows are judged off the map, so they
 *  do not drift on or off it either. Excluded here, not in core — the pure
 *  diff compares whatever rows it is handed. */
export function denoise(m: DriftMap): DriftMap {
  return { entities: m.entities.filter((e) => e.kind !== "noise"), edges: m.edges }
}

/**
 * One row per key that moved, both readings side by side, for the CLI table
 * below. Absent side reads "—"; a key's reading is relation@tier, tier
 * omitted where the run never minted one. Unchanged keys stay off the table —
 * the sentence printed above it already counts them, and 200 identical rows
 * is padding, not reading.
 *
 * Reads `a`/`b` through `indexByKey`, the SAME first-wins index `diffMaps`
 * built `diff` from, rather than a second index of its own. This used to be
 * `new Map(m.entities.map((e) => [entityKey(e), e]))` — last-wins, the
 * constructor's ordinary behaviour on a repeated key — so a file with two
 * rows folding to one key (drift.ts's own header: "two subdomains folding to
 * one host") printed a "was" reading from the SECOND row here while the
 * sentence one line above it, computed by diffMaps from the FIRST, named the
 * move it measured against. Confirmed directly: two rows sharing a domain,
 * relations "competitor" then "substitute" in A, one "adjacent" row in B —
 * the sentence read "competitor -> adjacent" (diffMaps' first-wins pick) and
 * the table read "was substitute" (the old last-wins `new Map`), two lines
 * about the same key disagreeing about what "was".
 */
export function driftRows(diff: MapDrift, a: DriftMap, b: DriftMap): Array<readonly [string, string, string]> {
  const inA = indexByKey(a.entities)
  const inB = indexByKey(b.entities)
  const reading = (e?: DriftEntityRow) => (e ? `${e.relation ?? "?"}${e.tier ? "@" + e.tier : ""}` : "—")

  const changedKeys = [...new Set(diff.changed.map((c) => c.key))]
  return [
    ...changedKeys.map((k) => [k, reading(inA.get(k)), reading(inB.get(k))] as const),
    ...diff.left.map((k) => [k, reading(inA.get(k)), "—"] as const),
    ...diff.entered.map((k) => [k, "—", reading(inB.get(k))] as const),
  ]
}

const invokedDirectly = process.argv[1] ? import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0") : false
if (invokedDirectly) {
  const [fileA, fileB] = process.argv.slice(2)
  if (!fileA || !fileB) {
    console.error("usage: npx tsx scripts/diff-runs.ts <runA.json> <runB.json>")
    process.exit(1)
  }

  const readRun = (path: string): DriftMap => parseRun(path, JSON.parse(readFileSync(path, "utf8")))

  const rawA = readRun(fileA)
  const rawB = readRun(fileB)

  const a = denoise(rawA)
  const b = denoise(rawB)
  const noiseA = rawA.entities.length - a.entities.length
  const noiseB = rawB.entities.length - b.entities.length

  const diff = diffMaps(a, b)

  console.log(`A  ${fileA}  (${a.entities.length} entities, ${a.edges?.length ?? 0} edges)`)
  console.log(`B  ${fileB}  (${b.entities.length} entities, ${b.edges?.length ?? 0} edges)`)
  if (noiseA + noiseB > 0) console.log(`${noiseA} noise rows in A and ${noiseB} in B sit out of the diff`)
  console.log()
  for (const line of driftSentences(diff)) console.log(line)

  const rows = driftRows(diff, a, b)

  if (rows.length > 0) {
    console.log()
    const widths = [0, 1, 2].map((i) => Math.max("key was now".split(" ")[i]!.length, ...rows.map((r) => r[i]!.length)))
    const line = (r: readonly [string, string, string]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ")
    console.log(line(["key", "was", "now"]))
    for (const r of rows) console.log(line(r))
  }
}
