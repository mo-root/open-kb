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

`none` means the classifier kept the host and would not place it. It gets no edge and sits
unconnected.

## Reading it well

**Start with substitutes, not competitors.** The competitor list is the one already known. The
substitutes are what the comparison content cannot surface, which is exactly why nobody has them.

**A map that is all `competitor` is a failed run.** It answered "who competes" when the question was
"what is this market". Check the relation tally first.

**`lists` rows are leads to more map.** A directory naming a hundred vendors is worth more than one
more competitor.

**Read the `why`, not the label.** The label is a bucket; the reason is what a reader can act on or
correct. "Adjacent player in the same space" is worth nothing and means the classifier had nothing.

## Edges between entities

`pnpm read <domain> --edges` shows how the found companies relate to *each other* rather than to the
anchor. Each carries a confidence:

- `measured` — a page that was retrieved put the two together.
- `inferred` — reasoned from what each one does.

Discount the second; do not discount the first.

Pairs are only considered when they came back from **two or more different searches**. One shared
query is what any two pages of a broad search have in common.

## What not to trust

Measured, on a real map: 207 entities checked against the live web, **86 right, 121 wrong**.

The head of the market was entirely correct. The failures were all in the tail and all the same
mistake — the classifier reads a hostname, three titles and a snippet, so anything ranking for the
market's vocabulary becomes a competitor:

- A vendor-comparison site that **ranked the anchor first** was recorded as a rival selling the
  anchor's product category.
- An affiliate blog about a vendor was described using *that vendor's* product line.
- A host whose name contained "llm" was given a product it does not have, invented from the domain.

So when reading a map:

1. Trust the head of the competitor list.
2. Treat unfamiliar hosts as leads to verify, not findings.
3. Never repeat a `why` about a host you do not recognise as though it were established.
4. Expect the total to be inflated.

A one-line check that catches most of it: open the domain. A page that ranks, compares or reviews
vendors is a directory or a publisher, however much market vocabulary it contains.
