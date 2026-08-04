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

Three, in a `.env` at the repo root:

| Variable | What it is |
|---|---|
| `BRIGHTDATA_API_TOKEN` | Bright Data account API token |
| `BRIGHTDATA_SERP_ZONE` | name of a **SERP API** zone |
| `BRIGHTDATA_UNLOCKER_ZONE` | name of a **Web Unlocker** zone |
| `OPENROUTER_API_KEY` | LLM key. Note the *key's own* limit, not just the account balance |

`references/onboarding.md` covers getting these from zero.

## Step 2 — Depth

The query count is the only lever, and it is a floor rather than a budget: the planner queues more
while the run is going, at whatever it judges thin. Roughly:

| queries | entities | cost | time |
|---|---|---|---|
| 10 | ~90 | ~$0.40 | ~5 min |
| 18 | ~160 | ~$0.70 | ~3 min |
| 40 | ~640 | ~$2.00 | ~11 min |
| 80 | ~690 | ~$2.30 | ~12 min |

Measured on `brightdata.com` and `resend.com`. Note 40 and 80 land close: past a point the planner
stops because new queries are buying corroboration.

**Say the cost before spending it.** These are real dollars.

## Step 3 — Run it

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
pnpm read <domain>              # the summary
pnpm read <domain> --entities   # every entity by relation
pnpm read <domain> --edges      # how entities relate to each other
pnpm read <domain> --json       # for a machine
```

Report what it found, not that it ran. Name the head of the market, say which markets got covered
and which did not, and quote two or three `why` lines so the reader can judge the reasoning.

## How much to trust it

This is measured, and you should pass it on rather than presenting the map as fact.

An audit fetched **207 entities from a real map and checked them against the live web: 86 right,
121 wrong.**

What is reliable:

- **The head of the market.** Every genuine competitor was present and correctly labelled. A reader
  taking the top of the competitor list is on solid ground.
- **Counts by relation and kind**, as a shape.

What is not:

- **The long tail of `competitor`.** The classifier reads a hostname, three titles and a snippet, so
  it promotes anything ranking for the market's vocabulary. A comparison site that *ranked the
  anchor first* was recorded as a rival selling proxies.
- **`what` and `why` on obscure hosts.** One entity's entire description was invented from its TLD.
- **The total count.** Inflated by the above.

So: quote the head of the map confidently, treat the tail as leads to check, and never repeat a
`why` line about an unfamiliar host as though it were established.

## The other surface

There is a web app for watching a run live — the stage rail, every query and its results, the cost
ticking up, and the finished map as a graph.

```bash
cd packages/web && pnpm dev      # then open localhost:3210
```

Use it when someone wants to *see* the reasoning rather than read a summary. The CLI is better for
producing an answer.

## References

- `references/onboarding.md` — getting the four credentials from zero
- `references/reading-a-map.md` — what each relation means and how to act on it
- `references/troubleshooting.md` — what the failures look like and what they mean
