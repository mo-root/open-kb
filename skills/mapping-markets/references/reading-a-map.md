# Reading a map

Every entity carries a **kind** (what it is) and a **relation** (how it stands to the anchor). The
relation is the useful field, and it is read outward from the anchor: `A covers B` means A writes
about B.

## The relations

They split into two groups, and the split is the point.

### Commercial — how it stands to the anchor

| relation | means | what to do with it |
|---|---|---|
| `competitor` | a buyer would shortlist both and pick one | the battlecard list |
| `substitute` | solves the same problem a different way, so never appears in a comparison article | usually the most valuable and the most missed. If a map has none, it mapped a shortlist rather than a market |
| `adjacent` | sells into the same workflow or the same buyer's world, but nobody picks one *instead of* the other — a backup vendor, a support platform, a host | usually the largest group on a map, and the softest: only `competitor` and `substitute` need the host's own readable page, so read this one's `why` before repeating it |
| `shaper` | the incumbent everyone positions against, or the infrastructure the market sits on | if it moved, everyone else would react. Watch it |
| `dependency` | what the anchor is built on | supply risk |
| `integration` | plugs into it, or it plugs in | partnership surface |
| `buyer` | the demand side | who actually pays |
| `target` | a buyer not yet sold to | the opening |

### Channel — where the market is discussed

Not competing is not the same as not relating, and for a go-to-market reader these are often the
most actionable rows on the map.

| relation | means | what to do with it |
|---|---|---|
| `covers` | writes about this market: trade press, analysts, newsletters | the press list |
| `lists` | indexes the vendors: directories, comparison pages, awesome-lists | a shortcut to more of the map. One directory can name a hundred players |
| `discusses` | where the buyer argues: subreddits, forums, Q&A, HN | where to show up |

Two more relations never appear as rows you can act on. `none` is the judge saying the host has no
place here at all, and it is the one verdict that drops a host off the map — a node with no relation
gets no edge. `unknown` is the downgrade for a claim the evidence refused: the host stays, wearing
the refusal, which is why the `unknown` pile is a lead list rather than noise.

## Reading it well

**Start with substitutes, not competitors.** The competitor list is the one already known. The
substitutes are what the comparison content cannot surface, which is exactly why nobody has them.

**A map that is all `competitor` is a failed run.** It answered "who competes" when the question was
"what is this market". Check the relation tally first.

**`lists` rows are leads to more map.** A directory naming a hundred vendors is worth more than one
more competitor.

**`adjacent` will usually be the biggest pile** — 302 of 776 kept entities on the newest stored run.
That is the fix for a classifier that used to force those hosts into `competitor`, not a defect. But
it carries no own-readable-page requirement the way `competitor` and `substitute` do, so it is where
to spot-check first.

**Read the `why`, not the label.** The label is a bucket; the reason is what a reader can act on or
correct. A `why` that restates the label — "adjacent player in the same space" — is the classifier
having nothing; the label `adjacent` itself is a real placement with a real definition above.

## Edges between entities

`pnpm read <domain> --edges` shows how the found companies relate to *each other* rather than to the
anchor. Each carries a confidence:

- `measured` — a page that was retrieved put the two together.
- `inferred` — reasoned from what each one does.

Discount the second; do not discount the first.

Pairs are only considered when they came back from **two or more different searches**. One shared
query is what any two pages of a broad search have in common.

## What not to trust

Two numbers, and the difference between them is the engine, not the market.

- **The old classifier** judged a host from its hostname, three titles and a snippet. An audit
  checked 207 of its entities against the live web: **86 right, 121 wrong**. Every failure was the
  same mistake — anything ranking for the market's vocabulary became a competitor, so a
  vendor-comparison site that ranked the anchor first was recorded as a rival, and an affiliate blog
  was described using the product line of the vendor it wrote about. That number is why the engine
  was rebuilt, and it does not describe any map this tool produces now.
- **The engine that ships** fetches each host's own page and judges from it, and every quote is
  verified as a literal substring of bytes the run stored. A 30-entity spot audit measured **1
  wrong — 3.3%, which at n=30 honestly means 0.6%–16.7%** (the Wilson interval; never quote the rate
  without it).

So when reading a map:

1. Trust the head of the competitor list.
2. Treat unfamiliar hosts as leads to verify, not findings.
3. Never repeat a `why` about a host you do not recognise as though it were established.
4. Treat the `unknown` pile as unfinished work rather than noise — real competitors sit in it when a
   page refused to load.

A one-line check that catches most of what remains: open the domain. A page that ranks, compares or
reviews vendors is a directory or a publisher, however much market vocabulary it contains.
