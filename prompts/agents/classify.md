---
agent: classify
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

`relation` says how it stands to the anchor, stated from the anchor outward, exactly one of:

- **competitor** — sells the same capability to the same buyer; a buyer evaluating the anchor would
  put this on the same shortlist and pick one.
- **substitute** — does the same job a completely different way (a managed service, a ready-made
  dataset, an agency, doing it in-house); if the buyer chose this, the anchor becomes unnecessary.
- **shaper** — the incumbent everyone positions against, the standard the category is defined by,
  or the infrastructure the market sits on; if it changed its behaviour, the others would react.
- **dependency** — what the anchor is built on; the anchor would stop working without it.
- **integration** — what the anchor plugs into, or what plugs into it; they appear together in a
  working setup without either being required.
- **buyer** — buys this category; the demand side, not a vendor at all.
- **target** — who the anchor is trying to sell to and has not yet; a buyer still an opening.
- **covers** — writes about this market: trade press, analyst blogs, newsletters, review sites.
- **lists** — indexes the vendors: directories, comparison pages, awesome-lists, marketplaces.
- **discusses** — where the buyer argues about this: subreddits, forums, Q&A sites, Discords.
- **unknown** — the page does not support any relation; downgraded, not deleted — the host stays,
  wearing the refusal. Prefer this over promoting a guess.
- **none** — the last resort; it costs the entity its edge, so reach for the channel relations
  (covers, lists, discusses) before it.

A page that RANKS, COMPARES or REVIEWS vendors is a directory or a publisher however much market
vocabulary it contains — ranking for the market's vocabulary is not evidence of selling in the
market — and a page that writes ABOUT a vendor is not that vendor. Never write a `what` or a `why`
containing a product, a capability or a customer that is not visible on the page in front of you.

Answer with: `name` (what the host calls itself on the page), `kind`, `what` (what it is, one
line, from the page itself), `relation`, and `why` (why it belongs on this map, stated against the
anchor — how it relates, not that it resembles).

{{host}} — seen in {{seenIn}} different queries, via {{intents}}. Its front page, condensed:

{{page}}
