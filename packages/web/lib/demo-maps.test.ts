import { readFileSync, readdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { faultNotice } from "./api-error"
import { getStoredRun, listStoredRuns } from "./runs"

/* The committed demo maps, and the gallery that has to find them.
   ---------------------------------------------------------------------------
   THE FAILURE THIS GUARDS is quiet in every direction. A demo deployment whose
   maps did not ship renders "Nothing mapped yet." — a sentence this codebase
   has spent two commits deleting, because a reader who is told nothing was
   built goes and builds one, which on a demo is the single thing the mode
   exists to prevent. A demo whose maps did ship but under a different name
   renders a gallery of cards that open onto 404s. Neither turns anything red on
   its own; only reading the real directory through the real reader does.

   So these tests use the committed files, not fixtures. A fixture would prove
   the reader works on a shape someone invented for the test; what needs
   proving is that the six files actually in `demo/maps/` are the six files the
   gallery lists, under the ids the map pages link to. */

const REPO = path.resolve(import.meta.dirname, "../../..")
const MAPS = path.join(REPO, "demo", "maps")

/** The six, by the id `/kb/<id>` addresses — the filename with `sweep-`
 *  stripped and `.json` dropped, which is what `adoptCliRun` derives. Written
 *  out rather than globbed, because a test that reads the directory to decide
 *  what the directory should contain proves only that reading it twice gives
 *  the same answer. */
const EXPECTED = [
  "brightdata-com-202608042230",
  "clerk-com-202608062258",
  "cursor-com-202608070032",
  "stripe-com-202608070005",
  "supabase-com-202608070017",
  "vercel-com-202608062351",
] as const

/** Every variable these tests touch, restored afterwards. `SUPABASE_*` is in
 *  here because `listStoredRuns` asks Postgres as one of its three sources: a
 *  developer with a real store configured in their shell would otherwise have
 *  this suite make a network call and count someone else's runs. */
const KEYS = [
  "OPENKB_DEMO",
  // In here because it MOVES the boundary this suite is about: an allowance
  // lets `getStoredRun` answer out of the store by id. A developer with one
  // set in their shell would otherwise flip half these assertions.
  "OPENKB_PUBLIC_RUNS_PER_DAY",
  "OPENKB_DEMO_MAPS_DIR",
  "OPENKB_RUNS_DIR",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
] as const
const saved: Record<string, string | undefined> = {}

let empty: string

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k]
  empty = await mkdtemp(path.join(tmpdir(), "openkb-empty-"))
})

afterAll(async () => {
  await rm(empty, { recursive: true, force: true })
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.restoreAllMocks()
})

function env(values: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const k of KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v
}

describe("demo/maps — what is committed", () => {
  it("is exactly six .json files and nothing else", () => {
    // The directory is served wholesale: anything dropped in it becomes a card
    // in the gallery of a public deployment. A stray file is a stray claim.
    const names = readdirSync(MAPS).sort()
    expect(names).toEqual(EXPECTED.map((id) => `sweep-${id}.json`).sort())
  })

  it("carries no `searched` array, which is what the trim removed", () => {
    // scripts/build-demo-maps.ts drops it — 11MB of the 19MB across the six,
    // read by nothing in this app. A file that still has it is a file someone
    // copied by hand instead of running the script, and the lambda pays for it.
    for (const name of readdirSync(MAPS)) {
      const run = JSON.parse(readFileSync(path.join(MAPS, name), "utf8")) as Record<string, unknown>
      expect(Object.keys(run), name).not.toContain("searched")
    }
  })

  it("keeps every field the reading layer and the export actually consume", () => {
    // The other half of the trim, and the more important one. Dropping a field
    // the app reads does not throw — `kb-from-run.ts` and `exportKbFiles` both
    // default their way past a missing key — it renders a map that quietly
    // claims less than the run measured. Named here so a future trim has to
    // argue with a test rather than with a comment.
    for (const name of readdirSync(MAPS)) {
      const run = JSON.parse(readFileSync(path.join(MAPS, name), "utf8")) as {
        anchor?: unknown
        entities?: unknown[]
        edges?: unknown[]
        decomposition?: Record<string, unknown>
        stats?: Record<string, unknown>
        report?: Record<string, unknown>
      }
      expect(typeof run.anchor, name).toBe("string")
      expect(Array.isArray(run.entities), name).toBe(true)
      expect(Array.isArray(run.edges), name).toBe(true)
      // What `manifestOf` and the run report read off every run.
      for (const key of ["sells", "buyer", "products", "capabilities", "coinages"]) {
        expect(run.decomposition, `${name}.decomposition.${key}`).toHaveProperty(key)
      }
      for (const key of ["queries", "usd", "seconds", "results", "hosts", "kept"]) {
        expect(run.stats, `${name}.stats.${key}`).toHaveProperty(key)
      }
      expect(run.report, `${name}.report`).toBeTypeOf("object")
    }
  })
})

describe("the gallery, in demo mode", () => {
  it("lists exactly the bundled maps, found without any path being configured", async () => {
    // THE WHOLE FEATURE, end to end: flag on, no OPENKB_RUNS_DIR anywhere, and
    // the reader still finds six maps. That "no path configured" is the point —
    // it is the case a serverless host lands in, where nothing evaluates
    // next.config.ts and there is no environment variable to inherit.
    env({ OPENKB_DEMO: "1" })
    const runs = await listStoredRuns()
    expect(runs.map((r) => r.id).sort()).toEqual([...EXPECTED].sort())
  })

  it("gives every listed map the anchor and the entities its card needs", async () => {
    // A card that lists but does not open is the failure the id alphabet in
    // lib/runs.ts was written about. Adoption is what stands between the two:
    // a file that parses but is not adopted is silently absent, and a file
    // adopted with no anchor renders a card titled `undefined`.
    env({ OPENKB_DEMO: "1" })
    const runs = await listStoredRuns()
    expect(runs).toHaveLength(EXPECTED.length)
    for (const run of runs) {
      expect(run.domain, run.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(run.result?.entities.length ?? 0, run.id).toBeGreaterThan(400)
      expect(run.status, run.id).toBe("complete")
    }
  })

  it("dates each map from its own filename stamp, newest first", async () => {
    // The stamp in the filename is the only record of when a CLI sweep ran, and
    // `adoptCliRun` falls back to `Date.now()` when it cannot read one — which
    // would date all six to whenever the page was loaded and scramble the
    // gallery's default sort into arrival order. Renaming these files breaks
    // that silently; this is what says so.
    env({ OPENKB_DEMO: "1" })
    const runs = await listStoredRuns()
    const ended = runs.map((r) => r.endedAt ?? 0)
    expect(ended).toEqual([...ended].sort((a, b) => b - a))
    // 2026-08-04 through 2026-08-07, well before this test could run.
    for (const [i, at] of ended.entries()) {
      expect(at, runs[i]!.id).toBeLessThan(Date.parse("2026-08-08T00:00:00Z"))
      expect(at, runs[i]!.id).toBeGreaterThan(Date.parse("2026-08-04T00:00:00Z"))
    }
  })

  it("takes OPENKB_DEMO_MAPS_DIR when one is named, so a deployment can serve its own", async () => {
    // The seam. Demo mode changes the default directory and an operator can
    // still name another — they get it, even empty, because guessing past an
    // explicit setting is how a deployment serves files nobody asked it to.
    env({ OPENKB_DEMO: "1", OPENKB_DEMO_MAPS_DIR: empty })
    expect(await listStoredRuns()).toEqual([])
  })

  it("serves the directory and nothing else, even with a store configured", async () => {
    /* MEASURED, and it is the reason this test exists rather than a
       precaution. A demo built from this repo and started with `next start`
       listed FIFTEEN maps: the committed six, plus nine runs pulled out of the
       operator's own Supabase, because next.config.ts loads the repo `.env`
       into the server process and `SUPABASE_URL` is in it. Every one of those
       nine was a real run of a real domain that nobody chose to publish, on a
       URL whose whole purpose is being handed to strangers.

       `fetch` is stubbed to throw rather than to return nothing: the assertion
       is not that the store was empty, it is that the store was never asked. */
    const forbidden = vi.fn(() => {
      throw new Error("the demo reached the network — it must read the directory and nothing else")
    })
    vi.stubGlobal("fetch", forbidden)
    try {
      env({ OPENKB_DEMO: "1", SUPABASE_URL: "https://store.test", SUPABASE_SECRET_KEY: "k" })
      const runs = await listStoredRuns()
      expect(runs.map((r) => r.id).sort()).toEqual([...EXPECTED].sort())
      expect(forbidden).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("will not hand over an unlisted run to a guessed id either", async () => {
    // The listing and the reader have to keep the same rule or they disagree:
    // a gallery of six over a `getStoredRun` that still serves a seventh out of
    // Postgres to whoever types its id. Same stub, same assertion.
    const forbidden = vi.fn(() => {
      throw new Error("the demo reached the network — it must read the directory and nothing else")
    })
    vi.stubGlobal("fetch", forbidden)
    try {
      env({ OPENKB_DEMO: "1", SUPABASE_URL: "https://store.test", SUPABASE_SECRET_KEY: "k" })
      expect(await getStoredRun("583cb0eb-f4e1-44b4-a46c-7b8249329203")).toBeNull()
      expect(forbidden).not.toHaveBeenCalled()
      // And the six it does serve still open.
      const one = await getStoredRun(EXPECTED[3])
      expect(one?.domain).toBe("stripe.com")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /**
   * THE ONE DOOR AN ALLOWANCE OPENS, and the one it does not.
   *
   * A public demo runs maps for strangers, so a stranger's own run has to be
   * readable after they close the tab — that link is the promise the box makes
   * ("your map lands at /kb/…") and a link that 404s is a lie. But the LISTING
   * must not move: a gallery that filled up with whatever visitors typed today
   * would also fill up with the operator's own unpublished runs out of the same
   * table, which is the fifteen-maps leak two tests above, arriving by a new
   * route.
   *
   * So the split is by SHAPE OF QUESTION rather than by trust: "show me
   * everything" stays answered from the committed directory, and "show me this
   * id" may reach the store. The ids that become reachable are
   * `crypto.randomUUID()`s, so unlisted means unguessable and not merely
   * undisplayed.
   */
  it("with an allowance, still lists the committed six and nothing else", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("the demo's LISTING reached the network — an allowance must not open it")
    })
    vi.stubGlobal("fetch", forbidden)
    try {
      env({
        OPENKB_DEMO: "1",
        OPENKB_PUBLIC_RUNS_PER_DAY: "20",
        SUPABASE_URL: "https://store.test",
        SUPABASE_SECRET_KEY: "k",
      })
      const runs = await listStoredRuns()
      expect(runs.map((r) => r.id).sort()).toEqual([...EXPECTED].sort())
      expect(forbidden).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("with an allowance, DOES ask the store for a run asked for by id", async () => {
    // The other half, and the reason this test asserts on the REQUEST rather
    // than on a returned run: what matters is that the question reaches
    // Postgres at all. A demo without an allowance never sends it (the test two
    // above proves that with the same stub, inverted).
    const asked: string[] = []
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(String(url))
      return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))
    })
    try {
      env({
        OPENKB_DEMO: "1",
        OPENKB_PUBLIC_RUNS_PER_DAY: "20",
        SUPABASE_URL: "https://store.test",
        SUPABASE_SECRET_KEY: "k",
      })
      const id = "583cb0eb-f4e1-44b4-a46c-7b8249329203"
      expect(await getStoredRun(id)).toBeNull()
      expect(asked.some((u) => u.includes(`runs?id=eq.${id}`))).toBe(true)
      // And the committed six still open, from the directory, as they always did.
      expect((await getStoredRun(EXPECTED[3]))?.domain).toBe("stripe.com")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("IGNORES OPENKB_RUNS_DIR, because Vercel deployments are told to set it", async () => {
    // The highest-probability silent failure in the whole feature, pinned.
    // DEPLOY.md tells every Vercel operator to set OPENKB_RUNS_DIR=/tmp/…, and
    // it is right to — that is where a LIVE deployment writes finished runs on
    // a read-only filesystem. A demo writes none. If the general variable won
    // here, an operator who followed both instructions would get an empty
    // gallery on the exact host this feature exists for, having done as they
    // were told. So the two variables answer two questions and neither reaches
    // the other's.
    env({ OPENKB_DEMO: "1", OPENKB_RUNS_DIR: "/tmp/openkb-runs" })
    const runs = await listStoredRuns()
    expect(runs.map((r) => r.id).sort()).toEqual([...EXPECTED].sort())
  })
})

describe("when a demo cannot find what it ships with", () => {
  it("says so, instead of rendering an empty gallery", async () => {
    // The lambda case with both mechanisms gone: no environment variable, and
    // a working directory the walk cannot reach `demo/maps` from. `process.cwd`
    // is stubbed rather than `chdir`-ed because the pool shares this process
    // with every other suite in the file.
    env({ OPENKB_DEMO: "1" })
    vi.spyOn(process, "cwd").mockReturnValue(empty)

    await expect(listStoredRuns()).rejects.toThrow(/OPENKB_DEMO is on/)
  })

  it("says it in a sentence /kb and /runs are allowed to print", async () => {
    // Both list pages render what they catch through `faultNotice`, which
    // prints a named fault verbatim and reduces anything else to a ref. A
    // diagnosis the reader never sees is worth nothing, so the entry being on
    // the shelf is part of the fix rather than a detail of it.
    env({ OPENKB_DEMO: "1" })
    vi.spyOn(process, "cwd").mockReturnValue(empty)

    const shown = await listStoredRuns().then(
      () => "the listing succeeded, which this test needs it not to",
      (err: unknown) => faultNotice(err, "GET /kb"),
    )
    expect(shown).toContain("demo/maps")
    expect(shown).toContain("OPENKB_DEMO_MAPS_DIR")
    expect(shown).not.toMatch(/quote ref/)
  })
})

describe("with the flag unset", () => {
  it("changes nothing — the runs directory is still whatever it was", async () => {
    // The regression that matters most. Every existing deployment and every
    // clone runs with no OPENKB_DEMO at all, and none of them may start seeing
    // six maps they did not produce.
    env({ OPENKB_RUNS_DIR: empty })
    expect(await listStoredRuns()).toEqual([])
  })

  it("does not reach demo/maps even though the directory is right there", async () => {
    // The walk-up in `demoMapsDir` is gated on the flag, not on the directory
    // existing. Without this, a developer working in this repo — where
    // `demo/maps/` is two levels above the app — would get six maps mixed into
    // their own gallery, and nobody would notice until a deployment did it.
    env({ OPENKB_RUNS_DIR: empty })
    const runs = await listStoredRuns()
    expect(runs.map((r) => r.id)).not.toContain(EXPECTED[0])
  })
})
