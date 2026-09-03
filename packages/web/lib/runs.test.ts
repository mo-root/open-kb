import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { format } from "node:util"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { faultNotice, namedFaults } from "./api-error"
import * as db from "./store/supabase"
import {
  cancelRun,
  createRun,
  failRun,
  finishRun,
  getRun,
  getStoredRun,
  listStoredRuns,
  type RunRecord,
} from "./runs"

/* The read that was not guarded.

   `isRunId` refused anything outside the UUID alphabet, and the comment above
   it said the read went through that. It did not. `getStoredRun` caught
   `fileFor`'s refusal in a bare `catch {}` and then built `sweep-<id>.json`
   from whatever string had arrived — and every one of the seven callers hands
   it a URL path segment straight from `/kb/[id]`, `/runs/[id]`, `/api/kb/[id]`
   and friends. `path.join` collapses `..`, so an id spelled with enough of them
   addressed a file outside `runs/` entirely.

   The half of that which stayed theoretical is worth stating plainly: a hit
   still had to parse as JSON and satisfy `adoptCliRun`'s `anchor` + `entities`,
   so this was an arbitrary-JSON read and an existence oracle, not a proven
   disclosure of any file on the host. The tests below are written to fail on
   the weakness rather than on the worst reading of it: the traversal fixture is
   byte-identical to a fixture sitting legitimately inside `runs/`, so the
   refusal cannot pass by accident of shape — the same content, under a name the
   CLI could have written, is still served. */

const UUID = "9d4a2c1e-70bb-4f0a-8b3e-6c5d21f8a704"

/**
 * The id that actually escapes, with the arithmetic spelled out because it is
 * not the obvious one.
 *
 * `path.join` only treats a segment that is exactly `..` as a parent reference,
 * and the id is glued onto a prefix — so `sweep-..` is a literal directory name
 * that eats the first one. The second climbs out of `sweep-..`, the third
 * leaves `runs/`. A single `../bait` lands on `runs/sweep-../bait.json` and
 * misses, which is exactly how a regression test can look green while the hole
 * is wide open; `aims at the bait` below refuses to let that happen quietly.
 */
const OUT = "../../../bait"

/** The bare `SweepResult` the CLI writes — no envelope, no id, which is the
 *  whole reason `adoptCliRun` exists. Only `anchor` and `entities` are load
 *  bearing for adoption; `stats.seconds` is what dates the run. */
function sweepResult(anchor: string) {
  return {
    anchor,
    decomposition: { sells: "s", buyer: "b", products: [], capabilities: [], coinages: [] },
    queries: [],
    entities: [
      { name: "alpha", domain: "alpha.com", kind: "company", what: "w", relation: "competitor", why: "y" },
    ],
    edges: [],
    stats: { queries: 4, serpCalls: 4, results: 40, tokIn: 0, tokOut: 0, usd: 0.4, seconds: 120 },
  }
}

let root: string
let dir: string
const saved: Record<string, string | undefined> = {}

async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2), "utf8")
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openkb-runs-"))
  dir = path.join(root, "runs")
  await mkdir(dir)

  saved.OPENKB_RUNS_DIR = process.env.OPENKB_RUNS_DIR
  saved.SUPABASE_URL = process.env.SUPABASE_URL
  saved.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY
  process.env.OPENKB_RUNS_DIR = dir
  // Unconfigured on purpose. `getStoredRun` ends at `db.getRunRow`, and a suite
  // that reaches Postgres to learn that a traversal was refused is a suite that
  // fails on a train.
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SECRET_KEY

  // A browser-started run: the full envelope, `run-<uuid>.json`.
  await json(path.join(dir, `run-${UUID}.json`), {
    id: UUID,
    domain: "stripe.com",
    queries: 12,
    startedAt: 1_754_000_000_000,
    endedAt: 1_754_000_600_000,
    status: "complete",
    result: sweepResult("stripe.com"),
  })

  // The CLI's three real filename shapes, copied from what `runs/` actually holds.
  await json(path.join(dir, "sweep-stripe-com-202608070005.json"), sweepResult("stripe.com"))
  await json(path.join(dir, "swarm-brightdata-com-202608060833.json"), sweepResult("brightdata.com"))
  await json(path.join(dir, "sweep-resend-com.json"), sweepResult("resend.com")) // pre-stamp
  // `\W` leaves `_` alone, so a slug can carry one. Pins that the alphabet was
  // read off `scripts/sweep.ts` rather than guessed at.
  await json(path.join(dir, "sweep-my_co-202608070005.json"), sweepResult("my_co.example"))

  // The seconds-wide stamp the four writers produce now, and the three-file set
  // that pins the mixed ordering. `chrono` is its own slug so the sort assertion
  // reads only these three and cannot be moved by a fixture added later.
  await json(path.join(dir, "sweep-stripe-com-20260807000509.json"), sweepResult("stripe.com"))
  await json(path.join(dir, "sweep-chrono-202608070005.json"), sweepResult("chrono.example"))
  await json(path.join(dir, "sweep-chrono-20260807000530.json"), sweepResult("chrono.example"))
  await json(path.join(dir, "sweep-chrono-202608070006.json"), sweepResult("chrono.example"))

  // The bait, and its twin. Same bytes: one a directory above `runs/`, where
  // only a traversal reaches it, one inside under a name the CLI could have
  // written. If the traversal tests pass while the twin fails, the refusal is
  // meaningless — the content was never adoptable in the first place.
  await json(path.join(root, "bait.json"), sweepResult("bait.example"))
  await json(path.join(dir, "sweep-bait-202608070005.json"), sweepResult("bait.example"))
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(root, { recursive: true, force: true })
})

describe("getStoredRun — the ids that are real", () => {
  it("reads a browser run by the uuid that minted it", async () => {
    const run = await getStoredRun(UUID)
    expect(run?.id).toBe(UUID)
    expect(run?.domain).toBe("stripe.com")
  })

  it("reads a stamped CLI sweep, with the prefix stripped from the id", async () => {
    const run = await getStoredRun("stripe-com-202608070005")
    expect(run?.id).toBe("stripe-com-202608070005")
    // `anchor` on disk, `domain` in the registry: same value, different word.
    expect(run?.domain).toBe("stripe.com")
    // The stamp is the run's end time, which is what lets the gallery order
    // CLI runs against each other.
    expect(run?.endedAt).toBe(Date.parse("2026-08-07T00:05:00Z"))
  })

  it("reads a swarm run, which keeps its prefix inside the id", async () => {
    const run = await getStoredRun("swarm-brightdata-com-202608060833")
    expect(run?.id).toBe("swarm-brightdata-com-202608060833")
    expect(run?.domain).toBe("brightdata.com")
  })

  it("still reads the unstamped files written before the stamp existed", async () => {
    const run = await getStoredRun("resend-com")
    expect(run?.id).toBe("resend-com")
    expect(run?.domain).toBe("resend.com")
  })

  it("keeps the underscore that the slug rule leaves in place", async () => {
    expect((await getStoredRun("my_co-202608070005"))?.domain).toBe("my_co.example")
  })

  it("serves the bait's exact bytes under a name the CLI could have written", async () => {
    // The control for every refusal below.
    expect((await getStoredRun("bait-202608070005"))?.domain).toBe("bait.example")
  })

  it("lists all of them", async () => {
    const ids = (await listStoredRuns()).map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        UUID,
        "stripe-com-202608070005",
        "swarm-brightdata-com-202608060833",
        "resend-com",
        "my_co-202608070005",
      ]),
    )
  })

  /* The invariant the gallery rests on, stated once so no future guard can
     break it quietly.

     `listStoredRuns` decides what exists by reading filenames; `getStoredRun`
     decides by validating the id. Those two answers drifting apart is the
     failure this module has now had twice — first when a non-UUID file was
     listed and 404'd on click, and again when a length rail was set tighter
     than what the CLI can write. Neither was caught by a test about traversal,
     because neither is about traversal. This is. */
  it("re-reads every id it lists", async () => {
    const listed = await listStoredRuns()
    expect(listed.length).toBeGreaterThan(0)
    const unreadable: string[] = []
    for (const r of listed) if (!(await getStoredRun(r.id))) unreadable.push(r.id)
    expect(unreadable).toEqual([])
  })
})

/* Both id shapes get their own file read, wrapped in its own bare `catch {}`
 * — the browser shape at `fileFor(id)` and the CLI shape at `sweep-<id>.json`
 * — and neither catch had ever run: every fixture above is written with
 * `json()`, so a JSON.parse failure was never on the table for either branch.
 * A run half-written by a crash, or truncated by a full disk, lands exactly
 * here: a real id, a file that opens, content that does not parse. The comment
 * at the CLI branch says this falls through to the store rather than
 * throwing, so the id staying readable — as a miss, not a crash — is the
 * behavior these two pin. */
describe("getStoredRun — a real id whose file will not parse", () => {
  const BROWSER_ID = "0f1e2d3c-4b5a-4978-8765-4321fedcba98"
  const CLI_ID = "corrupt-co-202609010005"

  beforeAll(async () => {
    await writeFile(path.join(dir, `run-${BROWSER_ID}.json`), "not json at all", "utf8")
    await writeFile(path.join(dir, `sweep-${CLI_ID}.json`), "not json at all", "utf8")
  })

  it("misses rather than throws on a browser run that will not parse", async () => {
    await expect(getStoredRun(BROWSER_ID)).resolves.toBeNull()
  })

  it("misses rather than throws on a CLI run that will not parse", async () => {
    await expect(getStoredRun(CLI_ID)).resolves.toBeNull()
  })
})

/* The stamp got two digits wider, and both halves of that are load bearing.

   Minute resolution meant two runs of one domain inside one minute overwrote
   each other — the exact failure stamping was added to prevent. The margin was
   never comfortable: of the 53 stamped maps in `runs/`, 11 finished inside two
   minutes, the closest pair of one domain landed two minutes apart, and the
   fastest sweep on disk ran 49.6s. `scripts/bakeoff.ts` is the caller aimed at
   it, sweeping one domain once per contestant back to back.

   The other half is why these tests exist rather than just the widening. The old
   pattern wanted a hyphen and exactly twelve digits at end-of-string; a fourteen
   digit stamp has a digit twelve-from-the-end, so the pattern would have quietly
   stopped matching and every new CLI run would have dated itself to whenever the
   gallery was loaded. Nothing throws on that path. Only a test notices.

   Every instant below is written as an epoch literal with its ISO spelling in a
   comment, deliberately not as `Date.parse(...)` of the same string the reader
   builds — an expectation assembled the way the code assembles it agrees with the
   code by construction and would survive the widening being wrong. */
describe("the stamp in a CLI id, at both widths", () => {
  it("dates a twelve-digit id to the instant it has always dated to", async () => {
    // `?? -1` only to make the type a number — the assertion on the line below
    // is what fails if the field is missing, and it fails saying so.
    const endedAt = (await getStoredRun("stripe-com-202608070005"))?.endedAt ?? -1
    expect(endedAt).toBe(1_786_061_100_000) // 2026-08-07T00:05:00Z
    // The seconds a minute-wide stamp never carried still read as :00, which is
    // what makes 53 files' worth of existing gallery order survive the change.
    expect(new Date(endedAt).toISOString()).toBe("2026-08-07T00:05:00.000Z")
  })

  it("dates a fourteen-digit id to its actual second", async () => {
    const run = await getStoredRun("stripe-com-20260807000509")
    expect(run?.domain).toBe("stripe.com")
    expect(run?.endedAt).toBe(1_786_061_109_000) // 2026-08-07T00:05:09Z
  })

  it("orders a mixed-width set chronologically, not by width", async () => {
    // The failure this catches is specific: an unmatched fourteen-digit stamp
    // takes `Date.now()`, which is later than every stamped run, so the middle
    // file jumps to the front of a gallery sorted newest-first.
    const listed = (await listStoredRuns()).filter((r) => r.id.startsWith("chrono-"))
    expect(listed.map((r) => [r.id, r.endedAt])).toEqual([
      ["chrono-202608070006", 1_786_061_160_000], // 2026-08-07T00:06:00Z
      ["chrono-20260807000530", 1_786_061_130_000], // 2026-08-07T00:05:30Z
      ["chrono-202608070005", 1_786_061_100_000], // 2026-08-07T00:05:00Z
    ])
  })

  it("still falls back to now for a name that carries no stamp", async () => {
    // `runs/sweep-resend-com.json` is a real file, written before the stamp
    // existed. Zero would sort it to the beginning of time and read as the oldest
    // thing in the gallery; `Date.now()` is the deliberate lie the comment at
    // `adoptCliRun` explains.
    const before = Date.now()
    const run = await getStoredRun("resend-com")
    expect(run?.domain).toBe("resend.com")
    expect(run!.endedAt).toBeGreaterThanOrEqual(before)
    expect(run!.endedAt).toBeLessThanOrEqual(Date.now())
  })

  it("treats a digit tail that is not a date as no stamp at all", async () => {
    // No writer can produce this — all four append a real stamp — so it only
    // arrives hand-written. It used to leave `endedAt` as NaN, which sorts
    // nowhere and renders as "Invalid Date"; unparseable now means what absent
    // means.
    await json(path.join(dir, "sweep-odd-999999999999.json"), sweepResult("odd.example"))
    const before = Date.now()
    const run = await getStoredRun("odd-999999999999")
    expect(run?.domain).toBe("odd.example")
    expect(Number.isNaN(run!.endedAt)).toBe(false)
    expect(run!.endedAt).toBeGreaterThanOrEqual(before)
  })

  /* Four scripts write the stamp and the four spellings must stay byte-identical.

     Not a style rule — b6ffd99 and fbb67b9 are both commits restoring it after
     drift, and a writer left behind at minute width would put two runs back on a
     collision course while the other three looked fixed. Read off disk rather
     than asserted from memory, and the exact expression is pinned as well as the
     count: `toHaveLength(4)` alone stays green if all four drift together. */
  it("keeps one spelling of the stamp across all five writers", async () => {
    const scripts = new URL("../../../scripts/", import.meta.url)
    const names = (await readdir(scripts)).filter((n) => n.endsWith(".ts"))
    const written: string[] = []
    for (const name of names) {
      const text = await readFile(new URL(name, scripts), "utf8")
      for (const line of text.split("\n")) {
        if (line.startsWith("const stamp = new Date")) written.push(line)
      }
    }
    // FIVE, not four: scripts/batch.ts stamps a manifest name. It is exempt from
    // the SHAPE scan below — it writes bookkeeping, not a map — but not from
    // this, because there is only ever one right way to spell an instant here
    // and a manifest dated differently from the maps beside it is the same
    // drift wearing a different extension. It first shipped `/[-:]/g`, which
    // leaves the `T` in.
    expect(written).toHaveLength(5)
    expect(new Set(written).size).toBe(1)
    expect(written[0]).toBe(
      'const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")',
    )
  })
})

/* The rest of the name, and the one reader that has to recognise it.

   The guard above pins the stamp EXPRESSION: four `const stamp = …` lines, byte
   identical. That is the four writers agreeing with EACH OTHER, and it says nothing
   about the name the stamp is spent on — which is the half `adoptCliRun` depends on.
   It needs the prefix it matches, the slug alphabet `isCliRunId` admits, and the
   stamp last, because the date pattern is anchored at end-of-string. Rename a sweep's
   output to `runs/map-…`, or append `-final` after the stamp, and all four stamp
   expressions stay identical while the gallery empties: `listStoredRuns` skips a
   filename it does not recognise, and skipping is not an error. Nothing throws, and
   nothing logs. Between the two guards the claim is whole — every declared stamp is
   spent on a `runs/` filename, and every such filename has the one shape all four
   writers share and this reader can parse.

   Read off the writers, never off `runs/`. The fixtures at the top of this file are
   names copied from disk, and a copied name cannot notice a writer changing.

   The bake-off is the one writer held out of the round trip, for the reason its own
   test states. The demo is IN it, on the negative side: "the gallery never adopts a
   demo run" is a claim scripts/demo-investigate.ts:100-105 makes in prose, load
   bearing for that file's stamp being unparsed on purpose, and nothing was checking
   it. */
describe("the filename each CLI writes, against the reader that parses it back", () => {
  // `\W+ → -` is the writers' own slug rule, so an anchor of `coupling.example` is
  // written `coupling-example`. Substituted here rather than executed: the pattern
  // below pins that the rule is still spelled `.replace(/\W+/g, "-")`, which is the
  // same check made in text instead of at runtime.
  const ANCHOR = "coupling.example"
  const SLUG = "coupling-example"
  const STAMP = "20260807000509"
  const INSTANT = 1_786_061_109_000 // 2026-08-07T00:05:09Z

  /** The one shape all four writers share, with every part a reader depends on inside
   *  the pattern: directory, prefix, slug rule, stamp last, extension. A stamped name
   *  that does not match is a name this test cannot vouch for, and says so. */
  const WRITES =
    /^const \w+ = `(runs\/(?:experiments\/)?)([a-z]+-)\$\{\w+\.replace\(\/\\W\+\/g, "-"\)\}-\$\{stamp\}(\.\w+)`$/

  /** Every `runs/` filename in scripts/ that spends a stamp, keyed by the script that
   *  writes it, resolved for one known anchor at one known instant. */
  async function writerShapes(): Promise<Map<string, { name: string; dir: string; ext: string }>> {
    const scripts = new URL("../../../scripts/", import.meta.url)
    const found = new Map<string, { name: string; dir: string; ext: string }>()
    for (const file of (await readdir(scripts)).filter((n) => n.endsWith(".ts"))) {
      const text = await readFile(new URL(file, scripts), "utf8")
      for (const line of text.split("\n")) {
        // Keyed on the DESTINATION, not on a variable called `stamp`. The first
        // draft required the literal `${stamp}`, which meant a fifth CLI writing
        // a perfectly gallery-shaped name while calling its variable `ts` was
        // invisible — and since the assertion below compares what was FOUND, an
        // invisible writer left the set at four and passed. A guard whose whole
        // job is noticing a fifth writer must not be evadable by renaming a
        // local. Any `runs/` template with a file extension is in scope now, and
        // anything in scope that is not the shared shape throws by name.
        // Comments first, and this is a widening the guard can afford. A line
        // that is prose cannot write a file, and `scripts/bench.ts` — a READER,
        // which totals `runs/*.json` into a table and writes nothing — tripped
        // this on its own header comment describing where its numbers come
        // from. The alternative was a second by-name exemption beside
        // audit.ts's, which would have said "bench.ts is allowed to write a
        // shape we cannot read" when the truth is that it does not write at
        // all. Skipping prose costs no detection: a writer is a statement.
        const bare = line.trim()
        if (bare.startsWith("*") || bare.startsWith("//") || bare.startsWith("/*")) continue
        if (!/`runs\/[^`]*\.\w+`/.test(line)) continue
        // `scripts/audit.ts` writes into `runs/` too and is deliberately not a
        // stamped writer: its name carries a run id and a packet count, nothing
        // reads a date out of it, and audit.ts:89 refuses rather than overwrites.
        // Exempt by name and by reason, so a sixth exemption has to be argued.
        if (file === "audit.ts") continue
        // `scripts/batch.ts` writes into `runs/` too and is a MANIFEST writer,
        // not a map writer. It records what a fifty-domain build decided about
        // each domain, one JSON line appended per outcome, so `--resume` can
        // read back what is still owed; it produces no map and the gallery
        // cannot adopt it. Exempt by name and by reason, like audit.ts above,
        // and the assertion below proves the reason rather than trusting it —
        // this is the decision the "no fifth writer" test exists to force, made
        // here instead of discovered later as a card that never appears.
        if (file === "batch.ts") continue
        const m = WRITES.exec(line.trim())
        if (!m) {
          throw new Error(`${file} writes a stamped name in a shape this test cannot read: ${line.trim()}`)
        }
        found.set(file, { name: `${m[1]}${m[2]}${SLUG}-${STAMP}${m[3]}`, dir: m[1], ext: m[3] })
      }
    }
    return found
  }

  it("finds four writers and no fifth", async () => {
    // A fifth CLI writing a stamped name into `runs/` has to decide whether the
    // gallery adopts it, and this is where that decision gets made rather than
    // discovered later by a card that never appears.
    expect([...(await writerShapes()).keys()].sort()).toEqual([
      "bakeoff.ts",
      "demo-investigate.ts",
      "swarm.ts",
      "sweep.ts",
    ])
  })

  it("keeps the batch manifest out of the gallery, by two independent facts", async () => {
    // The exemption above is only honest while the gallery genuinely cannot
    // read this file, so that is asserted rather than asserted-in-a-comment.
    // `listStoredRuns` takes a name only when it ends `.json` AND starts with
    // one of three prefixes; the manifest fails both, so either one changing is
    // not enough to let it in. Read out of batch.ts itself, so renaming the file
    // there breaks this test rather than silently publishing a manifest.
    const src = await readFile(new URL("../../../scripts/batch.ts", import.meta.url), "utf8")
    const written = /`(runs\/[^`]*\$\{stamp\}[^`]*)`/.exec(src)
    expect(written, "batch.ts no longer writes a stamped manifest — re-argue the exemption").not.toBeNull()
    const name = written![1]!.replace("runs/", "").replace("${stamp}", STAMP)
    expect(name.endsWith(".json")).toBe(false)
    expect(["run-", "sweep-", "swarm-"].some((p) => name.startsWith(p))).toBe(false)
  })

  it("writes two names the gallery adopts, each dated to the stamp it wrote", async () => {
    const shapes = await writerShapes()
    for (const script of ["sweep.ts", "swarm.ts"]) {
      // The directory is half the shape, and `path.basename` below throws it
      // away — so a writer that moved its output into a subdirectory the
      // gallery never reads would land the fixture in the flat temp `runs/`
      // anyway and pass. That is the same silent emptying this test's header
      // describes, arriving by relocation instead of by rename.
      expect(shapes.get(script)!.dir, `${script} must write into runs/ itself`).toBe("runs/")
      await json(path.join(dir, path.basename(shapes.get(script)!.name)), sweepResult(ANCHOR))
    }
    const adopted = (await listStoredRuns()).filter((r) => r.domain === ANCHOR)
    // The ids the gallery mints out of those names — the URLs its cards link to.
    expect(adopted.map((r) => r.id).sort()).toEqual([`${SLUG}-${STAMP}`, `swarm-${SLUG}-${STAMP}`])
    // And the instant, which is the part that fails quietly. A stamp the pattern no
    // longer matches does not throw, it falls back to `Date.now()` — every CLI run
    // dated to whenever the page was loaded, in a gallery sorted newest-first.
    for (const r of adopted) expect(r.endedAt).toBe(INSTANT)
    // Listed and readable are two different answers here and have drifted apart
    // twice, so the slug a CLI produces has to clear `isCliRunId` as well.
    for (const r of adopted) expect((await getStoredRun(r.id))?.domain).toBe(ANCHOR)
  })

  it("keeps the demo out of the gallery by its prefix, exactly as its comment claims", async () => {
    const demo = (await writerShapes()).get("demo-investigate.ts")!
    expect(demo.name).toBe(`runs/demo-${SLUG}-${STAMP}.json`)
    // A body that WOULD adopt, so the prefix is the only thing keeping it out:
    // `listStoredRuns` matches `run-`, `sweep-` and `swarm-` and nothing else. Should
    // a demo ever want adopting, `adoptCliRun` needs a third branch first — it strips
    // `sweep-`'s six characters from every non-swarm name, so a `demo-` file reaching
    // it comes back with an id two letters short of its own slug.
    await json(path.join(dir, path.basename(demo.name)), sweepResult("demo-only.example"))
    const listed = await listStoredRuns()
    expect(listed.some((r) => r.domain === "demo-only.example")).toBe(false)
  })

  it("keeps the bake-off out on two counts, neither of them its stamp", async () => {
    // Held out of the round trip deliberately: it writes a markdown table, not a map,
    // into a subdirectory. `listStoredRuns` reads one flat directory and only `.json`
    // inside it, so either fact alone would be enough — both are pinned so that losing
    // one cannot be silently survived by the other.
    const bakeoff = (await writerShapes()).get("bakeoff.ts")!
    expect(bakeoff.dir).toBe("runs/experiments/")
    expect(bakeoff.ext).toBe(".md")
  })
})

describe("getStoredRun — the ids that are not", () => {
  it("aims at the bait — the premise every refusal below rests on", () => {
    // Not a test of `runs.ts` at all, a test of this test: if the fixture layout
    // ever drifts, the traversals stop reaching anything and the refusals below
    // start passing for the wrong reason. Pin the arithmetic instead.
    const bait = path.join(root, "bait.json")
    expect(path.join(dir, `sweep-${OUT}.json`)).toBe(bait)
    expect(path.join(dir, `swarm-${OUT}.json`)).toBe(bait)
  })

  it("refuses the traversal that reached the bait", async () => {
    // Pre-fix this returned `{ domain: "bait.example" }` — the same bytes the
    // control above serves, read from a directory the reader has no business in.
    expect(await getStoredRun(OUT)).toBeNull()
  })

  it("refuses it through the swarm prefix too, which skips the sweep- interpolation", async () => {
    expect(await getStoredRun(`swarm-${OUT}`)).toBeNull()
  })

  it("refuses the two ids from the report", async () => {
    expect(await getStoredRun("../../../../etc/passwd")).toBeNull()
    expect(await getStoredRun("swarm-../../../etc/passwd")).toBeNull()
  })

  it("refuses an absolute path in either spelling", async () => {
    expect(await getStoredRun("/etc/passwd")).toBeNull()
    expect(await getStoredRun("swarm-/etc/passwd")).toBeNull()
    expect(await getStoredRun(path.join(root, "bait"))).toBeNull()
    expect(await getStoredRun("C:\\Windows\\win.ini")).toBeNull()
    expect(await getStoredRun("..\\bait")).toBeNull()
  })

  it("refuses a NUL rather than letting the filename be truncated at it", async () => {
    // Node throws on a NUL in a path, so this used to surface as an exception
    // swallowed by the fallthrough. Refused up front, it is an ordinary miss.
    await expect(getStoredRun("bait-202608070005\u0000.png")).resolves.toBeNull()
    await expect(getStoredRun("swarm-\u0000")).resolves.toBeNull()
  })

  it("refuses encoded separators, decoded or not", async () => {
    // Next decodes a path segment before the route sees it, so `%2e%2e%2f`
    // arrives as `../` — already covered. These are the forms that survive when
    // something upstream does not decode, or decodes only once.
    expect(await getStoredRun("..%2fbait")).toBeNull()
    expect(await getStoredRun("%2e%2e%2fbait")).toBeNull()
    expect(await getStoredRun("....//bait")).toBeNull()
    expect(await getStoredRun("..%252fbait")).toBeNull()
  })

  it("refuses a leading dot and a bare dot segment", async () => {
    expect(await getStoredRun(".bait")).toBeNull()
    expect(await getStoredRun("..")).toBeNull()
    expect(await getStoredRun(".")).toBeNull()
    expect(await getStoredRun("swarm-..")).toBeNull()
  })

  it("refuses the empty id", async () => {
    expect(await getStoredRun("")).toBeNull()
  })

  /* The length rail, guarded from below rather than from above.

     An assertion that some enormous id returns null proves nothing: a name
     component caps at 255 bytes, so `readFile` answers ENAMETOOLONG and the
     bare `catch` returns null whether or not any bound exists. The first draft
     of this file asserted exactly that and stayed green against the unguarded
     reader.

     The real risk runs the other way. Both CLIs take the anchor raw from argv,
     so a long URL pasted as a domain slugs into a long id — a real
     `grundfos.com` deep link produced 126 characters — and a rail set by taste
     rather than by the filesystem silently un-reads those runs: listed by
     `listStoredRuns`, refused by `getStoredRun`, a gallery card opening onto
     nothing. So the case worth pinning is the longest id that can exist. */
  it("still reads the longest id the CLI can actually write", async () => {
    const longest = "a".repeat(255 - "sweep-".length - ".json".length)
    await writeFile(
      path.join(dir, `sweep-${longest}.json`),
      JSON.stringify(sweepResult("longest.com")),
      "utf8",
    )
    expect(await getStoredRun(longest)).toMatchObject({ domain: "longest.com" })
  })
})

describe("getStoredRun — where OPENKB_RUNS_DIR points", () => {
  it("holds when the runs dir is relative to the cwd", async () => {
    // `runsDir()` returns the env var verbatim, so it can be relative; the
    // containment check has to resolve both sides before comparing them or a
    // relative dir makes every path look foreign.
    process.env.OPENKB_RUNS_DIR = path.relative(process.cwd(), dir)
    try {
      expect((await getStoredRun("bait-202608070005"))?.domain).toBe("bait.example")
      expect(await getStoredRun(OUT)).toBeNull()
    } finally {
      process.env.OPENKB_RUNS_DIR = dir
    }
  })

  it("holds when the runs dir is written with a trailing separator", async () => {
    // The containment test is `resolved.startsWith(dir + sep)`, which is only
    // correct because `dir` has been normalised first.
    process.env.OPENKB_RUNS_DIR = dir + path.sep
    try {
      expect((await getStoredRun("bait-202608070005"))?.domain).toBe("bait.example")
      expect(await getStoredRun(OUT)).toBeNull()
    } finally {
      process.env.OPENKB_RUNS_DIR = dir
    }
  })

  it("does not treat a sibling whose name merely starts the same as inside", async () => {
    // `/srv/runs-evil` must not read as inside `/srv/runs`. The alphabet already
    // makes this unreachable through an id, so point the dir itself at the
    // sibling and confirm the two directories stay separate universes.
    const evil = path.join(root, "runs-evil")
    await mkdir(evil, { recursive: true })
    await json(path.join(evil, "sweep-evil-202608070005.json"), sweepResult("evil.example"))
    try {
      expect(await getStoredRun("evil-202608070005")).toBeNull()
      process.env.OPENKB_RUNS_DIR = evil
      expect((await getStoredRun("evil-202608070005"))?.domain).toBe("evil.example")
      expect(await getStoredRun("bait-202608070005")).toBeNull()
    } finally {
      process.env.OPENKB_RUNS_DIR = dir
    }
  })
})

/* The directory `runsPath` cannot build a floor under.

   Everything above this point is about the FILENAME. This is about the
   DIRECTORY, which the containment check takes as given: `runsPath` compares a
   resolved path against `dir + path.sep`, and `path.resolve` strips the
   trailing separator from every path except a filesystem root. So for `/` that
   floor is `//`, nothing resolves under it, and every id is refused as
   `outside runs/` — the real ones too. On the CLI branch that throw sits
   outside the try on purpose, so it left the module: `/kb/<id>` answered 500
   with `outside runs/: sweep-<uuid>.json`, a message naming the id for a
   mistake made in the environment.

   The second describe is the more important one. A refusal is only worth having
   if it arrives: `listStoredRuns` wraps `readdir` in a catch that means "no
   runs/ yet", and a refusal falling into it is an empty gallery with nothing
   said — quieter than the 500 it replaced, and therefore worse. */
describe("OPENKB_RUNS_DIR pointed at a filesystem root", () => {
  /** The message a read refuses with, or "" if it did not refuse at all — which
   *  every assertion below reads as the failure it is. */
  async function refusalFrom(value: string, read: () => Promise<unknown>): Promise<string> {
    process.env.OPENKB_RUNS_DIR = value
    try {
      await read()
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      process.env.OPENKB_RUNS_DIR = dir
    }
    return ""
  }

  it("names the variable instead of blaming the id that happened to arrive", async () => {
    const message = await refusalFrom(path.parse(process.cwd()).root, () => getStoredRun(UUID))
    expect(message).toContain("OPENKB_RUNS_DIR")
    expect(message).toContain("filesystem root")
    // An operator error, so the remedy is the product.
    expect(message).toMatch(/subdirector/i)
    // And the half that was actively misleading: the old message quoted the
    // filename it had just built, so a reader went looking at the id.
    expect(message).not.toContain("outside runs/")
    expect(message).not.toContain(UUID)
  })

  it("prints the path it resolved, not the spelling that was typed", async () => {
    const rootDir = path.parse(process.cwd()).root
    // `//` resolves to `/`. Naming the resolved value is what makes the message
    // actionable when the variable was written as an expression that collapsed.
    const message = await refusalFrom(rootDir + path.sep, () => getStoredRun(UUID))
    expect(message).toContain(`resolves to ${rootDir}`)
  })

  it("refuses a relative value that climbs all the way to the root", async () => {
    // Resolved before it is judged, for the same reason `runsPath` resolves:
    // the variable may be relative, and `../../..` is a root spelled from a
    // distance.
    const up = path.relative(process.cwd(), path.parse(process.cwd()).root)
    expect(await refusalFrom(up, () => getStoredRun(UUID))).toContain("OPENKB_RUNS_DIR")
  })

  it("is a fault the pages may print, and they print all of it", async () => {
    // The end of the journey the refusal exists for: thrown by `checkedDir`,
    // caught by /kb and /runs, handed to `faultNotice`, rendered. Those pages
    // may only repeat a sentence lib/api-error.ts wrote, so this is what keeps
    // the bound from quietly costing an operator the one message that tells
    // them which variable to change.
    process.env.OPENKB_RUNS_DIR = path.parse(process.cwd()).root
    let thrown: unknown
    try {
      await listStoredRuns()
    } catch (e) {
      thrown = e
    } finally {
      process.env.OPENKB_RUNS_DIR = dir
    }
    expect(thrown).toBeInstanceOf(Error)

    const shown = faultNotice(thrown, "GET /kb")
    expect(shown).toBe((thrown as Error).message)
    expect(shown).toContain("OPENKB_RUNS_DIR")
    expect(shown).toMatch(/subdirector/i)
  })

  it("survives the catch that means \"no runs/ yet\" instead of emptying the gallery", async () => {
    // THE TRAP. `readdir("/")` succeeds and simply holds no `run-*.json`, so
    // before this the misconfiguration rendered as a tidy "Nothing mapped yet."
    // A refusal thrown inside that catch would render the same way. Failing
    // here means the check is in a place where nobody will ever read it.
    const message = await refusalFrom(path.parse(process.cwd()).root, () => listStoredRuns())
    expect(message).toContain("OPENKB_RUNS_DIR")
  })
})

/* The registry that is THERE and cannot be read.

   The describe above is about the one directory `runsPath` cannot build a floor
   under, and an operator has to type `/` into OPENKB_RUNS_DIR to reach it. These
   are the two that actually happen. Measured on a production server:
   OPENKB_RUNS_DIR pointed at a `chmod 000` directory, and at a regular file —
   /kb and /runs both answered 200 with an empty gallery and no banner, because
   `listStoredRuns` wrapped `readdir` in a bare catch under a comment naming one
   specific meaning, and every other failure fell into it. 81bd308 hoisted
   `runsDir()` out of that try to keep one refusal away from the swallow; the
   swallow underneath went on taking all the others.

   CONSTRUCTED, NOT MOCKED, and that is not a preference. The claim is about
   errnos — that ENOENT is the absence and EACCES and ENOTDIR are not — and a
   mocked `fs` proves only that a mock returns what the test told it to. A
   `chmod 000` directory really does answer EACCES to `readdir` and to
   `readFile`; a regular file really does answer ENOTDIR to both; a symlink to
   nothing really does answer ENOENT rather than something of its own.

   SOME CASES ARE NOT BUILT AND ARE NOT FAKED. An errno with no remedy in the
   environment — EMFILE wants the process out of descriptors, EIO wants a failing
   disk — cannot be constructed here without wrecking the run or the host. The
   default those take is pinned instead through EISDIR, which is constructible
   and is unenumerated in exactly the same way; the last suite in this group
   names all three and says which is which.

   AND THE OTHER DIRECTION, which is easier to break and worse to break. A
   genuinely absent runs/ must stay silent: `runs/` is gitignored, so a fresh
   clone has none, and a fresh clone is what CI checks out. "the case CI is"
   below builds that condition in an empty directory rather than arguing about
   it. */

/**
 * Whether `chmod` still means anything here.
 *
 * Root bypasses the permission check outright, and Windows has no mode bits
 * worth the name. On either, the sealed fixtures below would be ordinary
 * readable directories and every assertion about a refusal would pass for the
 * wrong reason — green over a case that never happened. Declared in
 * scripts/check-skips.mjs, so a run where this suite is dark says so out loud
 * instead of printing the same tick as a run where it is not.
 */
const CHMOD_BITES = process.platform !== "win32" && process.getuid?.() !== 0

/** A read through a given OPENKB_RUNS_DIR: what it answered, or what it threw.
 *  Tagged rather than two helpers, because half these tests are about a read
 *  refusing and the other half are about the same read NOT refusing, and both
 *  halves have to be able to fail. */
type Read<T> = { ok: T } | { threw: Error }

async function readingFrom<T>(value: string, read: () => Promise<T>): Promise<Read<T>> {
  process.env.OPENKB_RUNS_DIR = value
  try {
    return { ok: await read() }
  } catch (e) {
    // Everything on this path throws an Error; anything else is the finding.
    expect(e).toBeInstanceOf(Error)
    return { threw: e as Error }
  } finally {
    process.env.OPENKB_RUNS_DIR = dir
  }
}

/** The message a read refused with, or "" when it did not refuse — which every
 *  assertion below reads as the failure it is. */
function refusalIn(r: Read<unknown>): string {
  return "threw" in r ? r.threw.message : ""
}

/**
 * A runs directory that exists, holds one real CLI run, and will not be opened.
 *
 * Handed back readable whatever happens, and the `finally` is load bearing:
 * `rm -rf` cannot descend into a directory with no execute bit, so a fixture
 * left at mode 000 takes `afterAll`'s cleanup down with it and leaks a temp tree
 * per run.
 */
async function sealed<T>(mode: number, use: (at: string) => Promise<T>): Promise<T> {
  const at = await mkdtemp(path.join(root, "sealed-"))
  await json(path.join(at, "sweep-sealed-202608070005.json"), sweepResult("sealed.example"))
  await chmod(at, mode)
  try {
    return await use(at)
  } finally {
    await chmod(at, 0o755)
  }
}

describe("a runs directory that is not there at all", () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(format(...args))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("is an empty gallery, and says nothing whatever about it", async () => {
    expect(await readingFrom(path.join(root, "never-created"), () => listStoredRuns())).toEqual({
      ok: [],
    })
    expect(logged).toEqual([])
  })

  it("the case CI is: a clone with no runs/ in it", async () => {
    // Not a restatement of the test above. That one points at a name inside a
    // directory this suite made; this one is the shape of the machine — an empty
    // checkout, `runs/` gitignored and therefore absent, which is what a runner
    // gets every time. A change that turns absence into an error breaks a
    // workflow that has never run, so nobody would see it coming.
    const clone = await mkdtemp(path.join(tmpdir(), "openkb-clone-"))
    try {
      expect(await readingFrom(path.join(clone, "runs"), () => listStoredRuns())).toEqual({ ok: [] })
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  })

  it("is still absence when the missing thing is a parent", async () => {
    expect(await readingFrom(path.join(root, "no", "such", "runs"), () => listStoredRuns())).toEqual(
      { ok: [] },
    )
  })

  it("is still absence when the path is a link whose target was never created", async () => {
    // Measured: `readdir` answers ENOENT here, not ELOOP or anything of its own.
    // What is being asked about is a directory and there is no directory; the
    // link is a detail of the path, not a second fact about it.
    const dangling = path.join(root, "dangling-runs")
    await symlink(path.join(root, "no-such-target"), dangling)
    expect(await readingFrom(dangling, () => listStoredRuns())).toEqual({ ok: [] })
  })

  it("does not make getStoredRun invent a fault either", async () => {
    expect(await readingFrom(path.join(root, "never-created"), () => getStoredRun(UUID))).toEqual({
      ok: null,
    })
    expect(logged).toEqual([])
  })
})

describe("a runs directory that is a file", () => {
  /** Named without `runs` in it on purpose: two assertions below check that the
   *  message does not quote the id it was asked for, and a fixture called
   *  `runs-something` would make those pass or fail on the fixture's spelling. */
  const asFile = () => path.join(root, "flat-file")

  beforeAll(async () => {
    await writeFile(asFile(), "not a directory", "utf8")
  })

  it("says so, instead of showing an empty gallery", async () => {
    const message = refusalIn(await readingFrom(asFile(), () => listStoredRuns()))
    expect(message).toContain("is unusable")
    expect(message).toContain("not a directory")
    expect(message).toContain(asFile())
    // An operator error, so the remedy is the product — the same standard the
    // filesystem-root refusal is held to.
    expect(message).toContain("OPENKB_RUNS_DIR")
    // And the distinction the whole item is about, said in so many words.
    expect(message).toContain("not an empty one")
  })

  it("says the same thing to /kb/<id> as it says to /kb", async () => {
    // A truth /kb learns and /kb/<id> does not is half a fix. `getStoredRun`
    // swallowed this same ENOTDIR in two bare catches and the page rendered "No
    // knowledge base called <id>" — a dead end presented as an answer, over a
    // registry that may well hold the run.
    const list = refusalIn(await readingFrom(asFile(), () => listStoredRuns()))
    expect(list).not.toBe("")
    expect(refusalIn(await readingFrom(asFile(), () => getStoredRun(UUID)))).toBe(list)
    expect(
      refusalIn(await readingFrom(asFile(), () => getStoredRun("stripe-com-202608070005"))),
    ).toBe(list)
  })

  it("answers an id no alphabet admits with a miss, while the listing still refuses", async () => {
    // THE STATE THE /kb/[id] NOT-FOUND BRANCH RENDERS IN, pinned here because it
    // is the only half of that page reachable without standing Next up.
    //
    // The test above is the ids that DO satisfy an alphabet, and for those the
    // page never renders at all — `getStoredRun` throws and app/error.tsx takes
    // it. The gap is an id satisfying neither: `getStoredRun` touches disk only
    // inside `isRunId` or `isCliRunId`, so a dot, a space or 251 characters
    // never reads anything, the miss is the alphabet's own answer, and the page
    // goes on to ask for the did-you-mean list — which is where the unreadable
    // directory finally speaks. Both facts at once are what made "Nothing has
    // been mapped yet." printable over a registry full of maps.
    //
    // So this must keep being TWO different answers to one broken directory. The
    // day `getStoredRun` refuses these ids as well, the page's catch is dead
    // code and this line says so.
    const list = refusalIn(await readingFrom(asFile(), () => listStoredRuns()))
    expect(list).not.toBe("")
    expect(await readingFrom(asFile(), () => getStoredRun("some.thing"))).toEqual({ ok: null })
  })

  it("blames the directory, never the id that happened to arrive", async () => {
    // 81bd308's other half, which this must not undo: `/kb/<id>` once answered
    // `outside runs/: sweep-<uuid>.json`, sending a reader to stare at an id for
    // a mistake made in the environment. A permission bit is the same mistake in
    // a different place, and gets the same treatment.
    const message = refusalIn(await readingFrom(asFile(), () => getStoredRun(UUID)))
    expect(message).not.toContain(UUID)
    expect(message).not.toContain(".json")
  })
})

describe.skipIf(!CHMOD_BITES)("a runs directory that refuses to be read", () => {
  it("says so, instead of showing an empty gallery", async () => {
    const message = await sealed(0o000, async (at) =>
      refusalIn(await readingFrom(at, () => listStoredRuns())),
    )
    expect(message).toContain("is unusable")
    expect(message).toContain("not allowed to read it")
    expect(message).toMatch(/permission/i)
    expect(message).toContain("not an empty one")
  })

  it("says the same thing to /kb/<id> as it says to /kb", async () => {
    const [one, all] = await sealed(0o000, async (at) => [
      refusalIn(await readingFrom(at, () => getStoredRun("sealed-202608070005"))),
      refusalIn(await readingFrom(at, () => listStoredRuns())),
    ])
    expect(all).not.toBe("")
    expect(one).toBe(all)
  })

  it("does not let a directory it can list but not open read as empty", async () => {
    // Mode `r--`, and it is the reason the per-file catch classifies as well as
    // the `readdir` one. Measured: `readdir` SUCCEEDS and every file inside
    // answers EACCES, so a fix that only guards the listing leaves the gallery
    // short by its entire contents, with nothing but a log line per run to show
    // for it — the same lie, one syscall along.
    const message = await sealed(0o444, async (at) =>
      refusalIn(await readingFrom(at, () => listStoredRuns())),
    )
    expect(message).toContain("not allowed to read it")
  })

  it("is a fault the pages print in full, carrying none of the OS's own words", async () => {
    // TWO DECISIONS IN ONE ASSERTION, because they are the same decision.
    //
    // A ref would be wrong here: an operator whose runs/ is chmod 000 has
    // something to FIX, and "quote ref 4b1c…" sends them to a server log to find
    // out what. `runsDirIsRoot` set that precedent for the rare misconfiguration;
    // this is the common one, so it is on the shelf too.
    //
    // And being on the shelf is exactly what makes the OS's words dangerous.
    // Node's message is `EACCES: permission denied, scandir '/var/…'` — a caught
    // string, which is what backlog 3h is open about and what a page may not
    // print. So lib/runs.ts classifies the errno where the Error object still is
    // and passes a KEY; the sentence is a literal in lib/api-error.ts with two
    // holes, a path this module resolved and that key.
    const { shown, thrown } = await sealed(0o000, async (at) => {
      const r = await readingFrom(at, () => listStoredRuns())
      expect("threw" in r).toBe(true)
      const err = (r as { threw: Error }).threw
      return { shown: faultNotice(err, "GET /kb"), thrown: err.message }
    })
    expect(shown).toBe(thrown)
    expect(shown).not.toMatch(/quote ref/)
    for (const os of ["EACCES", "permission denied", "scandir", "errno", "syscall"]) {
      expect(shown).not.toContain(os)
    }
  })
})

describe("a runs directory the filesystem cannot name", () => {
  it("says so for a symbolic link that leads back to itself", async () => {
    const a = path.join(root, "loop-a")
    const b = path.join(root, "loop-b")
    await symlink(b, a)
    await symlink(a, b)
    const message = refusalIn(await readingFrom(a, () => listStoredRuns()))
    expect(message).toContain("cannot name a directory")
    expect(message).toContain("leads back to itself")
  })

  it("says so for a name longer than the filesystem allows", async () => {
    // ENAMETOOLONG. Not absence — nothing is missing, the value simply cannot be
    // turned into a name — and not something a retry or another deploy fixes.
    const message = refusalIn(
      await readingFrom(path.join(root, "z".repeat(400)), () => listStoredRuns()),
    )
    expect(message).toContain("cannot name a directory")
  })
})

/* An errno this module never enumerated, and the three that could not be built.

   EISDIR, from a DIRECTORY sitting inside runs/ under exactly the name a CLI run
   would have. `readdir` lists it happily and `readFile` answers EISDIR, which is
   not ENOENT and is not in TROUBLE — so it takes the default, and whatever it
   does here is what the next unfamiliar errno will do.

   The three that are named rather than faked, because a fake would be the test
   asserting its own mock:

     EMFILE  wants the process out of descriptors. The limit on this machine is
             1,048,576 — 100,000 open handles did not move `readdir` at all — so
             reaching it costs more than the assertion is worth and would leave a
             vitest worker one descriptor from failing for unrelated reasons.
     EIO     wants a disk that is failing.
     a NUL   was tried and does not survive the trip: `process.env` truncates at
             the first NUL, so `OPENKB_RUNS_DIR` cannot carry one and the read
             simply succeeds against the untruncated path. Worth writing down —
             it looks like the easy case and it is not a case at all.

   What EISDIR pins for all three is the RULE, which is the thing under test:
   classification is by errno, absence is ENOENT alone, and everything else is
   loud. */
describe("an errno this module never enumerated", () => {
  let logged: string[]
  let at: string

  beforeAll(async () => {
    at = await mkdtemp(path.join(root, "eisdir-"))
    // A directory wearing a run's name, beside a real run so the contrast in the
    // third test has something to be a contrast with.
    await mkdir(path.join(at, "sweep-notafile-202608070005.json"))
    await json(path.join(at, "sweep-real-202608070005.json"), sweepResult("real.example"))
  })

  beforeEach(() => {
    logged = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(format(...args))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("is thrown by a direct read rather than folded into a miss", async () => {
    // THE DEFAULT, in the direction that matters. Swallowing by default is what
    // the bug WAS, and its failure mode is the whole class rather than one
    // errno: every unfamiliar filesystem failure reported as "nothing here",
    // silently, on every filesystem this is ever deployed onto.
    const r = await readingFrom(at, () => getStoredRun("notafile-202608070005"))
    expect("threw" in r).toBe(true)
    expect(r).not.toEqual({ ok: null })
  })

  it("answers with a ref, because there is no remedy to name", async () => {
    // And this is why TROUBLE is narrower than the throw. A named fault is a
    // sentence telling an operator what to change; there is nothing to change
    // here, so the honest answer is the fixed sentence plus a token, with the
    // real cause on the log line that token names. Widening TROUBLE to cover
    // "everything that throws" would put the OS's own words on a page.
    const r = await readingFrom(at, () => getStoredRun("notafile-202608070005"))
    const shown = faultNotice((r as { threw: Error }).threw, "GET /kb")
    expect(shown).toMatch(/quote ref [0-9a-f]{12}/)
    expect(shown).not.toContain("EISDIR")
    expect(shown).not.toContain("illegal operation")
    expect(logged.join("\n")).toContain("EISDIR")
  })

  it("is skipped by the listing, which is the one place the default differs", async () => {
    // Deliberate, and the asymmetry IS the decision. `readdir` has just handed
    // over a whole directory of names, so one unreadable name is a fact about
    // that name and the other runs are still owed to the reader — the rule this
    // file already had for a file that does not parse. `getStoredRun` has
    // exactly one name and it failed, so there is nothing else to show. Only a
    // directory-level errno overrides this, which the `r--` case above pins.
    const r = await readingFrom(at, () => listStoredRuns())
    expect("ok" in r && r.ok.map((run) => run.id)).toEqual(["real-202608070005"])
    expect(logged.join("\n")).toContain("skipping unreadable sweep-notafile-202608070005.json")
  })
})

/* What a failed run is allowed to say about why it failed.

   `failRun` receives whatever the SWEEP threw, and that is an OpenRouter or a
   Bright Data error: provider detail, request ids, and occasionally a fragment
   of a key or an account id. It reached two readers verbatim — `GET
   /api/run/[id]` spreads `run.error` into a production body, and the
   `ui:results` frame goes to a browser watching the run live. Both see a string
   by the time it gets to them, which is why the bound is here, where the Error
   object still exists and lib/api-error.ts can be asked who wrote it. */
describe("a run that fails", () => {
  /** Shaped like the real thing: a provider's own words, with the two pieces
   *  that must never reach a browser sitting inside them. */
  const PROVIDER_FAULT = new Error(
    "OpenRouter 401 no auth credentials found (request_id 0f3c9ab2, key sk-or-v1-2b7d)",
  )
  const LEAKS = ["sk-or-v1-2b7d", "0f3c9ab2", "OpenRouter", "no auth credentials"]

  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(format(...args))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Every `ui:results` frame the run put on its stream. Safe to drain only
   *  after `failRun`, which closes the stream — `stream()` walks the log it
   *  already holds and then returns because the run is over. */
  async function resultFrames(record: RunRecord): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    for await (const span of record.spans.stream()) {
      if (span.name === "ui:results") out.push(JSON.parse(span.argsDigest) as Record<string, unknown>)
    }
    return out
  }

  it("stores a fixed sentence and a ref, not the provider's own words", async () => {
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const stored = getRun(record.id)?.error ?? ""
    for (const leak of LEAKS) expect(stored).not.toContain(leak)
    expect(stored).toMatch(/quote ref [0-9a-f]{12}/)
  })

  it("puts the provider's own words on the log line the ref names", async () => {
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const ref = /ref ([0-9a-f]{12})/.exec(getRun(record.id)?.error ?? "")?.[1]
    const line = logged.find((l) => l.includes(ref ?? "\0"))
    expect(line).toBeDefined()
    // The whole cause, plus which run it belongs to — a page can pass its route
    // here, and a run passes its id.
    expect(line).toContain("sk-or-v1-2b7d")
    expect(line).toContain(`run ${record.id}`)
  })

  it("tells the browser exactly what it tells the poller — one sentence, one ref", async () => {
    // THE DRIFT THIS PINS. The frame and the stored string used to be authored
    // a line apart in app/api/map/route.ts's catch, so bounding one would have
    // left the live panel printing what `GET /api/run/[id]` refuses to. And two
    // calls to `faultNotice` would mint two refs for one failure, which is a
    // token that names nothing.
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const frames = await resultFrames(record)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.kind).toBe("error")
    expect(frames[0]?.message).toBe(getRun(record.id)?.error)
    expect(logged.filter((l) => /\[api\] fault/.test(l))).toHaveLength(1)
  })

  it("emits that frame before closing the stream, or no reader sees it", async () => {
    // `SpanStream.stream()` returns as soon as `close()` wakes it, so a frame
    // emitted after the close reaches nobody who was already attached — and
    // "already attached" is the whole test, because a reader that arrives after
    // the run is over replays `#log` and sees the frame either way. Hence the
    // tick: an async generator runs its body on the first `next()` as a
    // MICROTASK, so without waiting here the watcher would still be a late one
    // and this would pass with the emit on the wrong side of the close.
    const record = createRun("resend.com", 12)
    const seen: string[] = []
    const watching = (async () => {
      for await (const span of record.spans.stream()) seen.push(span.name)
    })()
    await new Promise((r) => setTimeout(r, 0))

    await failRun(record.id, PROVIDER_FAULT)
    await watching
    expect(seen).toContain("ui:results")
  })

  it("keeps a stop an outcome rather than a fault", async () => {
    // The sweep throws from its next checkpoint once aborted, and that throw is
    // no more repeatable than any other — but the reader pressed the button, so
    // what they are told is the app's own sentence and there is no ref to quote.
    const record = createRun("resend.com", 12)
    expect(cancelRun(record.id)).toBe(true)
    await failRun(record.id, new Error("aborted at wave 3 (request_id 0f3c9ab2)"))

    expect(getRun(record.id)?.error).toBe(
      "Stopped. Everything found before you stopped it is kept.",
    )
    expect((await resultFrames(record))[0]?.message).toBe(getRun(record.id)?.error)
    expect(logged.filter((l) => /\[api\] fault/.test(l))).toHaveLength(0)
  })

  it("keeps a stop that HAS a reason over the sentence for one that does not", async () => {
    // "Stopped." is what to say when the abort left nothing behind but the word
    // "aborted" — a person pressed the button and there is nothing to add. It is
    // the wrong sentence when the app aborted the run itself and knows why. The
    // spend cap does exactly that: it stops the spending FIRST, because a
    // Postgres write is a round trip and the engine goes on buying for the
    // length of one, and then records the reason. Reading the signal alone would
    // tell a visitor who touched nothing that they had stopped their own map.
    const record = createRun("resend.com", 12)
    expect(cancelRun(record.id)).toBe(true)
    await failRun(record.id, namedFaults.runCostCeiling(0.41, 0.3844))

    const shown = getRun(record.id)?.error ?? ""
    expect(shown).not.toBe("Stopped. Everything found before you stopped it is kept.")
    expect(shown).toContain("$0.41")
    expect(shown).toContain("kept")
    expect(logged.filter((l) => /\[api\] fault/.test(l))).toHaveLength(0)
  })

  it("keeps the FIRST ending and drops the second, whatever arrives after it", async () => {
    // THE DEFECT THIS CLOSES, and it predates the spend cap. Both watchdogs in
    // the map route abort the sweep to stop it working, and the abort makes the
    // sweep throw, and the background task catches that throw and calls
    // `failRun` a second time — by which point the signal is set. So the row
    // that said "this run ran out of clock" was immediately overwritten by one
    // saying the visitor cancelled, on every single timed-out run. The careful
    // ordering in the watchdog was undone one line later by a caller nobody had
    // counted, and no test could see it because the second write is the normal
    // path.
    const record = createRun("resend.com", 12)
    await failRun(record.id, namedFaults.runCostCeiling(0.41, 0.3844))
    const first = getRun(record.id)?.error
    const endedAt = getRun(record.id)?.endedAt

    record.abort.abort()
    await failRun(record.id, new Error("aborted at wave 3"))

    expect(getRun(record.id)?.error).toBe(first)
    expect(getRun(record.id)?.endedAt).toBe(endedAt)
    // And a completion arriving late does not overwrite a failure either: a run
    // has one ending and it is the one that happened first.
    await finishRun(record.id, { report: { domain: "resend.com", kept: 0, usd: 0 } } as never)
    expect(getRun(record.id)?.status).toBe("failed")
    expect(getRun(record.id)?.result).toBeUndefined()
  })
})

/* A FAILED RUN THAT ONLY ONE INSTANCE COULD SEE.

   The neighbouring suite pins what a failure SAYS. This one pins whether anyone
   else can hear it. `failRun` writes `status: "failed"` and a reason and never a
   result, and `toStored` dropped every row without a result — so the record was
   written, correctly, into a table nothing would read it out of. Every other
   instance answered "no such run" about a run that had definitely happened and
   had definitely spent money.

   The two halves of the reason are the other thing under test. The row keeps the
   cause because a log line does not outlive the year and a row does; the reader
   gets the sentence and the ref and nothing else. Those used to be the same
   string travelling to one destination, which is why the split was safe as a
   comment. It is two destinations now. */
describe("a failed run, as another instance would find it", () => {
  const PROVIDER_FAULT = new Error(
    "OpenRouter 401 no auth credentials found (request_id 0f3c9ab2, key sk-or-v1-2b7d)",
  )
  const LEAKS = ["sk-or-v1-2b7d", "0f3c9ab2", "OpenRouter", "no auth credentials"]

  /** Every row this suite's runs upserted, newest last. */
  let rows: Record<string, unknown>[]

  beforeEach(() => {
    rows = []
    // Configured, unlike the rest of this file: the whole subject is what
    // reaches the store, so there has to be one. The fetch is stubbed, so no
    // socket is opened.
    process.env.SUPABASE_URL = "https://store.test"
    process.env.SUPABASE_SECRET_KEY = "k"
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).includes("/rest/v1/runs")) {
          rows.push(...(JSON.parse(String(init?.body ?? "[]")) as Record<string, unknown>[]))
        }
        return new Response("", { status: 201 })
      }),
    )
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const failedRow = () => rows.filter((r) => r.status === "failed").at(-1)

  it("writes a row that says it failed, and why", async () => {
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const row = failedRow()
    expect(row).toBeDefined()
    expect(row?.id).toBe(record.id)
    expect(row?.ended_at).toEqual(expect.any(String))
    expect(row?.result).toBeUndefined()
  })

  it("does not return until that row has actually landed", async () => {
    /* The other half, and the one a passing assertion above cannot see: the
       write used to be `void`ed, so `failRun` returned with the row in flight.
       On a long-lived process that is invisible, which is why it survived. On a
       host that ends the invocation when the request's registered work resolves,
       the row is simply never written and the failure joins the run in being
       unreadable.

       Held open at the socket rather than mocked at a seam, because the seam is
       what a wrong fix would satisfy. The timer, not a microtask, decides
       whether it is pending — a chain of awaits also fails to settle in one
       microtask, so `Promise.resolve()` would race green over the bug. */
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const body = String(init?.body ?? "[]")
        if (String(input).includes("/rest/v1/runs")) {
          rows.push(...(JSON.parse(body) as Record<string, unknown>[]))
          if (body.includes('"failed"')) await gate
        }
        return new Response("", { status: 201 })
      }),
    )

    const record = createRun("resend.com", 12)
    const ending = failRun(record.id, PROVIDER_FAULT)
    const settled = await Promise.race([
      ending.then(() => "settled" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 25)),
    ])
    expect(settled).toBe("pending")

    open()
    await ending
  })

  it("puts the reader's sentence first in the column and the cause after it", async () => {
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const column = String(failedRow()?.error ?? "")
    const notice = getRun(record.id)?.error ?? ""
    // The joint `lib/store/supabase.ts` reads back across. Spelled here as the
    // contract rather than as an implementation detail, because a change to
    // either side that forgot the other would hand a browser a stack trace.
    expect(column).toBe(`${notice}\ncause: ${PROVIDER_FAULT.stack}`)
    for (const leak of LEAKS) expect(notice).not.toContain(leak)
    expect(column).toContain("sk-or-v1-2b7d")
  })

  it("is readable from the process that ran it, as a failure rather than as nothing", async () => {
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const stored = await getStoredRun(record.id)
    expect(stored?.status).toBe("failed")
    expect(stored?.error).toBe(getRun(record.id)?.error)
    // No map, and no stand-in for one. Every KB surface asks `isCompleted`
    // before it reads `result`, so an absent one is the honest answer rather
    // than a hazard.
    expect(stored?.result).toBeUndefined()
  })

  it("appears in the listing, which is what puts it in front of an operator", async () => {
    const record = createRun("resend.com", 12)
    await failRun(record.id, PROVIDER_FAULT)

    const listed = await listStoredRuns()
    expect(listed.map((r) => r.id)).toContain(record.id)
    expect(listed.find((r) => r.id === record.id)?.status).toBe("failed")
  })

  it("does not make a run still in flight readable, which is a different claim", async () => {
    const record = createRun("resend.com", 12)
    expect(await getStoredRun(record.id)).toBeNull()
    expect((await listStoredRuns()).map((r) => r.id)).not.toContain(record.id)
    // Left tidy: an open run holds a subscriber on its span stream.
    await failRun(record.id, PROVIDER_FAULT)
  })

  it("keeps a deliberate stop out of the cause half entirely", async () => {
    // A stop has no cause worth keeping — the reader pressed the button, and
    // the sentence is the app's own. Appending a stack here would put a sweep's
    // abort throw in the column under the word "cause", which reads as a fault.
    const record = createRun("resend.com", 12)
    expect(cancelRun(record.id)).toBe(true)
    await failRun(record.id, new Error("aborted at wave 3 (request_id 0f3c9ab2)"))

    expect(failedRow()?.error).toBe("Stopped. Everything found before you stopped it is kept.")
  })
})

describe("the span pump, when the store's own write breaks its promise", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://store.test"
    process.env.SUPABASE_SECRET_KEY = "k"
    vi.spyOn(console, "error").mockImplementation(() => {})
    // Only `upsertRun` needs a live socket here — `appendSpans` is spied below
    // — so this stub only has to answer, not record anything.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 201 })))
  })

  afterEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /* `pump` (lib/runs.ts) wraps its stream loop in a try/catch that
     `lib/store/supabase.ts`'s own `appendSpans` doc comment says can never
     fire: every write there goes through `quiet()`, which never throws. That
     makes the catch defend against `quiet` itself breaking, or a future store
     client that skips it — and nothing in this file, or anywhere else, had
     ever made it run: `appendSpans`, `pump` and `pumped` do not appear in a
     single `grep` of this suite. Spying past `quiet` — replacing the exported
     function outright, the same way `db/kb/[id]/page.test.tsx` already does
     for `getRunRow` — is the only way to make that promise false and watch
     the catch actually fire. */
  it("logs the stop and gives up on the stream, rather than leaving `pumped` unsettled", async () => {
    const appendSpans = vi.spyOn(db, "appendSpans").mockRejectedValueOnce(new Error("connection reset"))

    const record = createRun("resend.com", 12)
    // FLUSH_SPANS is 25 (lib/runs.ts): the batch crosses it on the last of
    // these and `flush()` runs from inside the loop, where the catch can see
    // it — not the trailing `flush()` after the stream closes, which sits
    // outside the try entirely and would let a rejection escape `pumped`.
    for (let i = 0; i < 25; i++) {
      record.spans.emit({
        runId: record.id,
        agentId: "sweep",
        parentId: null,
        kind: "search",
        name: "serp",
        argsDigest: `q${i}`,
        ms: 5,
        ok: true,
        usd: 0.001,
      })
    }

    await record.pumped

    expect(console.error).toHaveBeenCalledWith(
      `[runs] span pump for ${record.id} stopped:`,
      expect.any(Error),
    )
    // One attempt, not a retry: the throw ends the loop, so the fix is aware
    // its own batch is gone rather than silently re-sent.
    expect(appendSpans).toHaveBeenCalledTimes(1)

    // Left tidy: an open run holds a subscriber on its span stream.
    await failRun(record.id, new Error("cleanup"))
  })
})

describe("the persist write, when the disk breaks its promise", () => {
  let asFile: string

  beforeAll(async () => {
    asFile = path.join(root, "persist-target-is-a-file")
    await writeFile(asFile, "not a directory", "utf8")
  })

  beforeEach(() => {
    process.env.OPENKB_RUNS_DIR = asFile
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.OPENKB_RUNS_DIR = dir
    vi.restoreAllMocks()
  })

  /* `settle` (lib/runs.ts) wraps `persist(r)` in its own `.catch`, and the doc
     comment above it is explicit about why: a slow or broken disk must not fail
     a run that succeeded — the write is best-effort and Postgres is the durable
     copy. Nothing in this file had ever pointed OPENKB_RUNS_DIR at a path
     `persist`'s own `mkdir(dir, { recursive: true })` cannot create through;
     every other test here writes to a real temp directory. So the catch had
     never run, and `finishRun` had never been proven to survive a broken write
     rather than reject and leave the run stuck at `running`. */
  it("logs the failed write and still finishes the run", async () => {
    const record = createRun("resend.com", 12)
    await finishRun(record.id, { report: { domain: "resend.com", kept: 0, usd: 0 } } as never)

    expect(getRun(record.id)?.status).toBe("complete")
    expect(console.error).toHaveBeenCalledWith(
      `[runs] could not persist ${record.id}:`,
      expect.any(Error),
    )
  })
})

describe("OPENKB_RUNS_DIR shapes the refusal must keep its hands off", () => {
  /** A read through a value that must be accepted. `null` is the right answer —
   *  the fixture uuid is nowhere near these directories — and the point is that
   *  it RESOLVES rather than throwing. Deliberately a miss and not a listing, so
   *  no case here scans a real directory. */
  async function accepts(value: string | undefined): Promise<unknown> {
    if (value === undefined) delete process.env.OPENKB_RUNS_DIR
    else process.env.OPENKB_RUNS_DIR = value
    try {
      return await getStoredRun(UUID)
    } finally {
      process.env.OPENKB_RUNS_DIR = dir
    }
  }

  it.each([
    ["the Dockerfile's literal value", "/app/runs"],
    ["what next.config.ts computes", path.join(process.cwd(), "runs")],
    ["a volume mounted one component under the root", path.parse(process.cwd()).root + "openkb-data"],
    ["an operator's own choice, deep and elsewhere", "/srv/data/openkb-runs"],
  ])("accepts %s", async (_what, value) => {
    await expect(accepts(value)).resolves.toBeNull()
  })

  it("accepts the home directory, which this deliberately does not police", async () => {
    // The finding that prompted the root refusal floated `$HOME` alongside it.
    // It is left alone on purpose, and the difference is not one of degree:
    // `runsPath` builds a correct floor under a home directory, so every read
    // and write through it works exactly as configured. Refusing it would be
    // this module overruling a configuration that functions — which is the line
    // the root case never comes near, because there nothing functions at all.
    await expect(accepts(homedir())).resolves.toBeNull()
  })

  it("accepts the unset case, where the walk-up answers", async () => {
    // A script or a test importing this module outside a Next server. Neither
    // fallback can produce a root — both append a `runs` component — which is
    // also why the message can name the variable without hedging.
    await expect(accepts(undefined)).resolves.toBeNull()
  })
})
