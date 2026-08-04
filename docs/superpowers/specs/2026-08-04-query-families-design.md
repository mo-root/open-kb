# Query families and the self-widening sweep

Date: 2026-08-04. Status: approved in conversation; supersedes the query-shape section of
`prompts/agents/catalog.md` and extends `docs/swarm-spec.md` phase 3.

## The defect this fixes

The catalog prompt writes 3–5 clever de-branded queries per product and instructs the model to name
no product category at all. That de-branded the queries so hard it de-categorized them: `web
scraper` names no vendor, yet nothing in the current doctrine will ever type it. One plain Google
search for `web scraper` returns Apify, Data Miner, Oxylabs, Scrapy and the GitHub topic page — the
head-to-head field from a single boring query. v1 knew this: seven of its ten shapes were plain
searches, and the bare term came first. The clever queries find a market's edges; the plain term
finds its center, and the current engine skips the center.

The spec's branded channel (`<product> alternatives`, `<product> vs`) is also unbuilt.

## The idea

Market-research queries come in families, the way SEO classifies search intent. Each family opens a
different door into the same market, and a map built through one door reads as complete while
missing what the other doors see. So: per product, queries are dealt across families — and the mix
is the agent's call, not a quota. Flexible, however the agent wants it; what is guaranteed is that
the families exist, the agent understands what each one is for, and the plain center can never be
skipped again.

## The families (doctrine, not an enum)

Defined in prompts so they are editable without a rebuild, and open-ended — the doctrine file is
the registry, and an agent that can justify a new family may use it.

- **plain** — the stripped category term and its commercial-investigation forms: the bare term,
  `best <term>`, `<term> vs`, `<term> alternatives`, `top <term> companies`, `open source <term>`.
  SEO would call these commercial-investigation intent. Finds the CENTER: who competes head-to-head,
  and how the market talks about itself. These queries are boring on purpose; boring is the feature.
- **debranded** — the job as an outcome, the moment it breaks, the DIY route, where buyers argue.
  No vendor and no category word. Finds SUBSTITUTES and adjacent solvers that no comparison article
  lists. This is the only family the understand phase may ever use.
- **branded** — the product's own name: `<product> alternatives`, `<product> vs`, `<product>
  reviews`. Navigational/comparative intent. Finds the ecosystem that forms AROUND a name: the
  comparison posts, the migration threads, the review pages. The coinage ban is reversed for this
  family only, deliberately; it holds everywhere else.

## The agent-demand lens (the one deliberate tilt)

The map leans developer. For a product whose buyer can be an AI agent or the team building one, the
hand MUST include queries from that world: the MCP server for this job, the agent harness it plugs
into, the tool-call integration, the failure an agent run hits that a human script never did. This
is not a fourth family — it is a lens the agent applies across families (`mcp server for web
scraping` is plain; the agent-run failure is debranded). The existing three-slot gate holds: name
the new consumer, the new socket and the new failure, or skip it — a pump manufacturer cannot fill
the slots and no query should pretend it can. This tilt is the owner's chosen bias, stated here so
nobody later mistakes it for drift.

## Strip

Per product, a model step produces 1–3 terms a buyer would actually type, ordered by closeness:
`Web Scraper API` → `web scraper`, `web scraping api`, `data extraction tool`. The first term gets
the full plain-template expansion; the rest ride along as bare queries when the sweep widens. The
strip is a visible artifact on the map — the product, the terms it stripped to, and a reference to
the product page it was read from — because stripping is the method's hinge and a reader should be
able to audit it.

## Generation

- **Templates guarantee plain and branded.** Code expands them from the strip terms and the product
  name. Free, deterministic, cannot be forgotten by a model having a clever day.
- **The model writes debranded.** That is where judgement pays and templates cannot go.
- **The agent deals the hand.** Roughly five opening queries per product across the families —
  flexible in mix, and an OPENING, not a cap. No per-product seal.
- Every query carries `{ product, family, term, why }`. Every hit inherits it.

## The widening loop (the agentic part, stated plainly)

The agent's job is not writing the opening queries — templates and one model call do that. Its job
is deciding what to type NEXT after seeing what came back, which is what a human researcher does:

- queries returning the same hosts → repetition → switch family or pull the next strip term
- a family returning fresh hosts on this product → deepen it
- a product whose whole hand came back thin → it gets more, taken from nobody
- the map looks full and new queries only corroborate → say enough and stop

Per product, per family, judged on yield. Bounded by the spend ceiling underneath, never by a
per-product quota.

## Tagging and the graph

hit → query → product → market is the `foundBy` join that already exists; family joins it. The
graph is born attributed: every entity knows which product's search surfaced it and through which
door. UI shows the family on the entity and can filter by it.

## References, everywhere

- Catalog cards link `foundAt` — the company's own page that establishes each product. Captured
  today, dropped by the UI today.
- `sells` / `buyer` cite the pages they were read from.
- The strip artifact cites the product page it stripped.
- Entities keep their existing citations and gain the family chip.

Nothing on the map is unclickable, including what the anchor itself sells.

## Owner decisions, 2026-08-04

Asked and answered before implementation; these override anything above that disagrees:

- **Company-level branded, once per run.** Besides each product's branded queries, the run fires
  `<company> alternatives`, `<company> vs`, `<company> competitors` — the densest comparison pages
  a map has. This requires the anchor-naming filter to EXEMPT the branded family; it keeps
  filtering plain and debranded.
- **Generic product names skip branded.** A product named like a common noun ("Datasets") gets no
  branded queries — `Datasets alternatives` buys noise about the concept. The strip step judges
  genericness. The company-level branded set covers the gap.
- **Section labels are plain sentences.** "What <company> sells" / "What the market sells" /
  "Who's in this market" — the tab reads like an answer, not a taxonomy.
- **Spend ceiling $5 per run while invite-gated** (`OPENKB_CEILING_USD=5`), the only brake now
  that query quotas are gone.

## The bar

- **The screenshot test, on ANY anchor:** the plain family must surface the head-to-head field that
  one manual search of the product's bare term returns. `web scraper` → Apify, Oxylabs, Scrapy is
  the illustration, not the benchmark; the bar is judged across the five-company spread (resend,
  clerk, brightdata, flexport, grundfos), never against one company.
- Debranded must still contribute entities the plain family missed — if it stops doing so on every
  product, its doctrine has rotted.
- A family contributing nothing across an entire run is reported, not silently absorbed.
- For developer-facing products, the agent-demand lens must actually fire: at least one query per
  such product from the agent/MCP/harness world.
- Cost is not estimated here. Every call is billed through span accounting at runtime and the run
  reports what it spent; estimates in a spec only go stale and mislead.

## First measurement

Date: 2026-08-05. One bounded probe (`pnpm sweep brightdata.com 12`, the `queries: 12` override)
verdict: PASS — families all present, the agent-demand lens fired on the Discover API product,
templates well-formed, nothing named the anchor. Proceeded to three full uncapped runs, sequential:
`pnpm sweep brightdata.com`, `pnpm sweep grundfos.com`, `pnpm sweep resend.com` — the three-of-five
slice of the bar's named spread this pass covered (clerk.com and flexport.com not run here).

Getting the full runs to actually exercise the uncapped path required a permanent fix: `scripts/
sweep.ts` always passed a numeric `queries` (default 40), which silently kept every CLI invocation on
the OLD capped-catalog behavior — the exact quota this spec removes — while the web route already
treated an unset value as normal. Fixed to leave `queries` unset unless a third arg is given.

### The nine checks

| # | check | brightdata.com | grundfos.com | resend.com |
|---|---|---|---|---|
| 1 | all three families asked > 0 | plain 53, debranded 62, branded 8 — PASS | plain 23, debranded 26, branded 6 — PASS | plain 27, debranded 43, branded 6 — PASS |
| 2 | plain finds ≥3/5 of Apify/Oxylabs/Zyte/ScraperAPI/Scrapy | 5/5 found — PASS | n/a | n/a |
| 3 | ≥1 agent-demand query fired | 3 fired, e.g. `mcp server web browser scrape` (Web Scraper API), `langchain google search tool mcp` (SERP API) — PASS | n/a | n/a (2 fired anyway, unrequested bonus) |
| 4 | ZERO agent-demand queries | n/a | 0 fired across 55 queries, incl. several industrial-protocol ones (Modbus/BACnet/MQTT) that could have tempted an "agent" framing and didn't — PASS | n/a |
| 5 | debranded finds hosts plain missed | 406 hosts unique to debranded (541 debranded vs 495 plain) — PASS | 184 unique (219 vs 254) — PASS | 387 unique (476 vs 219) — PASS |
| 6 | every decomposed product appears in strips | 13/13 — PASS | 3/3 — PASS | 7/7 — PASS |
| 7 | `report.readPages` non-empty | 3 pages — PASS | 1 page (homepage only; both llms.txt attempts missed) — PASS | 2 pages — PASS |
| 8 | company-branded fired, not dropped by the anchor filter | `Bright Data alternatives/vs/competitors`, 31-35 hits each — PASS | `Grundfos alternatives/vs/competitors`, 20-35 hits each — PASS | `Resend alternatives/vs/competitors`, 20-26 hits each — PASS |
| 9 | generic-judged products fire no branded query | 4 products (Crawl API, Discover API, Managed data acquisition, Web Archive API) fired zero branded queries with no dedup collision to explain it away — PASS | `Advanced Selection` fired zero — PASS | 5 products (Audiences, Automations, Broadcasts, Dedicated IPs, Webhooks) fired zero — PASS |

`report.strips` and `report.readPages` don't carry the model's own `generic` verdict per product, so
check 9 is read off absence-of-query rather than the flag itself — every case checked had no
plain/branded term collision to blame instead, which is the closest confirmation the persisted output
allows.

### Per-run stats

| run | entities kept (noise) | hosts | queries opening→fired | family split | duration | true cost |
|---|---|---|---|---|---|---|
| probe: brightdata, `queries:12` | 630 (45) | 675 | 12→73 | plain 46 / debranded 25 / branded 2 | 620s | $1.68 |
| brightdata.com, uncapped | 910 (24) | 934 | 63→123 | plain 53 / debranded 62 / branded 8 | 702s | $2.80 |
| grundfos.com, uncapped | 477 (63) | 540 | 20→55 | plain 23 / debranded 26 / branded 6 | 289s | $1.56 |
| resend.com, uncapped | 617 (12) | 629 | 34→76 | plain 27 / debranded 43 / branded 6 | 615s | $2.00 |

"true cost" is the running total read from span accounting at the run's last billed action, not the
persisted `stats.usd`/`report.usd` — those undercount, see below. Total measured spend across all
four runs: **~$8.04 true** (the pipeline's own self-reported totals sum to $6.85). The old baseline
for brightdata was ~160 entities at 40 capped queries; this pass's uncapped brightdata run found 910
kept entities from 123 fired queries — 5.7x the entities for ~3x the queries.

### An engine bug this validation surfaced, not fixed here

`packages/sweep/src/sweep.ts` snapshots `usd`/`seconds` (copied into `stats` and `report`) BEFORE the
paid model-linking phase runs, so every run's self-reported cost and duration excludes linking
entirely. Measured directly against span accounting on this pass: brightdata reported $2.4099/644s,
true $2.80/702s; grundfos reported $1.1934/267s, true $1.56/289s; resend reported $1.5683/313s, true
$2.00/615s — a 12-29% undercount on cost, and on resend the reported duration is *half* the true one.
Left unfixed here — out of this task's scope (spec + `scripts/sweep.ts` only) — and flagged for a
follow-up task: move the `usd`/`seconds` capture to after the linking phase, or drop the pre-linking
snapshot and read `spans` directly the way this validation's `scripts/sweep.ts` change now does.

### Verdict

All nine checks pass on all three full runs, with plenty of margin rather than scraping the bar: the
plain family found 5 of 5 illustrative vendors on brightdata, not merely 3; debranded contributed
184-406 hosts per run that plain never touched; the agent-demand lens fired precisely where it should
(brightdata's Discover/SERP/Scraper products, and unprompted on resend) and nowhere it shouldn't
(zero on grundfos, holding even against industrial-protocol queries that could plausibly have been
misread as "agent" queries); and every decomposed product funded a strip and an opening hand on every
run — the old per-product funding contest is verifiably gone. What's weak is process, not doctrine:
the CLI script itself was silently defeating the redesign it exists to validate until this pass fixed
it, and the pipeline's own cost/duration self-report is measurably wrong by a margin (12-29%) large
enough to mislead anyone reading it to decide whether a run is affordable.
