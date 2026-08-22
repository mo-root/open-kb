---
name: mapping-markets
description: Map the market around any company from its domain alone — competitors, substitutes, the infrastructure it sits on, the directories that list it, the publications that cover it and the communities its buyers argue in — with a source and a reason on every entry. Use this skill whenever someone wants a competitive landscape, a market map, a list of alternatives to a product, "who else does this", "who are we up against", a view of an ecosystem or category, where a market's buyers hang out, which publications cover a space, or a target list to sell into. Also covers reading a finished map and judging how much of it to trust.
---

# Mapping a market from one domain

You give it `stripe.com`. It reads Stripe's own pages to work out what Stripe sells, groups those
products into the distinct markets they sit in, writes search queries that describe those markets
without ever naming Stripe, fires them, and classifies every host that comes back.

The output is a map: companies, products, communities, publishers and directories, each with what it
is, how it relates to the anchor, and why.

## When you reach for this

Someone has a company and wants the shape of the world around it. "Who competes with us." "What are
the alternatives to X." "Where do our buyers actually hang out." "Who writes about this space." "Give
me a target list." Also when they have a company they are evaluating and want its landscape rather
than its pitch.

Not for researching a single company in depth — this maps outward from one, it does not profile it.

## The one idea

**The catalog is written before any company name is known.** The queries describe what the anchor
*does*, never what it is called, so a look-up query is structurally impossible to write. That is why
the map contains companies nobody had heard of rather than the five names already on the first page
of Google.

The corollary matters when you read the output: a competitor here is something the *search* put
next to the anchor, not something a human already knew about.

## The shape of the work

```
Market map progress:
- [ ] 1. Credentials resolve
- [ ] 2. Agree the depth, because depth is the bill
- [ ] 3. Run it, watching the phase log
- [ ] 4. Read the map back and say what it found
- [ ] 5. Say plainly which parts to trust
```

Do not skip 5. See "How much to trust it" below — it is measured, not a disclaimer.

## Step 1 — Credentials

Four, in a `.env` at the repo root:

| Variable | What it is |
|---|---|
| `BRIGHTDATA_API_TOKEN` | Bright Data account API token |
| `BRIGHTDATA_SERP_ZONE` | name of a **SERP API** zone |
| `BRIGHTDATA_UNLOCKER_ZONE` | name of a **Web Unlocker** zone |
| `OPENROUTER_API_KEY` | LLM key. Note the *key's own* limit, not just the account balance |

`references/onboarding.md` covers getting these from zero.

## Step 2 — Depth

The query count is the main lever, and it is a floor rather than a budget: the planner queues more
while the run is going, at whatever it judges thin. So the argument sets where a run opens, and the
table below is keyed on what actually fired:

| queries fired | entities found | cost | wall |
|---|---|---|---|
| 36 | 456 | $0.40 | 6 min |
| 66 | 926 | $0.71 | 29 min |
| 106 | 1,440 | $0.96 | 13 min |
| 192 | 1,705 | $2.24 | 14 min |

Found, not kept — the judge keeps 74–84% of those across the same runs. Measured on the stored runs
in `runs/` (resend.com, cursor.com, stripe.com, brightdata.com); a least-squares fit over all 17 of
them puts it at `usd ≈ 0.026 + 0.0098 × queries fired`. Wall clock is set by SERP pacing rather than
query count and scatters badly — 190 queries took 55 minutes on one run and 192 took 14 on another —
so quote the cost confidently and the time loosely.

For the small end: a 10-query probe on `clerk.com` returned 449 entities for $0.29 in 229 seconds.

**Say the cost before spending it.** These are real dollars.

The other levers, all optional and all documented in `references/onboarding.md`: `OPENKB_PAGES`
(result pages per query), `OPENKB_MIN_WAVES`, `OPENKB_MAX_HOSTS`, and four stage flags — `OPENKB_TRIAGE`,
`OPENKB_SECOND_LOOK`, `OPENKB_LISTICLE_HARVEST` (all three on by default, `0` disables) and
`OPENKB_DROP_CONFIRM` (off by default, `1` enables).

## Step 3 — Run it

The tool lives wherever open-kb is cloned (github.com/mo-root/open-kb); every command runs from that repo root.

```bash
pnpm sweep <domain> <queries>
```

It streams a phase log. Watch for these, because each one is a real signal:

- `N products → M distinct markets` — if M is 1 for a company you know sells several things, the
  grouping collapsed and the map will cover one market.
- `no queries for N of M core markets` — those markets' competitors cannot appear. This is the
  single most useful line in the log.
- `round N added only K` — the planner stopping because yield fell off. Healthy.
- `condensed to N` — a large page folded to its section list. Expected on big sites.

## Step 4 — Read it back

```bash
cd <path-to-open-kb>
pnpm read <domain>              # the summary
pnpm read <domain> --entities   # every entity by relation
pnpm read <domain> --edges      # how entities relate to each other
pnpm read <domain> --json       # for a machine
```

Report what it found, not that it ran. Name the head of the market, say which markets got covered
and which did not, and quote two or three `why` lines so the reader can judge the reasoning.

## How much to trust it

This is measured, and you should pass the measurement on rather than presenting the map as fact.

Two engines, two numbers:

- **The old classifier** judged from a hostname, three titles and a snippet. An audit checked 207 of
  its entities against the live web: **86 right, 121 wrong**. That number is why the engine was
  rebuilt.
- **The rebuilt engine** judges every host from its own fetched page, and every quote is verified as
  a literal substring of a page the run actually retrieved. A 30-entity spot audit measured **1
  wrong — 3.3%, which at n=30 honestly means 0.6%–16.7%** (the Wilson interval; never quote the
  rate without it). One caveat on that audit: its second reviewer only re-read verdicts marked
  "wrong" — a correction that can only lower the rate — which is exactly why the audit is now a
  repeatable instrument instead of a story.

Do not inherit either number. Deal a packet on the map in front of you:

```bash
pnpm run audit runs/<run>.json            # deals a seeded, fillable review packet
pnpm run audit --score <packet>.json      # refuses to score unless reviewed symmetrically
```

What is reliable by construction:

- **The head of the market.** Genuine competitors present, correctly labelled, with receipts.
- **Quotes.** One code path mints evidence and it refuses quotes that weren't actually fetched — a
  citation cannot be invented, only misjudged.
- **Refusals.** An entity the engine could not convict lands as `unknown` with the refusal reason
  attached. It downgrades rather than deletes, so the map shows you what it declined to believe.

What still deserves suspicion:

- **The `unknown` pile is unfinished work, not noise.** Real competitors sit in it when their page
  refused to load or the evidence bar was not met. Treat it as the lead list.
- **Absence.** The widening judge decides when a market is exhausted; check the per-market counts
  before treating "nobody else sells X" as a finding.
- **A `why` line on an unfamiliar host is a lead, not a fact** — click the receipt before repeating
  it.

## The other surface

There is a web app for watching a run live — the stage rail, every query and its results, the cost
ticking up, and the finished map as a graph.

```bash
cd packages/web && pnpm dev    # then open localhost:3210
```

It shows the stage rail, every query and what it returned, the cost ticking up, and the finished map
as a graph with an entity browser.

**Do not rebuild this as an artifact.** A hand-made summary page is a worse copy of something that
already exists and is already wired to the real data. Run the server and give the reader a link:
`localhost:3210/kb` for the gallery, or `localhost:3210/kb/<slug>` for one map. Use the CLI when the
answer is what is wanted, and the browser when the reasoning is.

## References

- `references/onboarding.md` — getting the four credentials from zero
- `references/reading-a-map.md` — what each relation means and how to act on it
- `references/troubleshooting.md` — what the failures look like and what they mean
