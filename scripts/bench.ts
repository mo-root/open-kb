/**
 * The results table, read off the runs instead of typed.
 *
 * This repo has published numbers that matched no file on disk — a README hero
 * claiming "490 entities · 210 players" for an anchor whose runs range from 8
 * entities to 934 hosts. A hand-written table is a claim; this is a reading.
 * Every cell below comes out of `runs/*.json`, so the way to argue with a
 * number is to open the file it came from, and the way to refresh the table
 * after a run is to run this again.
 *
 * Costs nothing and touches no network: it opens files, counts, and prints.
 *
 * Deterministic on purpose. No clock, no `Date.now()` in the output, no
 * ordering that depends on directory order — same `runs/`, same bytes, so the
 * table can be committed and its diff read as "what changed about the engine"
 * rather than "when did someone last run this".
 *
 * WHAT IS IN THE TABLE, AND WHY. A developer reads a benchmark to answer two
 * questions in five seconds: is this any good, and what will it cost me. Nine
 * columns, and the ones that were cut were cut for stated reasons (see the
 * footnotes this prints — they are generated from the same data, so the
 * argument for cutting a column is checkable too).
 *
 *   hosts / on map   Kept together because they are the only pair that shows
 *                    what the two engines actually are. The sweep turns 877
 *                    hosts into 846 rows; the swarm turns 490 into 28. Without
 *                    both numbers "$ per entity" compares two different units
 *                    and flatters the sweep by a factor of thirty.
 *   rivals           competitor + substitute. The map's entire promise. `kind`
 *                    was rejected for this slot (footnote 2).
 *   unread           The share of the map that is a host the run could not
 *                    read — a row carrying an HTTP status instead of a
 *                    description. A map that is one-sixth placeholder should
 *                    say so on the same line as its size.
 *   grounded         Median `descGrounded`: how much of a description the page
 *                    it was written from actually says. The only quality meter
 *                    this project has that runs on every entity for $0.
 *   $ / wall         What the meter recorded. Not recomputed (footnote 1).
 *   $/entity         The sweep-versus-swarm punchline, and the reason the
 *                    swarm gets its own table rather than being averaged in.
 *
 * Cut: `players` (the kind classifier is not reproducible — footnote 2),
 * `queries` (the stat named `queries` is not the number of queries fired —
 * footnote 3), `hosts seen` as distinct from map size (in every current-era
 * sweep run `stats.hosts` is exactly `entities.length`; the funnel is a
 * rename, not a filter), and `edges` (the count scales with map size and no
 * reader can tell a good one from a bad one; it is in `--all` output nowhere
 * and in the JSON for anyone who wants it).
 *
 * THE ERA PROBLEM. `runs/` spans several configurations and no run file
 * records which one produced it — not the model, not the pipeline version,
 * nothing. So the era has to be recovered from the artifact's own shape. The
 * boundary this scopes to is the grounding meter: entity rows either carry
 * `descGrounded`/`unreadableReason` or they do not, which is a property of the
 * file rather than of a clock. The runs that carry it are the current
 * pipeline; the 52 that do not cannot produce two of the nine columns and
 * were metered differently besides. They are counted, dated and summarised
 * rather than deleted — `--all` prints them.
 *
 * Usage:
 *   pnpm bench            the current-config tables, as markdown
 *   pnpm bench --all      also the runs that predate the grounding meter
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

/* ------------------------------------------------------------- the artifacts */

interface Entity {
  name?: string
  domain?: string
  kind?: string
  relation?: string
  /** Present only in the grounding era: what fraction of the description the page says. */
  descGrounded?: number
  /** Present only in the grounding era: why this host has a status instead of a description. */
  unreadableReason?: string
  /** Swarm only. The provenance ladder. Used here to tell the engines apart. */
  tier?: string
  foundBy?: string[]
  families?: string[]
  settledBy?: string
}

interface Stats {
  queries?: number
  results?: number
  hosts?: number
  kept?: number
  tokIn?: number
  tokOut?: number
  serpCalls?: number
  unlockerCalls?: number
  usd?: number
  seconds?: number
}

interface MapShape {
  anchor?: string
  entities?: Entity[]
  edges?: unknown[]
  stats?: Stats
  /** Sweep only, and only lately: one row per query the run actually fired. */
  searched?: unknown[]
}

/** The web route writes an envelope around the same map the CLI writes bare. */
interface Envelope extends MapShape {
  id?: string
  domain?: string
  startedAt?: number
  endedAt?: number
  result?: MapShape
}

/* ------------------------------------------------------------ era boundaries */

/**
 * Two dates, both read off `git log`, both stated here because the runs do not
 * state them. Everything below only ever uses them to LABEL a row, never to
 * change a number — a benchmark that adjusts the figures it was given is a
 * benchmark nobody can check.
 *
 * `772a9e6 2026-08-06 15:40:09 +0300` made deepseek-v4-flash the default for
 * every entry point. `600442f 2026-08-06 16:11:20 +0300` taught the meter the
 * per-model price table; before it, `sweep()` billed EVERY model at
 * gemini-3.5-flash's $1.50/$9.00 per Mtok whatever was actually running. So a
 * run stamped before that second commit has a dollar figure that is one
 * model's price list applied to whichever model happened to run.
 */
const METER_LEARNED_PRICES_AT = Date.parse("2026-08-06T13:11:20Z")
const DEEPSEEK_BECAME_DEFAULT_AT = Date.parse("2026-08-06T12:40:09Z")

/* ------------------------------------------------------------------- reading */

type Engine = "sweep" | "swarm"
type Source = "cli" | "web"

interface Run {
  file: string
  engine: Engine
  source: Source
  anchor: string
  /** Milliseconds since epoch, or null when the file carries no time at all. */
  at: number | null
  /** How `at` was recovered, so a reader knows when it is a guess. */
  atFrom: "filename" | "endedAt" | "mtime"
  /** The current pipeline: entity rows carry the grounding meter. */
  grounded: boolean
  /** Which optional entity fields this run's rows carry — the era fingerprint. */
  markers: string[]

  hosts: number | null
  onMap: number
  noise: number
  /** The anchor's own row, which the sweep mints and then classifies. */
  selfRow: Entity | null
  rivals: number
  companies: number
  products: number
  unread: number | null
  medGrounded: number | null
  edges: number
  usd: number | null
  seconds: number | null
  /** `stats.queries` — the opening batch, not the run. See footnote 3. */
  statQueries: number | null
  /** `searched.length` — one row per query actually fired, where the run logged it. */
  firedQueries: number | null
}

interface Skipped {
  file: string
  why: string
}

const DIR = "runs"

/** The stamp four scripts write into a run's filename, in UTC. Twelve digits
 *  before 2026-08-08, fourteen after — both widths are on disk. */
function stampOf(file: string): number | null {
  const m = /-(\d{12}|\d{14})\.json$/.exec(file)
  if (!m) return null
  const d = m[1]!
  const iso =
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:` +
    `${d.length === 14 ? d.slice(12, 14) : "00"}Z`
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Every optional entity field that ever marked a pipeline change, in the order
 *  they appeared on disk. A run's set of these is its shape fingerprint. */
const MARKERS = ["tier", "foundBy", "families", "settledBy", "unreadableReason", "descGrounded"] as const

function readRun(file: string): Run | Skipped {
  const full = path.join(DIR, file)
  let json: Envelope
  try {
    json = JSON.parse(readFileSync(full, "utf8")) as Envelope
  } catch {
    return { file, why: "not JSON" }
  }
  const map: MapShape = Array.isArray(json.entities) ? json : Array.isArray(json.result?.entities) ? json.result! : json
  const entities = map.entities
  if (!Array.isArray(entities)) {
    // The investigator writes {nodes, edges, spans}; audit packets write rows.
    // Neither is a market map and neither belongs in a market-map benchmark.
    return { file, why: `no entities at the top level or under result (keys: ${Object.keys(json).join(", ")})` }
  }

  // Engine by evidence, not by filename. Only the swarm stamps a provenance
  // `tier` on its rows, and it does so on every run on disk. The filename is
  // then checked against that, because a run whose name and shape disagree is
  // a thing a reader must be told about rather than a thing to average in.
  const engine: Engine = entities.some((e) => typeof e.tier === "string") ? "swarm" : "sweep"
  const named = file.startsWith("swarm-") ? "swarm" : file.startsWith("sweep-") ? "sweep" : null
  if (named && named !== engine) return { file, why: `named ${named} but its rows look like ${engine}` }
  const source: Source = named ? "cli" : "web"

  const anchorRaw = map.anchor ?? json.domain ?? ""
  const anchor = anchorRaw.replace(/^www\./, "").toLowerCase()

  let at = stampOf(file)
  let atFrom: Run["atFrom"] = "filename"
  if (at === null && typeof json.endedAt === "number") {
    at = json.endedAt
    atFrom = "endedAt"
  }
  if (at === null) {
    at = statSync(full).mtimeMs
    atFrom = "mtime"
  }

  const noise = entities.filter((e) => e.kind === "noise").length
  // The anchor is not a player in its own market. The sweep mints a row for it
  // anyway and then classifies it, sometimes as its own competitor, so it is
  // excluded here and counted in footnote 4 rather than silently dropped.
  const isSelf = (e: Entity) => (e.domain ?? "").replace(/^www\./, "").toLowerCase() === anchor && anchor !== ""
  const selfRow = entities.find((e) => e.kind !== "noise" && isSelf(e)) ?? null
  const kept = entities.filter((e) => e.kind !== "noise" && !isSelf(e))

  const grounds = kept.map((e) => e.descGrounded).filter((x): x is number => typeof x === "number")
  const groundedEra = grounds.length > 0 || kept.some((e) => typeof e.unreadableReason === "string")

  const stats = map.stats ?? {}
  return {
    file,
    engine,
    source,
    anchor: anchor || "(unnamed)",
    at,
    atFrom,
    grounded: groundedEra,
    markers: MARKERS.filter((m) => entities.some((e) => e[m] !== undefined)),
    hosts: typeof stats.hosts === "number" ? stats.hosts : null,
    onMap: kept.length,
    noise,
    selfRow,
    rivals: kept.filter((e) => e.relation === "competitor" || e.relation === "substitute").length,
    companies: kept.filter((e) => e.kind === "company").length,
    products: kept.filter((e) => e.kind === "product").length,
    unread: groundedEra ? kept.filter((e) => typeof e.unreadableReason === "string").length : null,
    medGrounded: median(grounds),
    edges: Array.isArray(map.edges) ? map.edges.length : 0,
    usd: typeof stats.usd === "number" ? stats.usd : null,
    seconds: typeof stats.seconds === "number" ? stats.seconds : null,
    statQueries: typeof stats.queries === "number" ? stats.queries : null,
    firedQueries: Array.isArray(map.searched) ? map.searched.length : null,
  }
}

/* ------------------------------------------------------------------ the table */

const NUM = new Set(["hosts", "on map", "rivals", "unread", "grounded", "$", "wall (s)", "$/entity"])

function table(head: string[], rows: string[][]): string {
  const align = head.map((h) => (NUM.has(h) ? "---:" : ":---"))
  return [`| ${head.join(" | ")} |`, `| ${align.join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n")
}

const n0 = (x: number | null) => (x === null ? "—" : String(Math.round(x)))
const money = (x: number | null) => (x === null ? "—" : x.toFixed(2))
const pct = (num: number | null, den: number) => (num === null || den === 0 ? "—" : `${Math.round((num / den) * 100)}%`)
const g2 = (x: number | null) => (x === null ? "—" : x.toFixed(2))
const perEntity = (r: Run) => (r.usd === null || r.onMap === 0 ? "—" : (r.usd / r.onMap).toFixed(4))
const day = (t: number | null) => (t === null ? "—" : new Date(t).toISOString().slice(0, 10))

/** A dagger on the rows whose dollar figure predates the meter's price table.
 *  Marking beats adjusting: the number stays the one the run wrote down. */
const DAGGER = "†"
const preMeter = (r: Run) => r.at !== null && r.at < METER_LEARNED_PRICES_AT

/** Anchor plus the run's own UTC stamp, because seven rows reading `clerk.com`
 *  are seven rows nobody can trace back to a file. This is the identity that
 *  makes a cell arguable: `clerk.com 08-06 23:31` is
 *  `runs/sweep-clerk-com-202608062331.json`. */
function label(r: Run): string {
  const when = r.at === null ? "" : ` ${new Date(r.at).toISOString().slice(5, 16).replace("T", " ")}`
  return `\`${r.anchor}\`${when}${preMeter(r) ? ` ${DAGGER}` : ""}${r.source === "web" ? " *(web)*" : ""}`
}

function runRow(r: Run): string[] {
  return [
    label(r),
    n0(r.hosts),
    n0(r.onMap),
    n0(r.rivals),
    pct(r.unread, r.onMap),
    g2(r.medGrounded),
    money(r.usd),
    n0(r.seconds),
    perEntity(r),
  ]
}

/** The median run, as a row. Every cell is the median of that column across the
 *  runs — including `$/entity`, which is the median of the per-run ratios and
 *  not the ratio of the medians, because the second is a number no run had. */
function medianRow(runs: Run[]): string[] {
  const col = (f: (r: Run) => number | null) => median(runs.map(f).filter((x): x is number => x !== null))
  return [
    `**median of ${runs.length}**`,
    n0(col((r) => r.hosts)),
    n0(col((r) => r.onMap)),
    n0(col((r) => r.rivals)),
    (() => {
      const m = col((r) => (r.unread === null || r.onMap === 0 ? null : r.unread / r.onMap))
      return m === null ? "—" : `${Math.round(m * 100)}%`
    })(),
    g2(col((r) => r.medGrounded)),
    money(col((r) => r.usd)),
    n0(col((r) => r.seconds)),
    (() => {
      const m = col((r) => (r.usd === null || r.onMap === 0 ? null : r.usd / r.onMap))
      return m === null ? "—" : m.toFixed(4)
    })(),
  ]
}

const HEAD = ["anchor", "hosts", "on map", "rivals", "unread", "grounded", "$", "wall (s)", "$/entity"]

/* --------------------------------------------------------------------- main */

const wantAll = process.argv.includes("--all")

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()

const parsed = files.map(readRun)
const runs = parsed.filter((r): r is Run => "engine" in r)
const skipped = parsed.filter((r): r is Skipped => !("engine" in r))
const byTime = (a: Run, b: Run) => (a.anchor === b.anchor ? (a.at ?? 0) - (b.at ?? 0) : a.anchor.localeCompare(b.anchor))

const current = runs.filter((r) => r.grounded).sort(byTime)
const earlier = runs.filter((r) => !r.grounded).sort(byTime)
const sweeps = current.filter((r) => r.engine === "sweep")
const swarms = current.filter((r) => r.engine === "swarm")

const out: string[] = []
const say = (s = "") => out.push(s)

say("## Results")
say()
say(
  `Every number below is read out of \`runs/*.json\` by \`pnpm bench\`. Nothing here was typed by hand; ` +
    `to argue with a cell, open the run it came from.`,
)
say()
say(
  `Scoped to the **current pipeline** — the ${current.length} runs whose entity rows carry the grounding meter ` +
    `(\`descGrounded\`, \`unreadableReason\`). The other ${earlier.length} maps on disk predate it, cannot produce ` +
    `two of these columns, and were metered under a different price table; they are inventoried below and printed ` +
    `by \`pnpm bench --all\`.`,
)
say()

say("### Sweep — breadth, one pipeline pass")
say()
say(table(HEAD, [...sweeps.map(runRow), medianRow(sweeps)]))
say()

const clerkSweeps = sweeps.filter((r) => r.anchor === "clerk.com")
if (clerkSweeps.length >= 3) {
  const span = (f: (r: Run) => number | null) => {
    const v = clerkSweeps.map(f).filter((x): x is number => x !== null)
    return { lo: Math.min(...v), hi: Math.max(...v) }
  }
  const e = span((r) => r.onMap)
  const d = span((r) => r.usd)
  const s = span((r) => r.seconds)
  say(
    `**Repeatability.** ${clerkSweeps.length} of those rows are the same command on the same anchor ` +
      `(\`clerk.com\`), inside ${Math.round((Math.max(...clerkSweeps.map((r) => r.at ?? 0)) - Math.min(...clerkSweeps.map((r) => r.at ?? 0))) / 3600_000)} hours. ` +
      `The map came back between **${e.lo} and ${e.hi} entities**, for **$${d.lo.toFixed(2)} to $${d.hi.toFixed(2)}**, ` +
      `in **${Math.round(s.lo)}s to ${Math.round(s.hi)}s**. Size is not a property of the anchor; plan for the range, not the median.`,
  )
  say()
}

say("### Swarm — depth, an agent loop")
say()
say(table(HEAD, [...swarms.map(runRow), medianRow(swarms)]))
say()

{
  const mSweep = median(sweeps.map((r) => (r.usd !== null && r.onMap ? r.usd / r.onMap : null)).filter((x): x is number => x !== null))
  const mSwarm = median(swarms.map((r) => (r.usd !== null && r.onMap ? r.usd / r.onMap : null)).filter((x): x is number => x !== null))
  // The ratio is computed from the two numbers this sentence PRINTS, not from
  // the unrounded pair, so a reader who divides the sentence's own figures gets
  // the sentence's own answer. A headline that fails its own arithmetic is how
  // this repo got the hero number it had to retract.
  const shownSwarm = mSwarm === null ? null : Number(mSwarm.toFixed(4))
  const shownSweep = mSweep === null ? null : Number(mSweep.toFixed(4))
  const ratio = shownSwarm && shownSweep ? shownSwarm / shownSweep : null
  const keepSweep = median(sweeps.map((r) => (r.hosts ? r.onMap / r.hosts : null)).filter((x): x is number => x !== null))
  const keepSwarm = median(swarms.map((r) => (r.hosts ? r.onMap / r.hosts : null)).filter((x): x is number => x !== null))
  say(
    `**The swarm costs ${ratio === null ? "—" : `${ratio.toFixed(0)}x`} more per entity than the sweep** ` +
      `($${shownSwarm?.toFixed(4)} vs $${shownSweep?.toFixed(4)}), and that is the trade, not a defect: the sweep puts ` +
      `${keepSweep === null ? "—" : `${Math.round(keepSweep * 100)}%`} of the hosts it saw on the map, the swarm ` +
      `${keepSwarm === null ? "—" : `${Math.round(keepSwarm * 100)}%`}. They are not the same unit. Compare the ` +
      `\`rivals\` and \`unread\` columns before comparing the \`$/entity\` one.`,
  )
  say()
}

/* ------------------------------------------------------- generated footnotes */

say("#### Notes")
say()

{
  const daggered = current.filter(preMeter)
  const post = current.filter((r) => !preMeter(r))
  say(
    `1. **The dollars are what each run's own meter recorded, unadjusted — and no run records which model it ran.** ` +
      `${DAGGER} marks the ${daggered.length} run${daggered.length === 1 ? "" : "s"} stamped before ` +
      `\`600442f\` (2026-08-06 13:11Z) taught the meter per-model prices; until then \`sweep()\` billed every model ` +
      `at gemini-3.5-flash's $1.50/$9.00 per Mtok whatever was actually running, so those figures are one model's ` +
      `price list applied to whoever showed up. The ${post.length} unmarked runs were billed from a table that ` +
      `\`c714538\` (2026-08-08) then found low in two rows out of four — deepseek-v4-flash at $0.088/$0.176 against ` +
      `a re-checked $0.14/$0.28. Treat the model share of an unmarked row as a floor. \`tokIn\`, \`tokOut\` and ` +
      `\`serpCalls\` are in every artifact if you want to reprice it yourself.`,
  )
  say()
}

{
  const perAnchor = new Map<string, Run[]>()
  for (const r of sweeps) perAnchor.set(r.anchor, [...(perAnchor.get(r.anchor) ?? []), r])
  const repeated = [...perAnchor.entries()].filter(([, rs]) => rs.length >= 3).sort((a, b) => b[1].length - a[1].length)[0]
  const swing = repeated
    ? `on \`${repeated[0]}\` alone, ${repeated[1].length} runs of the same command returned between ` +
      `${Math.min(...repeated[1].map((r) => r.companies))} and ${Math.max(...repeated[1].map((r) => r.companies))} ` +
      `rows of kind \`company\``
    : `the split moves run to run`
  const collapsed = sweeps.filter((r) => r.companies + r.products > 0 && r.companies / (r.companies + r.products) < 0.05)
  say(
    `2. **There is no "players" column, because \`kind\` does not reproduce.** ${swing[0]!.toUpperCase()}${swing.slice(1)}, ` +
      `and ${collapsed.length} of ${sweeps.length} sweep runs classify under 5% of their map as \`company\` — everything ` +
      `becomes \`product\`. The web UI counts players as \`kind === "company"\`, which is why a headline "N players" ` +
      `can swing by two orders of magnitude between two runs of one anchor. \`relation\` is the stable field, so ` +
      `\`rivals\` (competitor + substitute) holds that slot instead.`,
  )
  say()
}

{
  const withBoth = sweeps.filter((r) => r.statQueries !== null && r.firedQueries !== null && r.firedQueries > 0)
  const ratios = withBoth.map((r) => r.firedQueries! / r.statQueries!)
  const worst = withBoth.length ? withBoth.reduce((a, b) => (b.firedQueries! / b.statQueries! > a.firedQueries! / a.statQueries! ? b : a)) : null
  say(
    `3. **There is no "queries" column, because \`stats.queries\` is not the number of queries fired.** It is the ` +
      `opening batch; the widening loop fires more and logs them under \`searched\`. Across the ${withBoth.length} ` +
      `current sweep runs that logged both, the run fired a median of **${median(ratios)?.toFixed(1)}x** its stated ` +
      `query count` +
      (worst ? ` — ${label(worst)} reports ${worst.statQueries} and fired ${worst.firedQueries}` : "") +
      `. Reporting the stat would have published the wrong number in the column meant to prove the numbers are right.`,
  )
  say()
}

{
  const withSelf = sweeps.filter((r) => r.selfRow !== null)
  const asRival = withSelf.filter((r) => r.selfRow!.relation === "competitor" || r.selfRow!.relation === "substitute")
  const named = [...new Set(asRival.map((r) => r.anchor))]
  say(
    `4. **The anchor is excluded from every count here, and it should not have needed to be.** ` +
      `${withSelf.length} of ${sweeps.length} sweep runs put the anchor's own domain on its own map` +
      (asRival.length
        ? `, and ${asRival.length} of them type it as a competitor or substitute of itself ` +
          `(${named.map((a) => `\`${a}\``).join(", ")})`
        : "") +
      `. Dropping that row is one line here; it is still a row the engine minted.`,
  )
  say()
}

say(
  `5. **\`grounded\`** is the median \`descGrounded\` over the entities that carry one — the fraction of a ` +
    `description's content terms that appear in the page the description was written from. It is computed over the ` +
    `rows that got a description at all, so the \`unread\` share is not silently scored as perfect.`,
)
say()
say(
  `6. **\`hosts\` vs \`on map\`** is the whole difference between the engines. In the sweep, \`stats.hosts\` equals ` +
    `\`entities.length\` exactly in every current run: one host in, one row out, minus noise. The filtering the ` +
    `README's funnel implies happens in the swarm, not the sweep.`,
)
say()

/* ------------------------------------------------------------- era inventory */

say("#### What else is on disk")
say()
{
  const sig = new Map<string, Run[]>()
  for (const r of runs) {
    const k = `${r.engine}|${r.markers.length ? r.markers.join(" + ") : "(none)"}`
    sig.set(k, [...(sig.get(k) ?? []), r])
  }
  const rows = [...sig.entries()]
    .map(([k, rs]) => {
      const [engine, markers] = k.split("|") as [string, string]
      const ts = rs.map((r) => r.at ?? 0)
      return {
        engine,
        markers,
        n: rs.length,
        first: Math.min(...ts),
        last: Math.max(...ts),
        cur: rs[0]!.grounded,
      }
    })
    .sort((a, b) => a.first - b.first)
  say(
    table(
      ["shape (optional fields on the entity rows)", "engine", "runs", "first", "last", "in the tables above"],
      rows.map((r) => [`\`${r.markers}\``, r.engine, String(r.n), day(r.first), day(r.last), r.cur ? "yes" : "no"]),
    ),
  )
  say()
  say(
    `No run file records its model, its pipeline version or its settings, so the shape of the entity rows is the ` +
      `only era marker there is. That is a gap worth closing: one \`config\` block per artifact would make this ` +
      `inventory unnecessary.`,
  )
  say()
}

if (wantAll) {
  say("#### Runs that predate the grounding meter")
  say()
  say(
    `Printed for completeness, not for comparison: \`unread\` and \`grounded\` cannot exist in these files, and ` +
      `every one of them was metered at a flat $1.50/$9.00 per Mtok regardless of the model that ran.`,
  )
  say()
  for (const engine of ["sweep", "swarm"] as const) {
    const rs = earlier.filter((r) => r.engine === engine)
    if (!rs.length) continue
    say(`**${engine}**`)
    say()
    say(table(HEAD, [...rs.map(runRow), medianRow(rs)]))
    say()
  }
}

/* ----------------------------------------------------------------- provenance */

{
  const cli = runs.filter((r) => r.source === "cli")
  const web = runs.filter((r) => r.source === "web")
  const ts = runs.map((r) => r.at ?? 0).filter(Boolean)
  say(
    `<sub>**Provenance.** \`pnpm bench\` read ${files.length} JSON files in \`runs/\`: ${runs.length} maps ` +
      `(${cli.filter((r) => r.engine === "sweep").length} sweep and ${cli.filter((r) => r.engine === "swarm").length} swarm from the CLI, ` +
      `${web.length} through the web route), ${skipped.length} not a map ` +
      `(${skipped.map((s) => `\`${s.file}\``).slice(0, 2).join(", ")}${skipped.length > 2 ? ", …" : ""}). ` +
      `The runs span ${day(Math.min(...ts))} to ${day(Math.max(...ts))}; ${current.length} carry the grounding meter ` +
      `and are the tables above. Regenerate with \`pnpm bench\`.</sub>`,
  )
}

console.log(out.join("\n"))

if (skipped.length) {
  for (const s of skipped) process.stderr.write(`skipped ${DIR}/${s.file}: ${s.why}\n`)
}
