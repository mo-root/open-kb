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
| `OPENKB_MODEL` | `google/gemini-3.5-flash` | any OpenRouter model id |
| `OPENKB_PAGES` | `4` | result pages read per query |

`OPENKB_PAGES` is the quiet lever on breadth. One query read to five pages returned 37 distinct
hosts against 7 from the first page alone, and a page costs exactly what a query costs — so depth on
a good query beats breadth onto a worse one. Lower it to 1 or 2 when you want a cheap look.

## Checking it works

```bash
pnpm sweep resend.com 3
```

Three queries, about a minute, well under a dollar. If it prints a `sells:` line and a host count,
everything resolves.
