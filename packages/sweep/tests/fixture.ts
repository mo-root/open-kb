import dns from "node:dns"
import { MockLanguageModelV4 } from "ai/test"
import { FakeSearch, FakeFetch } from "@open-kb/core/testing"
import { SpanStream, type SearchHit, type Span } from "@open-kb/core"
import { readUi, type UiNamespace } from "../src/ui.js"
import { sweep, type SweepOptions, type SweepResult } from "../src/sweep.js"

/**
 * A whole run of `sweep()`, offline, deterministic, and free.
 *
 * The engine is 2,119 lines and until it grew `SweepOptions.ports` it had no
 * seam: it built Bright Data inside itself, so the only way to execute a phase
 * was to buy one. The 46 artifacts in `runs/` are what that cost. This file is
 * the replacement: the two ports come from `@open-kb/core/testing`, the model
 * comes from `ai/test`, and the fixture below is a small market — two products,
 * six hosts — chosen so that every phase has something real to do rather than
 * something to skip.
 *
 * WHAT IS FAKED AND WHAT IS NOT. Faked: the SERP, the fetches, the model. Real:
 * the prompts on disk (composed and rendered by the run itself, so a template
 * whose placeholders drift makes these tests throw), the family templates in
 * `@open-kb/core`, the anchor-name ban, the widening loop and its four stopping
 * rules, the host fold, `judgeHosts` and its predicates, the span-verification
 * gate, the co-occurrence selector, the free naming pass, the bill. Every
 * assertion in the four suites beside this file is about that second list.
 *
 * The model is scripted by SCHEMA, not by prompt text. `generateObject` hands
 * the mock the JSON schema it is being held to, and the engine's five calls have
 * five disjoint property sets (`sells`/`capabilities`, `terms`/`generic`,
 * `enough`/`draw`, `spans`/`relation`, `edges`). Routing on that means the
 * fixture is keyed to the CONTRACT each phase asks for — which is the thing
 * under test — rather than to prose someone will reword.
 *
 * Nothing here can reach the network. `blockTheNetwork()` replaces
 * `globalThis.fetch` with a throw for the duration, so a regression that
 * bypasses the port surfaces as an exception rather than as a charge.
 */

// ── the market ───────────────────────────────────────────────────────────────

/** The anchor. `.example` is reserved by RFC 2606: nothing here resolves even
 *  if something did try to leave the process. */
/** What the fixture model says served every answer — see `report.model.servedBy`. */
export const FIXTURE_HOST = "fixture-host"
export const ANCHOR = "pellucid.example"
/** What `banned()` is given: the anchor's own first label. */
export const ANCHOR_NAME = "pellucid"
/** A word the company invented. A debranded query containing it is bought for
 *  nothing and must never reach the wire. */
export const COINAGE = "Lumen"

export const HOSTS = {
  grepstack: "grepstack.example",
  tailwatch: "tailwatch.example",
  loglens: "loglens.example",
  forum: "forum.example",
  /** No row in the fetch table: its front page 404s, so the kernel settles it
   *  by predicate for $0 and it never reaches the model. */
  walled: "walled.example",
  /** Classified `noise`, so it leaves the map and takes its pairs with it. */
  adtrash: "adtrash.example",
} as const

/** Padded past core's THIN_TEXT floor (200 extracted chars, packages/core/src/sniff.ts)
 *  so `sniff()` calls these `found` rather than `blocked: thin-render`. */
const page = (heading: string, body: string, extra = ""): string =>
  `<html><head><title>${heading}</title></head><body><h1>${heading}</h1>` +
  `<p>${body}</p><p>Teams adopt this after an incident review shows nobody could answer a ` +
  `question about production in time. It runs as a hosted service, it keeps a retention ` +
  `window their auditors accept, and it bills on ingested volume rather than per seat.</p>` +
  `${extra}</body></html>`

/**
 * The anchor's `llms.txt`. Plain text on purpose: `read()` refuses a `.txt` url
 * that answers with HTML (`html-for-text-url`), which is a real measured case,
 * and a fixture that tripped it would silently take the run down the DNS-probe
 * path instead.
 */
const LLMS_TXT =
  `# Pellucid\n\nPellucid is a hosted observability suite for small platform teams.\n\n` +
  `## Products\n\n- Log Search: full-text search over application logs with a retention window ` +
  `the finance team signs off on.\n- Uptime Alerts: synthetic checks that page whoever is ` +
  `on call when an endpoint stops answering.\n\n## Buyers\n\nPlatform and SRE teams of five to ` +
  `fifty engineers who have outgrown grepping over ssh but cannot staff an observability team ` +
  `of their own. They arrive after an incident nobody could explain.\n`

const HOME = page(
  "Pellucid — see production",
  "Pellucid runs log search and uptime alerts for small platform teams.",
  `<nav><a href="/products/log-search">Log Search</a><a href="/products/uptime-alerts">Uptime Alerts</a>` +
    `<a href="/blog/incident-review">Blog</a></nav>`,
)

/** The exact sentence `loglens`'s classify answer quotes back. Kept as a
 *  constant because the span gate checks it as a literal substring of the
 *  condensed page, and a fixture that quietly failed that check would ship the
 *  "could not be tied to its page" fallback and look like a passing test. */
export const LOGLENS_SPAN = "Loglens replays log volume against a retention budget"

const FETCH_TABLE: Record<string, { httpStatus: number; body: string; contentType?: string }> = {
  [`https://${ANCHOR}/llms.txt`]: { httpStatus: 200, body: LLMS_TXT, contentType: "text/plain" },
  [`https://${ANCHOR}/`]: { httpStatus: 200, body: HOME, contentType: "text/html" },
  [`https://${ANCHOR}/products/log-search`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("Log Search", "Full-text search over application logs, retained for a year."),
  },
  [`https://${ANCHOR}/products/uptime-alerts`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("Uptime Alerts", "Synthetic checks that page the on-call engineer."),
  },
  [`https://${HOSTS.grepstack}/`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("Grepstack", "Grepstack sells hosted log search to platform teams."),
  },
  [`https://${HOSTS.tailwatch}/`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("Tailwatch", "Tailwatch is log search and uptime checks in one console."),
  },
  [`https://${HOSTS.loglens}/`]: {
    httpStatus: 200,
    contentType: "text/html",
    // Names the anchor, so `judgeHosts` keeps it as a recall probe — which is
    // what gives `report.recall` something to be computed from.
    body: page(
      "Loglens",
      `${LOGLENS_SPAN} instead of charging per seat.`,
      `<p>Compared with ${ANCHOR} and ${HOSTS.grepstack} on price per ingested gigabyte.</p>`,
    ),
  },
  [`https://${HOSTS.forum}/`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("The Ops Forum", "Where on-call engineers argue about retention windows and alert fatigue."),
  },
  [`https://${HOSTS.adtrash}/`]: {
    httpStatus: 200,
    contentType: "text/html",
    body: page("Deals Daily", "Coupon codes and discount roundups for software buyers."),
  },
  // No row for HOSTS.walled: an unlisted url is a 404 with an empty body.
}

const hit = (host: string, title: string, description: string): SearchHit => ({
  url: `https://${host}/`,
  title,
  description,
})

/**
 * What each query returns.
 *
 * Arranged so the pieces downstream have work to do: `grepstack`+`tailwatch`
 * co-occur in three different queries and `grepstack`+`loglens` in two (the
 * selector's floor), while every other pair co-occurs once and is dropped.
 * `loglens`'s own snippet names Tailwatch, so the FREE naming pass resolves
 * that pair before the model is asked about anything.
 */
export const SERP: Record<string, SearchHit[]> = {
  "log search": [
    hit(HOSTS.grepstack, "Grepstack — hosted log search", "Log search for platform teams."),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
    hit(HOSTS.walled, "Walled", "A vendor whose front page refuses anonymous readers."),
  ],
  "log search alternatives": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search."),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
    hit(HOSTS.loglens, "Loglens", "Priced on ingest, and reviewers weigh it against Tailwatch."),
  ],
  "Log Search Cloud alternatives": [
    hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
    hit(HOSTS.forum, "The Ops Forum", "Retention window threads."),
  ],
  "uptime monitoring": [
    hit(HOSTS.tailwatch, "Tailwatch", "Synthetic checks."),
    hit(HOSTS.forum, "The Ops Forum", "Alert fatigue threads."),
  ],
  "uptime monitoring alternatives": [hit(HOSTS.adtrash, "Deals Daily", "Coupons for monitoring tools.")],
  "Pellucid alternatives": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search."),
    hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
  ],
  "Pellucid vs": [hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console.")],
  "Pellucid competitors": [
    hit(HOSTS.grepstack, "Grepstack", "Hosted log search."),
    hit(HOSTS.tailwatch, "Tailwatch", "Logs and uptime in one console."),
  ],
  "how do i find one request across a hundred containers": [
    hit(HOSTS.forum, "The Ops Forum", "Grepping over ssh does not scale."),
  ],
  "keeping a year of logs without paying per seat": [
    hit(HOSTS.loglens, "Loglens", "Priced on ingest."),
  ],
  "who gets paged when an endpoint stops answering": [
    hit(HOSTS.forum, "The Ops Forum", "On-call rotations."),
  ],
  "synthetic checks from more than one region": [
    hit(HOSTS.tailwatch, "Tailwatch", "Checks from nine regions."),
    hit(HOSTS.forum, "The Ops Forum", "Which regions actually catch an outage."),
  ],
  // A widening round's fresh query, so a round that widens actually lands a
  // host and the yield floor has a real number to judge.
  "audit trail for who read which log line": [
    hit("compliancely.example", "Compliancely", "Access logs for log access."),
  ],
}

// ── the model ────────────────────────────────────────────────────────────────

/**
 * The engine's five `generateObject` schemas, told apart by their own property
 * names. Reordering a schema's fields does not move this; renaming one does,
 * loudly, which is correct — the schema IS the contract being tested.
 *
 * Not the same set as `sweep.ts`'s `Phase`, which names the five stages of the
 * UI rail: `plan` issues both the catalog and the assess calls, and `write`
 * issues none at all. These are model calls, not stages.
 */
export type CallPhase =
  | "understand"
  | "catalog"
  | "assess"
  | "classify"
  | "link"
  | "orphan"
  | "discovery"
  | "triage"
  | "drop-confirm"
  | "listicle"

const PHASE_BY_KEY: Array<[CallPhase, string]> = [
  ["understand", "capabilities"],
  ["catalog", "generic"],
  ["assess", "enough"],
  ["classify", "spans"],
  ["link", "edges"],
  // The orphan ask: entities with no edge, asked where they stand. Its
  // schema's distinctive key is `stands`.
  ["orphan", "stands"],
  // The metadata triage: batched keep/skip verdicts before any fetch. Its
  // schema's distinctive key is `verdicts`.
  ["triage", "verdicts"],
  // Drop-confirm: a second opinion on model-settled `relation: "none"`
  // hosts, from stored evidence alone. Its schema's distinctive key is
  // `placements` — deliberately not `verdicts`, which triage already owns.
  ["drop-confirm", "placements"],
  // Listicle harvest: vendor names pulled out of a roundup-shaped row's own
  // title/description. Its schema's distinctive key is `vendors`.
  ["listicle", "vendors"],
]

function phaseOf(schema: unknown): CallPhase {
  const props = Object.keys(
    ((schema as { schema?: { properties?: Record<string, unknown> } })?.schema?.properties ?? {}),
  )
  for (const [phase, key] of PHASE_BY_KEY) if (props.includes(key)) return phase
  throw new Error(`unrecognised generateObject schema: {${props.join(", ")}}`)
}

/** `    the product   Log Search` — the catalog prompt's own layout. */
const productOf = (prompt: string): string => /the product\s{2,}(.+)/.exec(prompt)?.[1]?.trim() ?? ""
/** `grepstack.example — how this run found it, 3 queries in all:` — the classify prompt's provenance header. */
const hostOf = (prompt: string): string => /^(\S+) — how this run found it, \d+ quer/m.exec(prompt)?.[1] ?? ""
/** `grepstack.example — seen in 3 queries — "…" — …` — the triage prompt's batch lines. */
const hostsOfTriage = (prompt: string): string[] =>
  [...prompt.matchAll(/^(\S+) — seen in \d+ quer/gm)].map((m) => m[1]!)
/** `grepstack.example` on its own line followed by an indented `what:` — the
 *  drop-confirm prompt's per-host block header. */
const hostsOfDropConfirm = (prompt: string): string[] =>
  [...prompt.matchAll(/^(\S+)\n {2}what:/gm)].map((m) => m[1]!)
/** `"a title" — a description` — the listicle-harvest prompt's per-row line,
 *  read back as the titles it carried. */
const titlesOfListicle = (prompt: string): string[] =>
  [...prompt.matchAll(/^"(.*)" — /gm)].map((m) => m[1]!)

export interface LinkPair {
  a: string
  b: string
  seen: number
}

/** The pairs block, read back out of the rendered link prompt. Throws rather
 *  than returning nothing: a fixture that silently stopped seeing pairs would
 *  make the link phase look free. */
export function pairsOf(prompt: string): LinkPair[] {
  const re = /^(\S+) \([a-z]+\) — .*\n\s+(\S+) \([a-z]+\) — .*\n\s+co-occurred in (\d+) different searches$/gm
  const out = [...prompt.matchAll(re)].map((m) => ({ a: m[1]!, b: m[2]!, seen: Number(m[3]) }))
  if (!out.length) throw new Error("the link prompt carried no pair this fixture could read")
  return out
}

/** One turn of the discovery agent: tool calls, or the text that ends the loop. */
export type DiscoveryTurn = { tools: Array<{ toolName: string; input: unknown }> } | { text: string }

export interface Script {
  understand?: (prompt: string) => unknown
  catalog?: (product: string, prompt: string) => unknown
  /** `round` counts from 1. */
  assess?: (round: number, prompt: string) => unknown
  classify?: (host: string, prompt: string) => unknown
  link?: (pairs: LinkPair[], prompt: string) => unknown
  /** The discovery agent's turns, `turn` counting model calls from 0. Only
   *  reached when the run sets `discovery: "agent"`; the default script mirrors
   *  what `understand` answers, so the two modes describe one company. */
  discovery?: (turn: number, prompt: string) => DiscoveryTurn
  /** The orphan ask: entities with no edge, and where each stands. The
   *  default answers "nobody" for all of them, so the map every existing test
   *  pins keeps exactly the edges it had. */
  orphan?: (prompt: string) => unknown
  /** The metadata triage, handed the hosts its prompt asked about. Only
   *  reached when the run sets `triage: true`; the default keeps every host,
   *  so a test that flips the flag without a script changes nothing. */
  triage?: (hosts: string[], prompt: string) => unknown
  /** The drop-confirm ask, handed the hosts its prompt asked about — every
   *  model-settled `relation: "none"` entity, up to DROP_CONFIRM_CAP. Only
   *  reached when the run sets `dropConfirm: true`; the default confirms
   *  every host unrelated, so a test that flips the flag without a script
   *  changes nothing. */
  dropConfirm?: (hosts: string[], prompt: string) => unknown
  /** The listicle-harvest ask, handed the titles of the roundup-shaped rows
   *  its prompt carried. Only reached when the run sets `listicleHarvest:
   *  true` AND at least one row matched `ROUNDUP_SHAPE`; the default finds no
   *  vendor, so a test that flips the flag without a script changes nothing. */
  listicle?: (titles: string[], prompt: string) => unknown
}

/** Every model call the run made, in order. */
export interface ModelCall {
  phase: CallPhase
  prompt: string
  /** The product for a catalog call, the host for a classify call, "" elsewhere. */
  subject: string
  /** The generateObject schema's own property order for this call — undefined
   *  for the text-only discovery turns, which carry no schema at all. Field
   *  order here is the order a structured-output provider fills the object
   *  in, which is not necessarily the order the prompt mentions fields in;
   *  a measured 26%-vs-85% fill gap found `reasoning` and its prompt at
   *  odds about that order and this is what would have caught it. */
  schemaKeys?: string[]
}

/** Fixed, so the bill is arithmetic a test can do independently. With the
 *  pricing below, one model call costs exactly $2. */
const USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 250, text: 250, reasoning: 0 },
}
export const PRICING = { inUsdPerM: 1_000, outUsdPerM: 4_000 }
export const USD_PER_MODEL_CALL = 2
/** `FakeSearch` charges this for a query it answered, and nothing for one it
 *  refused — the shape the real port has, and the reason the run may not
 *  re-derive its bill from `serpCalls × price`. */
export const USD_PER_SEARCH = 0.001

// ── running one ──────────────────────────────────────────────────────────────

export interface Harness {
  result: SweepResult
  search: FakeSearch
  fetch: FakeFetch
  calls: ModelCall[]
  /** Every query that reached the port, flattened, in order. */
  asked: string[]
  /** The run's whole span log, drained after it finished. */
  spans: Span[]
  /** Narration frames of one namespace and `kind`, in order — the numbers the
   *  browser was actually shown, which are not always the numbers in `report`. */
  ui: (ns: UiNamespace, kind: string) => Record<string, unknown>[]
  /** Every `progress` line, in order. A run's stopping RULES are sometimes
   *  distinguishable only by which sentence the operator was given: two rules
   *  can end the same run in the same place and mean different things about
   *  what to do next. */
  says: string[]
}

export interface FixtureOptions {
  script?: Script
  /** Queries `FakeSearch` refuses, reported inside their own row. */
  failing?: string[]
  /** Make every answered query report this much rate-limit wait, so the
   *  sweep's `report.serp.paced` aggregation can be exercised. */
  pacedMs?: number
  serp?: Record<string, SearchHit[]>
  /** Rows laid OVER the market's own fetch table, for a run that needs a
   *  surface this company does not publish — a sitemap, say. Merged rather than
   *  replacing, so a test adds one url without restating the whole company, and
   *  a run that passes nothing here fetches exactly what it always did. */
  fetchTable?: Record<
    string,
    {
      httpStatus: number
      body: string
      contentType?: string
      /** The DIFFERENT answer an `unlocked` fetch gets for this same URL — the
       *  one way a test tells a blocked page's two modes apart. Omit to answer
       *  both modes identically, the table's behaviour before this field existed. */
      unlocked?: { httpStatus: number; body: string; contentType?: string }
    }
  >
  sweepOptions?: Partial<SweepOptions>
  /** Make the fixture's DNS preflight (`resolves()` in sweep.ts) answer `true`
   *  instead of the default `false`, while `fetch` stays blocked as always. A
   *  run's own three surfaces still have to be routed to failure through
   *  `fetchTable` — this only changes what the DNS half of "nothing readable
   *  and no DNS record" reports. Default `false` because every existing test
   *  wants the network fully dead, DNS included. */
  dnsResolves?: boolean
}

/**
 * Every run gets one, and it is never aborted here.
 *
 * A caller MAY omit `signal` — the CLI does — and then `fetcher.get(url, mode,
 * { signal: undefined })` is correct rather than a dropped signal, which would
 * make "every fetch carries the run's signal" unfalsifiable. Handing one over
 * on every fixture run is what turns that into a property with a red state:
 * drop `{ signal }` at any call site and the recorded call carries `undefined`.
 */
const freshSignal = () => new AbortController().signal

/**
 * The default script: a two-product company, one core market and one adjacent,
 * one coinage-naming query and one anchor-naming query per product for the ban
 * to eat, and an assess call that is satisfied immediately.
 */
export function defaultScript(): Required<Script> {
  return {
    understand: () => ({
      sells: "hosted log search and uptime alerts for small platform teams",
      buyer: "a platform team of five to fifty engineers who have just had an incident nobody could explain",
      brand: "Pellucid",
      products: [
        { name: "Log Search Cloud", does: "searches application logs", foundAt: `https://${ANCHOR}/products/log-search` },
        { name: "Uptime Alerts", does: "pages the on-call engineer", foundAt: `https://${ANCHOR}/products/uptime-alerts` },
      ],
      capabilities: [
        { name: "log search", does: "answers a question about production", covers: ["Log Search Cloud"], centrality: "core" },
        { name: "uptime alerts", does: "notices an endpoint stopped answering", covers: ["Uptime Alerts"], centrality: "adjacent" },
      ],
      coinages: [COINAGE],
    }),
    catalog: (product) =>
      product === "Log Search Cloud"
        ? {
            terms: ["log search", "log management"],
            generic: false,
            queries: [
              q("how do i find one request across a hundred containers", "pain", "log search"),
              // Names a coinage. Dropped before anything is bought.
              q(`${COINAGE} log pipeline sizing`, "evaluation", "log search"),
              q("keeping a year of logs without paying per seat", "evaluation", "log search"),
            ],
          }
        : {
            terms: ["uptime monitoring"],
            generic: true,
            queries: [
              q("who gets paged when an endpoint stops answering", "pain", "uptime alerts"),
              // Names the anchor. Dropped before anything is bought.
              q(`${ANCHOR_NAME} status page setup`, "evaluation", "uptime alerts"),
              q("synthetic checks from more than one region", "evaluation", "uptime alerts"),
            ],
          },
    assess: () => ({ enough: true, missing: "", draw: [], queries: [] }),
    orphan: () => ({ stands: [] }),
    triage: (hosts) => ({ verdicts: hosts.map((h) => ({ host: h, keep: true, why: "kept" })) }),
    dropConfirm: (hosts) => ({
      placements: hosts.map((h) => ({
        host: h,
        kind: "noise",
        relation: "none",
        what: "",
        why: "confirmed unrelated",
        spans: [],
      })),
    }),
    listicle: () => ({ vendors: [] }),
    discovery: (turn) =>
      turn === 0
        ? {
            tools: [
              {
                toolName: "submitProduct",
                input: { name: "Log Search Cloud", does: "searches application logs", foundAt: `https://${ANCHOR}/products/log-search` },
              },
              {
                toolName: "submitProduct",
                input: { name: "Uptime Alerts", does: "pages the on-call engineer", foundAt: `https://${ANCHOR}/products/uptime-alerts` },
              },
            ],
          }
        : turn === 1
          ? {
              tools: [
                {
                  toolName: "finish",
                  input: {
                    sells: "hosted log search and uptime alerts for small platform teams",
                    buyer: "a platform team of five to fifty engineers who have just had an incident nobody could explain",
                    coinages: [COINAGE],
                  },
                },
              ],
            }
          : { text: "the catalogue is complete" },
    classify: (host) => CLASSIFY[host] ?? unknownHost(host),
    link: (pairs) => ({
      edges: [
        ...pairs.map((p) => ({
          from: p.a,
          to: p.b,
          relation: "competitor" as const,
          why: "both answer the same question for the same team",
          confidence: "inferred" as const,
        })),
        // A model naming something it remembers rather than something the run
        // found. Both ends must be on the map or the edge is dropped.
        {
          from: HOSTS.grepstack,
          to: "ghost.example",
          relation: "competitor" as const,
          why: "an edge to a host nobody searched up",
          confidence: "inferred" as const,
        },
      ],
    }),
  }
}

const q = (text: string, intent: string, market: string) => ({
  q: text,
  intent,
  platform: "web",
  why: "what a buyer types before they know any vendor's name",
  market,
})

const classified = (name: string, kind: string, relation: string, what: string, span: string) => ({
  name,
  kind,
  what,
  relation,
  why: `stands this way to ${ANCHOR} on the evidence of its own front page`,
  spans: [span],
})

const CLASSIFY: Record<string, ReturnType<typeof classified>> = {
  [HOSTS.grepstack]: classified("Grepstack", "company", "competitor", "A hosted log search vendor selling to platform teams.", "Grepstack sells hosted log search to platform teams"),
  [HOSTS.tailwatch]: classified("Tailwatch", "company", "competitor", "A vendor selling log search and uptime checks in one console.", "log search and uptime checks in one console"),
  [HOSTS.loglens]: classified("Loglens", "company", "substitute", "A log retention service priced on ingested volume.", LOGLENS_SPAN),
  [HOSTS.forum]: classified("The Ops Forum", "community", "discusses", "A forum where on-call engineers argue about retention and alerting.", "argue about retention windows and alert fatigue"),
  [HOSTS.adtrash]: classified("Deals Daily", "noise", "none", "A coupon site with nothing to do with this market.", "Coupon codes and discount roundups"),
}

const unknownHost = (host: string) => classified(host, "unknown", "unknown", "", "no page")

/** One line of the itemised bill, as `report.cost` carries it. */
export interface CostLine {
  label: string
  calls: number
  failures: number
  usd: number
  ms: number
}

export interface Cost {
  usd: number
  elapsedMs: number
  calls: number
  tokens: number
  ceilingUsd: number | null
  byKind: CostLine[]
  byAgent: CostLine[]
  partial: boolean
}

/** `report` is a `Record<string, unknown>` on purpose — it is a wire shape, not
 *  a type anyone imports. This is the one cast, in one place. */
export const costOf = (r: SweepResult): Cost => r.report.cost as Cost
export const lineOf = (rows: CostLine[], label: string): CostLine => {
  const row = rows.find((l) => l.label === label)
  if (!row) throw new Error(`the bill has no "${label}" line: ${rows.map((l) => l.label).join(", ")}`)
  return row
}

/** Real network, hard-blocked for the duration. Anything that escapes the ports
 *  explodes instead of billing someone. */
let netBlocked = false

export function blockTheNetwork(opts: { dnsResolves?: boolean } = {}): () => void {
  // Refuses to nest rather than mis-restoring. The first draft saved whatever
  // `globalThis.fetch` was at install time, so two overlapping installs left the
  // second restoring the FIRST one's throwing stub — and the first then restored
  // the real fetch while a run was still going. A guard whose failure mode is
  // handing back the live network is worse than no guard.
  if (netBlocked) throw new Error("blockTheNetwork() is already installed — runFixture cannot nest")
  netBlocked = true

  const real = globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error("REAL NETWORK CALL ATTEMPTED FROM A SWEEP FIXTURE")
  }) as unknown as typeof fetch

  // The engine's second door, and `fetch` does not cover it: sweep.ts:2651 runs
  // a DNS preflight when the anchor yielded no product pages, and :1390 reaches
  // it through `await import("node:dns/promises")`. Measured — a run that
  // escaped the ports produced `dns.promises.lookup pellucid.example` with this
  // guard installed and active. A guard that names itself after the network and
  // watches one of its two doors is a guard that will be trusted wrongly.
  //
  // `dnsResolves` answers that same preflight the other way, for the one test
  // (SELF-255) that needs `resolves()` to return `true` while every fetch still
  // throws: without it, every fixture run's anchor is DNS-dead by construction
  // and the "found the domain, still could not read it" branch at sweep.ts:2703
  // is unreachable by the whole suite.
  const realLookup = dns.promises.lookup
  dns.promises.lookup = (opts.dnsResolves
    ? (async () => ({ address: "203.0.113.1", family: 4 }))
    : (() => {
        throw new Error("REAL DNS LOOKUP ATTEMPTED FROM A SWEEP FIXTURE")
      })) as never

  return () => {
    globalThis.fetch = real
    dns.promises.lookup = realLookup as never
    netBlocked = false
  }
}

export async function runFixture(opts: FixtureOptions = {}): Promise<Harness> {
  const script = { ...defaultScript(), ...opts.script }
  const search = new FakeSearch(opts.serp ?? SERP, { failing: opts.failing, pacedMs: opts.pacedMs })
  const fetcher = new FakeFetch({ ...FETCH_TABLE, ...(opts.fetchTable ?? {}) })
  const spans = new SpanStream()
  const calls: ModelCall[] = []
  let rounds = 0

  const model = new MockLanguageModelV4({
    doGenerate: async ({ responseFormat, prompt }) => {
      // Every one of the engine's calls passes `generateObject` a plain string,
      // so this is one user message carrying one text part. Flattened
      // defensively anyway — the routing below must never key off a prompt that
      // silently came back empty.
      const parts = prompt.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>) : [],
      )
      const text = parts
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
      if (!text) throw new Error("the fixture model was handed a prompt with no text in it")

      // No JSON response format means this is not one of the engine's five
      // generateObject calls — it is the discovery agent taking a turn through
      // ToolLoopAgent, which only ever asks for text and tool calls. Turns are
      // counted by prior assistant messages rather than tool results, because
      // one turn may carry several tool calls and their results may arrive as
      // one message or many.
      const rf = responseFormat as { type?: string } | undefined
      if (!rf || rf.type !== "json") {
        const turn = prompt.filter((m) => m.role === "assistant").length
        // The whole transcript, not just its text parts: a discovery turn's
        // prompt IS its tool results, and a test asserting the agent saw what
        // a tool returned has nowhere else to look for it.
        calls.push({ phase: "discovery", prompt: JSON.stringify(prompt), subject: String(turn) })
        const step = script.discovery(turn, text)
        if ("text" in step) {
          return {
            content: [{ type: "text" as const, text: step.text }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: USAGE,
            warnings: [],
          }
        }
        return {
          content: step.tools.map((c, i) => ({
            type: "tool-call" as const,
            toolCallId: `disc-${turn}-${i}`,
            toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        }
      }

      const phase = phaseOf(responseFormat)
      const subject = phase === "catalog" ? productOf(text) : phase === "classify" ? hostOf(text) : ""
      const schemaKeys = Object.keys(
        ((responseFormat as { schema?: { properties?: Record<string, unknown> } })?.schema?.properties) ?? {},
      )
      calls.push({ phase, prompt: text, subject, schemaKeys })
      const object =
        phase === "understand"
          ? script.understand(text)
          : phase === "catalog"
            ? script.catalog(subject, text)
            : phase === "assess"
              ? script.assess(++rounds, text)
              : phase === "classify"
                ? script.classify(subject, text)
                : phase === "orphan"
                  ? script.orphan(text)
                  : phase === "triage"
                    ? script.triage(hostsOfTriage(text), text)
                    : phase === "drop-confirm"
                      ? script.dropConfirm(hostsOfDropConfirm(text), text)
                      : phase === "listicle"
                        ? script.listicle(titlesOfListicle(text), text)
                        : script.link(pairsOf(text), text)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(object) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USAGE,
        warnings: [],
        // The gateway names the upstream host that served a call; the engine
        // tallies calls and refusals per host into `report.model.servedBy`.
        // One name for every fixture answer, so a test can read the tally.
        providerMetadata: { openrouter: { provider: FIXTURE_HOST } },
      }
    },
  })

  const restore = blockTheNetwork({ dnsResolves: opts.dnsResolves })
  try {
    const result = await sweep({
      domain: ANCHOR,
      spans,
      // Never read: `ports` replaces both ports before a credential is used.
      // Present because the field is required, and deliberately not plausible.
      model: model as never,
      modelId: "fixture/mock",
      pricing: PRICING,
      // Two, so `serpCalls` is a multiplication a test can check rather than a
      // number that happens to equal the query count.
      pages: 2,
      signal: freshSignal(),
      // Spread ABOVE the ports, not below. Below, a caller passing
      // `sweepOptions: { ports: undefined }` overwrote the injected pair and the
      // engine built real Bright Data ports from the placeholder creds —
      // measured, it reached DNS for `pellucid.example` before dying. That is
      // the half-injected state `SweepOptions.ports` is one field precisely to
      // prevent, handed back by the harness that exists to make it impossible.
      ...opts.sweepOptions,
      creds: { token: "not-a-token", serpZone: "none", unlockerZone: "none" },
      ports: { search, fetch: fetcher },
    })
    // The log is retained, so draining after `close()` replays the whole run in
    // `seq` order — the same sequence a browser that attached at the start saw.
    spans.close()
    const log: Span[] = []
    for await (const s of spans.stream()) log.push(s)
    const ui = (ns: UiNamespace, kind: string) =>
      log
        .map(readUi)
        .filter((f): f is NonNullable<typeof f> => f !== null && f.ns === ns && f.frame.kind === kind)
        .map((f) => f.frame)
    const says = log
      .map(readUi)
      .filter((f): f is NonNullable<typeof f> => f !== null && f.ns === "progress")
      .map((f) => String(f.frame.message ?? ""))
    return { result, search, fetch: fetcher, calls, asked: search.calls.flat(), spans: log, ui, says }
  } finally {
    restore()
  }
}
