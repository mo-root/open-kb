---
agent: classify
includes: [02-relations, 06-breadth]
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

One entry per host. `seenIn` is how many different queries surfaced it, and `intents` is what kinds
of question found it — use both as evidence, not as a verdict.

{{hosts}}
