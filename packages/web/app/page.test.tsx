import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BuildWorkflow } from "@/components/build/BuildWorkflow"
import { DEMO_ASIDE, DEMO_REFUSAL, DEMO_REPO } from "@/lib/demo"
import { MEASURED } from "@/lib/public-runs"
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

/* The store, in this suite's hands. `runGate` counts today's runs through it,
   and a page test that reached a real PostgREST would be measuring the network.
   Only the counter is replaced: `listStoredRuns` still reads the committed maps
   off disk exactly as it does in production, which is the half these tests are
   actually about. */
const countRunsSince = vi.fn<(since: string) => Promise<number | null>>()
vi.mock("@/lib/store/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store/supabase")>()),
  countRunsSince: (since: string) => countRunsSince(since),
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
  // 14,451 until the reader learned to withdraw a name a stored map had given
  // to a stranger. Four of the six maps carry such a row, and the 2,826 links
  // that go with them were bought by a page naming the anchor and booked
  // against someone else: vercel -2,203, supabase -382, stripe -223, clerk -18.
  // The entity count does not move — every one of those rows is still here,
  // under its own host.
  edges: "11,625",
  usd: "$8.4022",
  clock: "72m 43s",
}

/** Three per-card numbers, as the card SPELLS them — thousands separators and
 *  all, since that is what a reader sees. Two are the extremes of the set (the
 *  largest map's entity count, the densest map's link count) and one is the
 *  headline the card now leads with.
 *
 *  `STRIPE_COMPANIES` is the number this whole card was rewritten around, and
 *  it took two corrections to arrive at.
 *
 *  It is a UNION, because stripe.com's stored run filed 1,272 hosts as
 *  `product` and exactly one as `company` — the two kinds were one coin flip
 *  until they were merged at the classifier — so a card counting `company`
 *  alone puts "1 company in this market" on the front page of a payments map.
 *
 *  And it is a union MINUS the rows that run placed outside this market. 265 of
 *  those 1,273 carry `relation: "none"`, which is the classifier saying the
 *  host sells into a different one: dart.deloitte.com, "accounting research
 *  materials and standards for financial reporting and auditing, not
 *  payments". The headline says "in this market"; counting them asserts the
 *  opposite of what the run concluded. 20.1% of every company-like row in the
 *  stored corpus is such a row, and 38.5% on figma.com, so it cannot be
 *  rounded away. See `KbSummary.companies`. */
const STRIPE_ENTITIES = "2,522"
/** One lower than the 1,008 this pinned before: `exalate.com` was filed as
 *  "Stripe", `product`, `shaper`, and a row wearing a name the run never
 *  settled is not a company in this market. It is still on the map. */
const STRIPE_COMPANIES = "1,007"
/** 6,283 before. 2,203 of vercel's links were minted by seven strangers
 *  wearing the name "Vercel" — `aws.amazon.com` alone held 331 of them. */
const VERCEL_LINKS = "4,080"

const KEYS = [
  "OPENKB_DEMO",
  "OPENKB_PUBLIC_RUNS_PER_DAY",
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

beforeEach(() => {
  countRunsSince.mockReset()
  // A quiet day, so an allowance that is configured is an allowance that is
  // open unless a test says otherwise.
  countRunsSince.mockResolvedValue(0)
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

  it("gives each card what makes it worth opening: a headline, its markets, its evidence", async () => {
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    // The headline, against the real file. See STRIPE_COMPANIES for why the
    // number is a union and not `counts.player`.
    expect(html).toContain(`${STRIPE_COMPANIES}</span>`)
    expect(html).toContain("companies in this market")
    expect(html).toContain(`${STRIPE_ENTITIES}</span> entities`)
    expect(html).toContain(`${VERCEL_LINKS}</span> links`)
    // The markets provenance drew, in the decomposition's own spelling.
    expect(html).toContain("online payment acceptance")
    expect(html).toContain("Proxy servers")
    // …and never the remainder bucket dressed as one of them.
    expect(html).not.toContain(">unattributed<")
  })

  it("gives all six cards the same fields, so none of them can look random", async () => {
    /* THE COMPLAINT THIS PAGE WAS REWRITTEN FOR. The old footer filtered kind
       counts through a `KIND_FLOOR = 50`, so stripe.com printed three numbers
       and brightdata.com four, and the composition bar above them had coloured
       bands with no chip to explain them. Six specimens that are supposed to
       read as one set were six different cards.

       Counted rather than spot-checked: one headline, one entity count and one
       link count per card, six of each, no exceptions. */
    env({ OPENKB_DEMO: "1" })
    const html = await home()
    const count = (needle: string) => html.split(needle).length - 1

    expect(count("companies in this market")).toBe(6)
    expect(count("</span> entities")).toBe(6)
    expect(count("</span> links")).toBe(6)
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

  it("has no box, and does not mention an allowance it does not have", async () => {
    // "With runs disabled nothing changes", asserted directly rather than
    // inferred from the tests above still passing. `OPENKB_PUBLIC_RUNS_PER_DAY`
    // is unset on every demo that exists today, and every one of them must go
    // on rendering a gallery with no form in it.
    env({ OPENKB_DEMO: "1" })
    const html = await home()

    expect(html).not.toContain("<input")
    expect(html).not.toContain("runs left today")
    expect(html).not.toContain("resets at 00:00 UTC")
    // And it took no count, because there was no allowance to count against.
    expect(countRunsSince).not.toHaveBeenCalled()
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

/**
 * THE TRY-IT PATH.
 *
 * A demo whose every door is shut is a gallery of maps somebody else paid for.
 * `OPENKB_PUBLIC_RUNS_PER_DAY` is the one variable that opens the spending door,
 * and this is what a stranger meets when it is set: a box, above the maps, with
 * the count of runs left in it BEFORE they type — which is the whole difference
 * between information and a door in the face.
 */
describe("with a daily allowance — the box is back, above the gallery", () => {
  it("renders a live domain input and a live Map button", async () => {
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    const html = await home()

    expect(html).toContain('placeholder="resend.com"')
    expect(html).toContain(">Map<")
    // Live, not decorative. The input carries no `disabled` at all; the button
    // carries one only because the field starts empty, which is the same state
    // the ordinary deployment's button is in.
    const input = html.match(/<input[^>]*placeholder="resend\.com"[^>]*>/)?.[0]
    expect(input, "the domain input").toBeDefined()
    expect(input).not.toMatch(/\sdisabled[=\s/>]/)
  })

  it("says how many runs are left today before the visitor types, not after", async () => {
    // Item 2, and the reason it is a count and not a boolean: a stranger who
    // types into a box that then refuses them has been wasted; a stranger who
    // reads "13 of 20 left" and types anyway has been told the truth.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(7)
    const html = await home()

    expect(html).toContain("13 of 20")
    expect(html).toContain("runs left today")
    // And the count is of runs started TODAY, taken from midnight UTC.
    expect(countRunsSince).toHaveBeenCalledTimes(1)
    expect(countRunsSince.mock.calls[0]![0]).toMatch(/T00:00:00\.000Z$/)
  })

  it("quotes the cost in TIME and SIZE, both measured, and never in dollars", async () => {
    // What a run costs the visitor is four minutes of their attention. The
    // owner's twenty cents is not the visitor's business, and quoting it asks
    // them to decide on the owner's behalf whether they are worth it.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    const html = await home()

    expect(html).toContain(`about ${MEASURED.aboutMinutes} minutes`)
    expect(html).toContain(`roughly ${MEASURED.aboutEntities} entities`)
    expect(html).toContain("both measured")
    expect(html).toContain("costs you nothing but the wait")
    // The operator's price list is gone from this page — it is the right line
    // for someone spending their own money and the wrong one for a stranger.
    expect(html).not.toContain("$0.0015")
  })

  it("keeps the finished maps, under the box rather than instead of it", async () => {
    // Item 5's real content: this is the same gallery, given a form on top,
    // not a second page. All six maps, each still linking to itself.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    const html = await home()

    for (const id of MAPS) expect(html, id).toContain(`href="/kb/${id}"`)
    expect(html).toContain(LEDGER.entities)
    expect(html).toContain("already spent")
    // Order: the box first, the maps under it.
    expect(html.indexOf('placeholder="resend.com"')).toBeLessThan(html.indexOf('href="/kb/'))
  })

  it("says the headline once, not twice", async () => {
    // The gallery renders in its `bare` spelling here precisely so the reader
    // does not get two "Map a market" headings and two identical paragraphs
    // stacked around one form.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    const html = await home()

    expect(html.split("Map a market").length - 1).toBe(1)
    expect(html.split("the queries cannot look this company up").length - 1).toBe(1)
    // …and it names what the maps below are, since they are not the visitor's.
    expect(html).toContain("maps already built here")
  })

  it("still points at the repo, because the allowance is not the whole answer", async () => {
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    const html = await home()

    expect(html).toContain(DEMO_ASIDE)
    expect(html).toContain(`href="${DEMO_REPO}"`)
    // And never the API's paragraph-long refusal, which nobody on this page has
    // asked for anything yet.
    expect(html).not.toContain(DEMO_REFUSAL)
  })
})

describe("with the allowance spent — a sentence, not a dead form", () => {
  it("drops the box and says when it comes back", async () => {
    // The alternative was a greyed-out input with "0 of 20" in it, and this
    // codebase has had that argument once already: a disabled form teaches a
    // visitor nothing except that they are not welcome.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(20)
    const html = await home()

    expect(html).not.toContain("<input")
    expect(html).not.toContain(">Map<")
    expect(html).toContain("resets at 00:00 UTC")
    expect(html).toContain("20 maps a day")
  })

  it("still shows every map, which is the thing the visitor came for", async () => {
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(20)
    const html = await home()

    for (const id of MAPS) expect(html, id).toContain(`href="/kb/${id}"`)
    expect(html).toContain(LEDGER.entities)
  })

  it("a store it cannot count with renders the read-only page, unchanged", async () => {
    // Fail closed, and fail QUIET: a database outage is not the visitor's
    // business and there is nothing they can do about it. The page is byte for
    // byte the one a read-only demo renders — asserted against that page rather
    // than described, so a future edit to either has to move both.
    env({ OPENKB_DEMO: "1", OPENKB_PUBLIC_RUNS_PER_DAY: "20" })
    countRunsSince.mockResolvedValue(null)
    const outage = await home()

    env({ OPENKB_DEMO: "1" })
    expect(outage).toBe(await home())
  })
})

describe("an allowance on a deployment that is NOT a demo", () => {
  it("gets the count without the gallery, and reads no directory for it", async () => {
    // The allowance is about spending, not about the demo: an owner who caps
    // their own password-protected instance gets the same line. What they do
    // not get is six committed maps on their front page — /kb is where they
    // browse what their own deployment has built.
    env({ OPENKB_PUBLIC_RUNS_PER_DAY: "5", OPENKB_RUNS_DIR: empty })
    countRunsSince.mockResolvedValue(1)
    const html = await home()

    expect(html).toContain("4 of 5")
    expect(html).toContain("runs left today")
    for (const id of MAPS) expect(html, id).not.toContain(id)
    expect(listed).not.toHaveBeenCalled()
  })
})
