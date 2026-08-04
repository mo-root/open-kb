# Troubleshooting

Every entry here is a failure that actually happened, with what it turned out to mean.

## It stops immediately

**`<domain> does not resolve — there is no such domain. Did you mean <x>?`**

A typo. The check is a DNS lookup, so this is settled rather than unlucky — retrying costs a fetch,
an unlocker call and a reader's confidence. `brightdata.ccom` cost exactly that before the check
existed.

**`not configured: BRIGHTDATA_SERP_ZONE, ...`**

Checked before a run starts, because a missing key otherwise surfaces as a failed model call after
the search money is already spent.

**`could not read <domain>. Tried ... directly (twice, two seconds apart) and once through the
unlocker`**

Three surfaces failed. Usually a genuine block; occasionally a network blip, which is why it retries
two seconds apart before spending on the unlocker. Worth running again once.

## It dies partway

**`402 ... This request requires more credits, or fewer max_tokens. You requested up to N tokens,
but can only afford M`**

Almost always the **key's own cap**, not the account balance. `limit_source: openrouter_key_limit`
in the error body says so outright. Check with:

```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

If `limit - usage` is near zero while the account has credit, raise the key's limit at
openrouter.ai/settings/keys. Nothing to buy.

**`BodyTimeoutError` on a model call**

The model was still thinking when the connection gave up. On models where reasoning is mandatory it
is spent from the same output budget as the answer, so too small a `maxOutputTokens` starves the
answer and the call hangs producing nothing.

**`Reasoning is mandatory for this endpoint and cannot be disabled.`**

Some models refuse `reasoning: { enabled: false }`. The floor is `effort: minimal`.

**A run stops and everything is gone**

Runs are written on completion. If Supabase is configured, spans land as the run goes and a dead run
is still readable; without it, a run that dies has bought everything and kept nothing. See
`scripts/supabase-schema.sql`.

## It ran, but the map is wrong

**One market, when the company sells several**

Look for `N products → M distinct markets` in the log. If M is 1, the grouping collapsed and only
one market was searched. The grouping test is "would these have different competitors", so a company
whose products genuinely share a competitor set will correctly show few.

**`no queries for N of M core markets`**

Those markets' competitors could not appear — nothing asked. Either raise the query count or accept
a partial map, but say which markets were missed.

**Mostly `competitor` and little else**

A shortlist, not a market. Usually means the queries described the category rather than the job. The
substitute-finding queries are the ones phrased as an outcome.

**Lots of hosts, all noise**

Check the `sells` line at the top of the log. Everything descends from that sentence, so a vague or
wrong reading of the company produces a confident map of the wrong market. Read it before reading
the entities.

**A small run spent its budget on a side product**

Capabilities are marked `core` or `adjacent` and core is covered first. A run that mapped an
integration instead of the main product usually has that integration marked core — visible in
`pnpm read <domain>`.

## It ran, but slowly

Look at the phase log's timestamps rather than the total.

- **Search dominating** is normal. It is the actual work, and calls run 20 at a time with a 30s cap
  on any one page.
- **Classification dominating** means many hosts. It scales with hosts, not queries.
- **A long gap before the first search** is the catalog, three concurrent calls.
- **Stalls between rounds** should not happen any more; the planner runs alongside the searching.

## Nothing in the browser

**Connection refused on :3210** — the dev server is not running. `cd packages/web && pnpm dev`.

**The page renders but looks broken** — hard-reload. A stylesheet change is cached aggressively.

**A finished run shows a spinner forever** — it is being asked for from memory. Fixed by falling
back to disk; if it recurs, the run id is genuinely unknown.
