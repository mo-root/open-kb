# Onboarding: the four credentials

From zero. Read this rather than paraphrasing it; the zone types matter and picking the wrong one
fails at the first search with an error that does not say so.

## Bright Data

One account, two zones. Both are needed and they are different products.

1. Sign up at [brightdata.com](https://brightdata.com).
2. **Settings → API keys → Add** gives `BRIGHTDATA_API_TOKEN`. Copy it once; it is not shown again.
3. **Proxies & Scraping → Add** a **SERP API** zone. Its name is `BRIGHTDATA_SERP_ZONE`. This is
   what buys search results, and it is the bulk of the run's requests.
4. Add a second zone of type **Web Unlocker**. Its name is `BRIGHTDATA_UNLOCKER_ZONE`. This is only
   used when a company's own site refuses an anonymous fetch, which is common enough to matter and
   rare enough not to dominate the bill.

A zone name is a plain string like `serp_api1`, not a URL and not the zone's ID.

**The two are not interchangeable.** A SERP zone pointed at an arbitrary URL returns nothing useful,
and an Unlocker zone pointed at a search engine is billed at the higher rate.

## OpenRouter

1. Sign up at [openrouter.ai](https://openrouter.ai) and add credit.
2. **Keys → Create** gives `OPENROUTER_API_KEY`.

**Set the key's own limit deliberately, or leave it unset.** A key carries a spend cap that is
separate from the account balance, and the cap is what runs hit first. A key capped at $20 on an
account holding $100 will refuse a two-cent call once it has spent $20, with a 402 that says
"requires more credits" — which reads as an empty account and is not one.

To check which one you are actually against:

```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

`limit` and `usage` are the key's. `limit_source: openrouter_key_limit` in an error means the cap,
not the balance.

## Putting them somewhere

A `.env` at the repo root:

```
BRIGHTDATA_API_TOKEN=...
BRIGHTDATA_SERP_ZONE=serp_api1
BRIGHTDATA_UNLOCKER_ZONE=unlocker1
OPENROUTER_API_KEY=sk-or-v1-...
```

Real environment variables win over the file, which is what you want for anything scripted.

## Optional

| Variable | Default | What it does |
|---|---|---|
| `OPENKB_MODEL` | `deepseek/deepseek-v4-flash-0731` | any OpenRouter model id |
| `OPENKB_PAGES` | unset — `2`, promoted to `4` per product on real page-2 yield | result pages read per query |
| `OPENKB_TRIAGE` | on (`0` disables) | skip hosts from search metadata, before a fetch is spent |
| `OPENKB_SECOND_LOOK` | on (`0` disables) | re-ask classify against a deeper page for `unknown` hosts |
| `OPENKB_DROP_CONFIRM` | off (`1` enables) | one more batched opinion on every settled `none` |
| `OPENKB_LISTICLE_HARVEST` | on (`0` disables) | mine the vendor names a roundup already printed |

`OPENKB_MODEL` is worth leaving alone. The bake-off ran five configs over one company: the DeepSeek
flash row returned 449 entities for $0.29, where `google/gemini-3.5-flash` returned 315 for $1.93. A
big model is not the upgrade it looks like here, and the run cap is sized for the cheap one.

`OPENKB_PAGES` is the quiet lever on breadth. One query read to five pages returned 37 distinct
hosts against 7 from the first page alone, and a page costs exactly what a query costs — so depth on
a good query beats breadth onto a worse one. Lower it to 1 or 2 when you want a cheap look — and
leave it unset for the normal case: that is what unlocks variable depth, the engine opening every
query at two pages and letting the widening judge promote a product to four on real page-2 yield.
The deep depth is floored at the shallow one, so *setting* `OPENKB_PAGES` (to `4`, say) collapses the
pair and reads four pages everywhere, leaving that promotion nothing to buy — exactly what the CLI's
own default did until `d740379` (2026-08-22) unset it. Both the CLI and the web route now leave
`pages` unset by default, so both get the real 2→4 behaviour.

Three of the four stage flags are on by default and each is turned off with `0`; `drop-confirm` is
the odd one out, off by default and turned on with `1` (it rarely changes anything — see the table
above). Each adds a model stage, each fails open, and each reports its own counters. On the newest
stored run, triage skipped 123 of 926 hosts before any fetch, second-look asked 22 and rescued 13,
and drop-confirm confirmed all 27 of the drops it was given.

## Checking it works

```bash
pnpm sweep resend.com 3
```

Three queries, about a minute, well under a dollar. If it prints a `sells:` line and a host count,
everything resolves.
