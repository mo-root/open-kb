---
doctrine: 04-search-craft
---
## Describe, do not label

One category term is one question. Several descriptions at several specificities are several
questions, and they reach different pages — measured at roughly twice the distinct vendors, with
almost no overlap. Running several is not repetition.

## What each shape buys

- **The category as a buyer names it** — vendor homepages and category roundups.
- **The job, phrased as an outcome** — reaches substitutes, the companies solving the same problem a
  different way. Nothing else finds them.
- **The buyer's problem at the moment it breaks** — a named tool crossed with a symptom:
  `kafka consumer lag not catching up`, `terraform state lock timeout`. The symptom vocabulary is
  small and reusable in every market: blocked, 403, rate limit, detected, keeps breaking, not
  working, timeout. Reaches forums no category term does, where someone who gave up on the DIY route
  was told what to buy — and those are findings themselves, not only routes to vendors.
- **The technique underneath** — vendors who sell one mechanism. In one market this shape alone
  surfaced two vendors nothing else found.
- **The format delivered** — a feed, a webhook, a dashboard, a dump. Each has its own vendors.
- **Roundup hunting** — "best", "top", "alternatives", "vs". Cheap, and one good roundup names ten
  companies. Better with NAMES in it: `Auth0 vs Okta vs Cognito`. Nobody writes a comparison
  page about a category, so crossing two or three players you know returns the page naming the rest.
  Naming a rival is not naming the anchor; only the anchor and its coinages are barred.
- **Certifications, standards, registries, trade bodies** — in markets without comparison content
  this is the shape that works. It returns *directories* rather than competitors, and a directory
  naming a hundred manufacturers is worth more than one competitor.

## Test a term before you spend on it

Ask: **would a buyer who had never heard of this company type this?**

Three ways a term fails, each with its own signature.

**Too branded.** The results are the company's own properties — which include its open-source
projects, its docs domains and its repos, whose addresses may not contain its name at all. Watch for
coinages that look perfectly generic: a product name with a common noun attached is not a market.
One tested term returned the company to itself while looking like a market.

**Too generic.** Clean of the brand, and still wrong: it names a different market. Nothing looks
like an error — real companies, just not this market's. Ask whether what came back does the anchor's
job.

**Too long.** Every term is ANDed, so each one multiplies the constraint.
`HTTP 403 Forbidden on python requests but works in browser` is a sentence, not a query: it matches
only the pages where someone wrote that sentence, and a market is not in those pages.

Count the words before deciding this applies. That sentence is TEN. `kafka consumer lag timeout` is
FOUR, and a different animal: a named tool, the code it emitted, and what the buyer wants done. The
rule bars the sentence, never the error.

Three to six words, at most one operator, and **at most one quoted phrase**. Quotes demand an exact
string, so a phrase few people write returns the few pages that wrote it: a catalog of twenty
queries came back full of `"cf-challenge-running"` and `"403 Forbidden"`, and returned 1.6 results
per search where seven is normal. Quote only what thousands would write that way.

A query that wants to say two things is two queries. Splitting is free, over-constraining is not.

## Looseness brings publishers

The vaguer the term, the more of your results are people writing *about* the market rather than
being in it. Review sites appeared in every loose query tested and in none of the tight ones. If
listicle farms fill your results, tighten.

## Batch, watch, and follow what pays

One call carries many queries — one turn should buy a whole wave. Then look at what came back and
spend where real players *in this market* are appearing, not where you planned to spend.
