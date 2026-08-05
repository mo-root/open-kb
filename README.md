# open-kb

Domain in, market map out. open-kb strips every product a company sells of its
brand language and searches for what it **does** — the map that comes back
shows who else does it, and every node and edge carries a source URL and a
plain-language reason you can click and check.

Point it at `stripe.com` and it does not look up "Stripe competitors." It reads
Stripe's own pages, works out that one of the things sold is *card-fraud
scoring on the authorization path*, and searches for that. The companies that
answer a de-branded query are competitors by evidence, not by reputation — 
including the ones no comparison article has ever listed.

## How a run works

1. **Understand.** The engine reads the company's own site — sitemap, nav,
   product pages — and writes down what it sells, who buys it, and which words
   are invented brand names that a search must never contain.

2. **Strip and deal.** Every product is stripped to the terms a buyer would
   actually type (`Web Scraper API` → `web scraper`), and dealt a hand of
   queries across three families:

   | family | example | what it finds |
   |---|---|---|
   | **plain** | `web scraper`, `web scraper alternatives` | the head-to-head field — who competes directly |
   | **debranded** | `extract data from site that blocks bots` | substitutes solving the job a different way |
   | **branded** | `Web Scraper API vs`, `<company> competitors` | the comparison ecosystem around the name |

   The plain and branded families are code-generated templates — no model can
   have a clever day and skip the boring query that finds the center of a
   market. The debranded family is model-written, because that is where
   judgement pays.

3. **Widen.** After each round an agent reads what came back — per product,
   per family — and decides: release more held queries where a door is paying,
   switch doors where results repeat, stop when new queries only corroborate.
   No fixed wave count, no query quota. The brake is a dollar ceiling.

4. **Map.** Every host that answered is fetched, classified from its own page
   (not from a search snippet), and hung on the market whose search surfaced
   it. Entities link to each other where pages name each other. The result is
   clusters around markets, not a star around the company.

## Receipts, or it does not exist

- A claim carries a **literal quote from a page this run fetched**, minted
  through one code path — there is no way to attach evidence that was not
  actually retrieved.
- Every entity records **which product's search found it, through which
  family** — the graph is born attributed.
- Every model call, SERP query and page fetch is **billed to the run as it
  happens**; the UI shows the meter live, and the report states what the run
  actually cost.
- The company's own catalog links to the pages that establish it. Nothing on
  the map is unclickable.

## Quickstart

Requirements: Node 20+, pnpm, an [OpenRouter](https://openrouter.ai) key, and
a [Bright Data](https://brightdata.com) account with a SERP zone and a Web
Unlocker zone.

```bash
pnpm install
cp .env.example .env        # fill in the required block
pnpm test                   # 220 tests, no network needed

# a full map from the CLI
pnpm sweep stripe.com

# or the web app
cd packages/web && pnpm dev # → http://localhost:3210
```

The web app streams the run as it happens — the plan, every search with its
family, every dollar — and navigates to the finished map on completion.

## Architecture

```
packages/core        pure logic: evidence mint, query families, canonical urls,
                     content sniffing, span accounting. No env, no vendor
                     names, no HTTP — enforced by a purity gate in CI.
packages/providers   Bright Data SERP + unlocker clients (zone rotation,
                     rate-aware pacing), OpenRouter wiring.
packages/sweep       the engine: understand → strip → deal → fire → widen →
                     classify → link → report.
packages/web         Next.js app: live run surface + the map.
prompts/             every judgement the models make, as editable markdown.
                     Doctrine files are shared across agents; changing how the
                     engine thinks is a text edit, not a rebuild.
scripts/             CLI entry points (sweep, discover, read).
skills/              a Claude skill that drives open-kb conversationally.
```

The split that matters: **guarantees are code, judgements are prompts.** The
evidence mint, the query templates, the anchor-name filter and the billing are
code — they hold no matter what a model does. What to read next, what a host
is, whether a market is exhausted — those are model calls, and every one of
them is a prompt file you can read and edit.

## Deploy

See [DEPLOY.md](DEPLOY.md) — a Dockerfile for a long-running host, basic auth,
and a spend ceiling read from the environment.

## License

[MIT](LICENSE)
