import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { BuildWorkflow } from "@/components/build/BuildWorkflow"
import { DEMO_ASIDE, DEMO_REFUSAL, DEMO_REPO } from "@/lib/demo"
import Home from "./page"

/**
 * THE HOME PAGE, WHICH IS TWO PAGES.
 *
 * A demo deployment's front page leads with the maps it ships with; every other
 * deployment's is the run surface, exactly as it was. This file holds both ends
 * of that, and the second one is the one that matters more: `OPENKB_DEMO` is
 * unset on every clone, every dev server and every real deployment, and none of
 * them may notice that this feature exists.
 *
 * WHAT "BYTE-IDENTICAL" IS PINNED AS. The strongest available statement is that
 * the shell renders `<BuildWorkflow />` and contributes nothing of its own —
 * asserted by rendering both and comparing the strings — plus a check on each
 * of the three things the deleted `demo` prop used to touch: the input's
 * `disabled`, the button's `disabled`, and the button's `title`. A stored
 * golden of the whole run surface was considered and rejected: it would fail on
 * every future edit to a component this feature never touched, which trains a
 * reader to re-bless it, and a golden nobody reads proves nothing.
 *
 * Rendered with `renderToStaticMarkup` rather than in a browser, following
 * app/runs/page.test.tsx: `Home` is an async Server Component, so awaiting it
 * and rendering the returned tree is the whole of it. `useEffect` never fires,
 * which is right — none of what is asserted here is behaviour.
 */

/* BuildWorkflow calls `useRouter` at the top of its body, and outside a mounted
   app router that throws. It is only ever used to navigate to a finished map,
   which no static render reaches. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
}))

/* The real registry, watched. `listStoredRuns` reads 8MB of committed JSON off
   disk, and the flag-unset page must never pay for it — an assertion the markup
   alone cannot make, since a page that read the maps and rendered none of them
   looks exactly like a page that never read them. */
const listed = vi.fn()
vi.mock("@/lib/runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runs")>()
  return {
    ...actual,
    listStoredRuns: (...args: Parameters<typeof actual.listStoredRuns>) => {
      listed()
      return actual.listStoredRuns(...args)
    },
  }
})

/** The committed maps, by the id `/kb/<id>` addresses. Kept in step with
 *  lib/demo-maps.test.ts, which owns the directory's contents; here they are
 *  the six cards this page has to put on screen. */
const MAPS = [
  "brightdata-com-202608042230",
  "clerk-com-202608062258",
  "cursor-com-202608070032",
  "stripe-com-202608070005",
  "supabase-com-202608070017",
  "vercel-com-202608062351",
] as const

const ANCHORS = [
  "brightdata.com",
  "clerk.com",
  "cursor.com",
  "stripe.com",
  "supabase.com",
  "vercel.com",
] as const

/**
 * What the six maps hold, measured off the committed files.
 *
 * Literals rather than a re-derivation, deliberately: a test that recomputes
 * these from the same reader the page uses asserts only that the reader is
 * deterministic. These numbers are the page's central claim — they are what a
 * stranger reads in the first line — so they are written down, and a
 * regenerated `demo/maps/` is supposed to fail here and be looked at.
 */
const LEDGER = {
  entities: "8,569",
  edges: "14,451",
  usd: "$8.4022",
  clock: "72m 43s",
}

/** Two per-card numbers, from the two extremes of the set: the largest map's
 *  entity count and the densest map's edge count. */
const STRIPE_ENTITIES = 2522
const VERCEL_EDGES = 6283

const KEYS = [
  "OPENKB_DEMO",
  "OPENKB_DEMO_MAPS_DIR",
  "OPENKB_RUNS_DIR",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
] as const
const saved: Record<string, string | undefined> = {}

/** Somewhere empty for the flag-unset case to point at, so nothing on this
 *  disk can wander into a render that is supposed to read nothing. */
let empty: string

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k]
  empty = await mkdtemp(path.join(tmpdir(), "openkb-home-"))
})

afterAll(async () => {
  await rm(empty, { recursive: true, force: true })
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  listed.mockClear()
})

/** Every variable this page can see, set from scratch. `SUPABASE_*` is cleared
 *  for lib/demo-maps.test.ts's reason: a developer with a real store in their
 *  shell would otherwise have this suite render someone else's runs. */
function env(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(values)) process.env[k] = v
}

const home = async (): Promise<string> => renderToStaticMarkup(await Home())

describe("with OPENKB_DEMO unset — the run-starter, unchanged", () => {
  it("renders exactly what BuildWorkflow renders, and nothing of its own", async () => {
    env({ OPENKB_RUNS_DIR: empty })
    expect(await home()).toBe(renderToStaticMarkup(<BuildWorkflow />))
  })

  it("still offers a live domain input and a live Map button", async () => {
    env({ OPENKB_RUNS_DIR: empty })
    const html = await home()

    expect(html).toContain("Map a market")
    expect(html).toContain('placeholder="resend.com"')
    expect(html).toContain(">Map<")
    // The price of a question, in the slot the demo page repurposes. It is the
    // right line on a deployment that can actually buy one.
    //
    // Matched on the price rather than on the whole sentence: the clause after
    // it says what BOUNDS a run, and a web run is now bounded by the budget
    // this deployment's `maxDuration` affords rather than by the planner
    // running out of things to find. That clause will be reworded again; the
    // rate is the fact this test is about.
    expect(html).toContain("$0.0015 each")
  })

  it("leaves the two controls the demo prop used to disable in their live state", async () => {
    // The precise regression: `disabled={demo}` came off the input and
    // `demo ||` came off the button, and neither removal may have changed what
    // renders. The input carries no `disabled` at all; the button carries one,
    // because the field is empty, and that is the only reason it ever did.
    env({ OPENKB_RUNS_DIR: empty })
    const html = await home()

    // Matched on the ATTRIBUTE, not the substring: both controls keep
    // `disabled:cursor-not-allowed disabled:opacity-40` in their class list,
    // and those two Tailwind variants are part of the class attribute this
    // change is not allowed to alter.
    const input = html.match(/<input[^>]*placeholder="resend\.com"[^>]*>/)?.[0]
    expect(input, "the domain input").toBeDefined()
    expect(input).not.toMatch(/\sdisabled[=\s/>]/)

    const button = html.match(/<button[^>]*>Map<\/button>/)?.[0]
    expect(button, "the Map button").toBeDefined()
    expect(button).toMatch(/\sdisabled[=\s/>]/)
    // The hover explanation was the demo's, and it went with it.
    expect(button).not.toContain("title=")
  })

  it("says nothing about a demo, and shows no map it did not build", async () => {
    env({ OPENKB_RUNS_DIR: empty })
    const html = await home()

    expect(html.toLowerCase()).not.toContain("demo")
    expect(html).not.toContain(DEMO_ASIDE)
    expect(html).not.toContain(DEMO_REFUSAL)
    for (const id of MAPS) expect(html, id).not.toContain(id)
  })

  it("does not so much as read the runs directory", async () => {
    // `demo/maps/` is two levels above this app on every clone, and the walk
    // that finds it costs 8MB of JSON. The early return in page.tsx is what
    // keeps a live deployment from paying it to render a form.
    env({ OPENKB_RUNS_DIR: empty })
    await home()
    expect(listed).not.toHaveBeenCalled()
  })

  it.each(["", "0", "false"])("treats %j as unset, the same way isDemo does", async (value) => {
    env({ OPENKB_DEMO: value, OPENKB_RUNS_DIR: empty })
    expect(await home()).toBe(renderToStaticMarkup(<BuildWorkflow />))
  })
})

describe("with OPENKB_DEMO on — the maps are the page", () => {
  it("puts all six on screen, each linking to its own map", async () => {
    // The whole item. Before this the six existed, were listed nowhere on the
    // front page, and the reader was told to go and find them.
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    for (const anchor of ANCHORS) expect(html, anchor).toContain(anchor)
    for (const id of MAPS) expect(html, id).toContain(`href="/kb/${id}"`)
  })

  it("leads with the biggest map rather than the newest", async () => {
    env({ OPENKB_DEMO: "1" })
    const html = await home()
    const at = (id: string) => html.indexOf(`href="/kb/${id}"`)

    // stripe (2,522 on the map) first, clerk (445) last. Newest-first — the
    // gallery's default — would have opened on cursor.com.
    expect(at("stripe-com-202608070005")).toBeGreaterThan(-1)
    expect(at("stripe-com-202608070005")).toBeLessThan(at("vercel-com-202608062351"))
    expect(at("clerk-com-202608062258")).toBeGreaterThan(at("cursor-com-202608070032"))
  })

  it("gives each card what makes it worth opening: counts, edges and markets", async () => {
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    expect(html).toContain(String(STRIPE_ENTITIES))
    expect(html).toContain(String(VERCEL_EDGES))
    expect(html).toContain("edges</span>")
    // The markets provenance drew, in the decomposition's own spelling.
    expect(html).toContain("online payment acceptance")
    expect(html).toContain("Proxy servers")
    // …and never the remainder bucket dressed as one of them.
    expect(html).not.toContain(">unattributed<")
  })

  it("replaces the price list with what these maps actually cost", async () => {
    // Item 4. A rate card for a service the reader cannot buy said nothing; the
    // bill for the six maps under it is the interesting number, and it is spent.
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    expect(html).not.toContain("$0.0015")
    expect(html).toContain(LEDGER.entities)
    expect(html).toContain(LEDGER.edges)
    expect(html).toContain(LEDGER.usd)
    expect(html).toContain(LEDGER.clock)
    expect(html).toContain("already spent")
  })

  it("keeps the headline and the de-branding sentence, and drops the form", async () => {
    // Item 2. The pitch is true on any deployment and stays; a dead input
    // teaches a visitor nothing except that they are not welcome.
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    expect(html).toContain("Map a market")
    expect(html).toContain("the queries cannot look this company up")
    expect(html).not.toContain("<input")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("disabled")
  })

  it("says what this deployment is in one line, beside the clone link", async () => {
    // Item 3. The sixty-word refusal is still what `POST /api/map` answers —
    // lib/demo.test.ts and app/api/map/demo.test.ts hold it to that — but it is
    // no longer the first thing a stranger reads.
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    expect(html).toContain(DEMO_ASIDE)
    expect(html).not.toContain(DEMO_REFUSAL)
    expect(html).toContain(`href="${DEMO_REPO}"`)
    // And it is below the maps, not above them.
    expect(html.indexOf(DEMO_ASIDE)).toBeGreaterThan(html.indexOf('href="/kb/'))
  })

  it("says it cannot find its maps rather than rendering an empty page", async () => {
    // The lambda failure lib/runs.ts diagnoses, seen from the front page. An
    // operator who pointed OPENKB_DEMO_MAPS_DIR at the wrong place gets the
    // variable's name back, not a page that quietly holds nothing.
    env({ OPENKB_DEMO: "1", OPENKB_DEMO_MAPS_DIR: empty })
    const html = await home()

    expect(html).toContain("no maps to show")
    // No ledger over an empty set: zero entities for $0.00 is a measurement
    // nobody made.
    expect(html).not.toContain("already spent")
    // The way out is still on the page.
    expect(html).toContain(`href="${DEMO_REPO}"`)
  })
})
