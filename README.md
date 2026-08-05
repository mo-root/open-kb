<div align="center">

# open-kb

**The open-source market mapper.**
Give it a domain, get back a cited map of the ecosystem around it — competitors, substitutes, communities, and the receipts on every claim. Powered by an agent sweep wired into Bright Data's web infrastructure.

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-4B8BFF?style=flat-square&labelColor=0a1628)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-4B8BFF?style=flat-square&labelColor=0a1628)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-4B8BFF?style=flat-square&labelColor=0a1628)](https://nextjs.org)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-7-4B8BFF?style=flat-square&labelColor=0a1628)](https://sdk.vercel.ai)
[![Bright Data](https://img.shields.io/badge/Powered%20by-Bright%20Data-22D3EE?style=flat-square&labelColor=0a1628)](https://brightdata.com)

</div>

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

<div align="center">

> ### **▶ Demo**

<img src="./assets/demo.gif" alt="open-kb in action: a domain goes in, the run streams live, the cited map comes out" width="100%" />

<sub>4× speed — [**watch the full demo with audio**](./assets/demo.mp4) (1m26s)</sub>

</div>

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## The idea

If you search **"Stripe competitors"**, you get the articles everyone already read. open-kb never searches the company's name to find its market. Instead it:

1. **Reads the company's own site** and lists everything it sells
2. **Strips each product of its brand** — `Web Scraper API` becomes `web scraper`
3. **Searches for the job, not the name** — and the companies that answer are competitors by evidence, not by reputation

That includes the ones no comparison article has ever listed: the open-source tool people outgrow, the substitute solving the same problem a completely different way, the new player with no press.

<img src="./assets/map.png" alt="The map for brightdata.com — 490 entities, 210 players, 69 queries fanned into 553 hosts. The focused cluster is one market: web scraping apis." width="100%" />

<sub>One run on `brightdata.com`: **490 entities · 210 players · 69 queries → 553 hosts**. The lit cluster is a single market — *web scraping apis* — and every node on it was found by that market's searches, wears its own favicon, and carries its citations.</sub>

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Why this exists

| | Market-intel vendors | Asking an LLM | **open-kb** |
|---|---|---|---|
| **Where answers come from** | curated databases | model memory | live searches, this run |
| **Finds substitutes & long tail** | rarely | sometimes, unverifiable | yes — that's the method |
| **Citation on every claim** | rare | no | every node and edge: URL + quote |
| **Cost per map** | contracts | free but uncheckable | a few dollars, metered live |
| **Self-hosted** | no | — | yes |

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## How it works

One domain becomes one run. Agents make the judgement calls; code enforces the guarantees.

```mermaid
flowchart LR
    A[domain] --> B[**understand**<br/>read the company's own site<br/>list every product]
    B --> C[**strip & deal**<br/>each product gets queries<br/>in three families]
    C --> D[**fire**<br/>SERP worker pool<br/>every hit tagged]
    D --> E{**widen?**<br/>agent reads the yield}
    E -- "a door is paying" --> D
    E -- "enough" --> F[**classify**<br/>fetch each host's page<br/>judge from the page itself]
    F --> G[**link**<br/>pages that name each other<br/>become edges]
    G --> H[the map]
```

### The three query families

Every product's queries are dealt across three families, because each one opens a different door into the same market:

```mermaid
flowchart TD
    P["Web Scraper API<br/>(one product)"] --> PL["**plain** · code templates<br/><code>web scraper</code> · <code>web scraper alternatives</code><br/>→ the head-to-head field"]
    P --> DB["**debranded** · model-written<br/><code>extract data from site that blocks bots</code><br/>→ substitutes nobody lists"]
    P --> BR["**branded** · code templates<br/><code>Web Scraper API vs</code> · <code>company competitors</code><br/>→ the comparison ecosystem"]
```

The boring families are **code** — no model can have a clever day and skip the query that finds the center of a market. The clever family is **model-written**, because that's where judgement pays. Every entity on the map records which product's search found it, through which door.

<!-- Screenshot: searches panel with family chips — assets/families.png -->

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## The agents

Every agent in open-kb is the same three things: **a markdown prompt** (its beliefs, editable in [`prompts/`](./prompts)), **a Zod schema** (its output type — the model cannot return prose), and **a metered call** (its tokens and dollars land on the run's bill as it happens). No framework, no graph library — the orchestration is plain TypeScript you can read in one file.

| agent | fires | what it judges |
|---|---|---|
| **understand** | once | reads the company's own pages: what it sells, every product, which products share a market, which words are invented brand names |
| **catalog** | once **per product**, 6 in parallel | strips the product to the terms a buyer would type, judges whether its name is too generic to search, writes that product's debranded queries |
| **assess** | between rounds | the widening judge — reads what every family returned for every product, and decides: release held queries where a door is paying, switch doors where results repeat, or say *enough* |
| **classify** | per batch of hosts, 6 batches in flight | fetches each host's actual page and judges what it is and how it relates to the anchor — from the page, never from a search snippet |
| **link** | once | where two entities' pages name each other, judges what the relationship is |
| **discover** | standalone (`pnpm discover`) | a tool-loop investigator: maps a site's product pages, reads the ones it chooses, follows leads, submits products one by one, decides itself when the catalogue is complete |

How they compose into one run:

```mermaid
flowchart TD
    U["**understand**<br/>one call, reads the site"] --> C1["**catalog** · product 1"]
    U --> C2["**catalog** · product 2"]
    U --> C3["**catalog** · product N<br/><i>6 in parallel</i>"]
    C1 & C2 & C3 --> Q["query queue<br/><i>refilled while it drains</i>"]
    Q --> W["SERP worker pool"]
    W --> A{"**assess**<br/>the widening judge"}
    A -- "release reserve /<br/>write new queries" --> Q
    A -- "enough" --> K["**classify** · 6 batches in flight"]
    K --> L["**link**"] --> M["the map"]
```

### What the agents decide — and what they can't

The design rule the whole engine is built on: **agentic where the answer is a judgement, code where the answer is a guarantee.**

Agents decide: what a company really sells, what to type next after seeing what came back, whether a market is exhausted, what a host actually is once its page is fetched.

Agents **cannot**: mint evidence for a page that was never fetched (one code path owns that, and it verifies the quote), skip the plain query family (templates fire regardless), search the company's own name outside the branded family (a code filter drops the query), or spend past the dollar ceiling (the harness refuses the run).

So a model having a bad day can write a weak query or misjudge a host — it cannot fabricate a citation, blind a market, or run up a bill. The failure modes are bounded by construction, not by hoping the prompt was good enough.

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Receipts, or it doesn't exist

The trust layer, enforced in code:

- **Every claim carries a literal quote from a page this run fetched.** There is one code path that mints evidence, and it refuses quotes that weren't actually retrieved.
- **Every dollar is billed live.** Each model call, SERP query and page fetch lands on the run's meter as it happens — you watch the bill during the run, and the report states what it truly cost.
- **Every entity knows its origin.** Which product's search surfaced it, which query family, which market it hangs on.
- **The company's own catalog links to the pages that establish it.** Nothing on the map is unclickable.

<!-- Screenshot: an entity with its citations — assets/receipts.png -->

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Quick start

You'll need a [Bright Data](https://brightdata.com) account with two zones (**SERP API** and **Web Unlocker**), plus an [OpenRouter](https://openrouter.ai) key for the LLM layer.

```bash
# 1. Clone and install
git clone https://github.com/mo-root/open-kb.git
cd open-kb
pnpm install

# 2. Configure
cp .env.example .env
# fill in:
#   OPENROUTER_API_KEY
#   BRIGHTDATA_API_TOKEN
#   BRIGHTDATA_SERP_ZONE
#   BRIGHTDATA_UNLOCKER_ZONE

# 3. Run the web app
cd packages/web && pnpm dev
# open http://localhost:3210 — type a domain, watch the run, get the map
```

### Or skip the UI

```bash
pnpm sweep stripe.com        # full map from the CLI
pnpm discover stripe.com     # just phase one: what does this company sell?
pnpm test                    # 220 tests, no network, no keys needed
```

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Or drive it from your coding agent

open-kb ships an [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) at [`skills/mapping-markets`](./skills/mapping-markets) that teaches Claude Code and other agents how to run maps, read them, and tune the query doctrine.

```bash
npx skills add mo-root/open-kb/skills/mapping-markets
```

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## The judgements are files you can edit

Everything the models are told lives in [`prompts/`](./prompts) as plain markdown — the doctrine for what makes a good query, how to read a page, when a market is exhausted. Changing how the engine thinks is a text edit, not a rebuild.

```
prompts/
├── doctrine/        shared beliefs — search craft, evidence rules, query families
└── agents/          one file per judgement — understand, catalog, assess, classify, link
```

The split that matters: **guarantees are code, judgements are prompts.** The evidence mint, the query templates, the anchor-name filter and the billing hold no matter what a model does.

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Project layout

```
open-kb/
├── packages/
│   ├── core/        pure logic — evidence mint, query families, url canon,
│   │                span accounting. No env, no vendor names, no HTTP.
│   │                A purity gate in CI enforces it.
│   ├── providers/   Bright Data SERP + Unlocker clients (zone rotation,
│   │                rate-aware pacing), OpenRouter wiring.
│   ├── sweep/       the engine — understand → strip → deal → fire →
│   │                widen → classify → link → report.
│   └── web/         Next.js 16 app — live run surface + the map.
│
├── prompts/         every judgement, editable markdown
├── scripts/         CLI entry points (sweep, discover, read)
├── skills/          the Agent Skill
└── tests/           vitest — all offline
```

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Data access | **Bright Data** (SERP API, Web Unlocker) | searches that don't get blocked, pages that actually load |
| LLM layer | **OpenRouter** via **AI SDK 7** | model-agnostic; every call typed with **Zod** structured output |
| Web app | **Next.js 16** + **React 19** + **Tailwind v4** | live NDJSON streaming, resumable across reconnects |
| Persistence | **Supabase** (optional) | spans written as they happen — a crashed run stays readable |
| Safety | spend ceiling + span accounting | the app refuses runs past a dollar ceiling you set |

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Roadmap

Shipping today: the family engine, the widening loop, live metering, the cited map, the web app, the Agent Skill.

Next:
- **The full swarm** — the discovery agent (already built and tested standalone) wired in as phase one, pulling the company's corpus itself instead of a single-pass read
- **Run journals** — each run writes what worked; the next run on that market reads it first. The self-evolving substrate.
- Deeper community and channel mapping — where buyers argue, not just who sells

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## Contributing

PRs welcome. Three things worth knowing:

1. **`pnpm check && pnpm test` before pushing.** The check includes a purity gate: `packages/core` may not touch env, vendors, or HTTP.
2. **Guarantees stay code, judgements stay prompts.** A PR that moves one into the other needs a reason.
3. **Numbers, not adjectives.** Changes to the engine should come with a before/after on a real domain.

<br />

<!-- ─────────────────────────────────────────────────────────────────────── -->

## License

MIT. Use it, fork it, ship it.

<br />

<div align="center">

<sub>Built on Bright Data's web infrastructure. The internet is the dataset.</sub>

</div>
