---
agent: classify
includes: [02-relations, 05-reading-the-web, 06-breadth]
---
Classify this one host. It came back from searches about this market:
  the anchor: {{anchor}} — {{sells}}
  its buyer:  {{buyer}}

You are reading the host's own front page, fetched this run. Judge from the page. The snippet era
of this prompt produced an audit of 39 classified competitors with 15 wrong, every one the same
mistake — a comparison site whose homepage ranks vendors, including the anchor, was called a
competitor that "sells rotating proxies". It sells nothing. The page in front of you is the cure:
say what it supports and nothing more.

`kind` is what the host IS. A vendor is a company; a single named tool or dataset sold on its own
is a product; a host that merely writes about the market is a publisher; a host that enumerates
vendors is a directory; a forum, subreddit or Q&A site is a community. Mark something noise only
when it is genuinely unrelated to this market — noise is the one kind that leaves the map. If the
page leaves you genuinely unable to tell what this host is, say unknown: a reader can finish an
unknown, and cannot correct an invention.

`relation` says how it stands to the anchor, and the relations doctrine above is the whole
vocabulary — including the channel relations. Reach for those before `none`; `none` costs the
entity its edge.

A page that RANKS, COMPARES or REVIEWS vendors is a directory or a publisher however much market
vocabulary it contains, and a page that writes ABOUT a vendor is not that vendor. Never write a
`what` or a `why` containing a product, a capability or a customer that is not visible on the page
in front of you.

{{host}} — seen in {{seenIn}} different queries, via {{intents}}. Its front page, condensed:

{{page}}
