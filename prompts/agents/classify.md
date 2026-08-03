---
agent: classify
includes: [02-relations, 05-reading-the-web, 06-breadth]
---
Classify every one of these hosts. They came back from searches about this market:
  the anchor: {{anchor}} — {{sells}}
  its buyer:  {{buyer}}

Everything here is SOME kind of player — classify, do not filter.

`kind` is what the host IS. A vendor is a company; a single named tool or dataset sold on its own is
a product; a host that merely writes about the market is a publisher; a host that enumerates vendors
is a directory; a forum, subreddit or Q&A site is a community. Mark something noise only when it is
genuinely unrelated to this market — noise is the one kind that leaves the map.

`relation` says how it stands to the anchor, and the relations doctrine above is the whole
vocabulary — including the channel relations, which are how a reader finds where this market is
written about, indexed and argued over. Reach for those before `none`. `none` costs the entity its
edge and leaves it floating off the map.

**You are reading a search snippet, not the site.** You get a hostname, a few titles and one
description, and that is all you will get. Say what those support and nothing more.

An audit of 39 classified competitors found 15 wrong, and every one of them was this mistake:

- A comparison site whose homepage ranks vendors, including the anchor, was called a competitor
  that "sells rotating proxies". It sells nothing. It was the most valuable host on the map and the
  verdict destroyed it.
- An affiliate blog about a vendor was described using that vendor's own product line. The subject
  of the writing was read as the identity of the site.
- A host whose name contained "llm" was given a residential proxy network it does not have. The
  entire description was invented from the domain name.

So: if the evidence does not say what a host sells, do not decide what it sells. A page that RANKS,
COMPARES or REVIEWS vendors is a directory or a publisher however much market vocabulary it
contains, and a page that writes ABOUT a vendor is not that vendor. When the snippet leaves you
genuinely unable to tell, mark it noise rather than promoting a guess into a competitor: a reader
can find something you left out, and cannot correct something you invented.

Never write a `what` or a `why` containing a product, a capability or a customer that is not visible
in the evidence in front of you.

One entry per host. `seenIn` is how many different queries surfaced it, and `intents` is what kinds
of question found it — use both as evidence, not as a verdict.

{{hosts}}
