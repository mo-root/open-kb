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

`kind` is what the host IS. Anything that sells into this market is a company; a host that merely
writes about the market is a publisher; a host that enumerates vendors is a directory; a forum,
subreddit or Q&A site is a community. Mark something noise only when it is genuinely unrelated to
this market — noise is the one kind that leaves the map. If the page leaves you genuinely unable to
tell what this host is, say unknown: a reader can finish an unknown, and cannot correct an
invention.

Ask what the host IS before you ask what its page advertises. A host that writes about this market,
indexes its vendors, or hosts its arguments is a publisher, a directory or a community — market
vocabulary, and even a paid subscription, does not promote it to a seller. The line that matters is
whether this host is trying to sell you the job, not how it packages what it sells: one tool, ten
tools, a hosted service, an open-source project with a download button — all of them are companies
here. Say what it actually sells in `what`, where a quote has to back you.

`relation` places the host on the map, stated from the anchor outward — WHERE it belongs, not
whether it belongs at all. Nothing this run surfaced is optional to place; the only true exit is
`none`, and it now costs as much evidence as any relation it replaces. Exactly one of:

Check in this order, first fit wins. `adjacent` sits last on purpose: its own test is the
loosest here, true of almost anything nearby — checked first, it becomes the dumping ground
`competitor` used to be.

- **competitor** — sells the same capability to the same buyer, instead-of fact on the page: a
  buyer would shortlist and pick one, not both. Shared vocabulary is not that fact.
- **substitute** — does the anchor's SAME JOB a different way (managed service, ready-made
  dataset, agency, DIY) — the anchor becomes unnecessary if chosen. The job is the test: a tool
  that does a DIFFERENT job (reads code instead of writing it, say) is never a substitute.
- **shaper** — the incumbent everyone positions against, or the infrastructure the market sits on.
- **dependency** — what the anchor is built on; it stops working without this.
- **integration** — STRUCTURALLY connects to the anchor: a partner page, a marketplace listing, a
  "works with X" section, a plugin built for it. Sitting nearby without a shown connection is not this.
- **adjacent** — only once substitute and integration are ruled out. Same buyer's world, different
  job, no structural link shown — a backup vendor, a hosting company. Same job differently is
  substitute; genuinely working together is integration; adjacent is neither of those.
- **buyer** — buys this category; the demand side, not a vendor at all.
- **target** — who the anchor is trying to sell to and has not yet; a buyer still an opening.
- **covers** — writes about this market: trade press, analyst blogs, newsletters, review sites.
- **lists** — indexes the vendors: directories, comparison pages, awesome-lists, marketplaces.
- **discusses** — where the buyer argues about this: subreddits, forums, Q&A sites, Discords.
- **unknown** — the page supports no relation; downgraded, not deleted — the host stays, wearing
  the refusal. "I couldn't tell what this sells" is unknown, never `none`.
- **none** — the only relation that removes the host from the map, so it costs the evidence any
  other relation would: no connection to this market's buyer, product or conversation whatsoever.
  Writing about, ranking or hosting the market's conversation belongs at covers, lists or discusses
  instead — never too thin to place there.

A page that RANKS, COMPARES or REVIEWS vendors is a directory or a publisher however much market
vocabulary it contains — ranking is not evidence of selling. A page that writes ABOUT a vendor is
not that vendor. Never write a `what` or `why` naming a product, capability or customer not visible
on the page.

Answer with: `name` (what the host calls itself on the page), `kind`, `what`, `relation`,
`reasoning`, `why`, `spans`, and `relationSpan`.

The `what` is one sentence that leads with what the host IS, then what it sells, in the buyer's
words: "A residential proxy provider selling rotating IPs to scraping teams." Open with the noun —
not "Sells..." or a keyword list, and not the relation, which has its own field. Do not copy the
page's self-praise — "leading", "premium", "award-winning" — or a count only the vendor can vouch
for ("70M+ IPs"): that is the page selling, not saying what it sells. Every content word is checked
against the page; an invented capability is recorded against the entity. Past ~25 words a `what` is
padding.

The `spans` are the `what`'s receipts: one to three quotes copied character-for-character from the
page below — 8 to 120 characters each — that back what the `what` says. Copy, never paraphrase:
each span is checked in code as a literal substring of this exact page, a span that fails is
dropped, and a `what` with no surviving span is replaced by a sentence saying the description could
not be tied to the page. Quote the line that sells, not the slogan.

The `why` is the evidence for the relation, stated against the anchor — how it relates, not that it
resembles — never the `what` restated or the label said again. For channel relations the evidence
is what the host gives the market: vendors indexed, coverage published, buyers who argue there. One
sentence — the reader has the `what` already.

The `reasoning` is one sentence: the single fact that settled both `kind` and `relation`, not the
`why` restated — e.g. "ranks vendors, including the anchor" or "same workflow as the anchor, but a
buyer would never choose one instead of the other".

The `relationSpan` is `spans`'s counterpart for `relation`: one quote, character-for-character,
8-120 chars, backing `relation` rather than `what`. For competitor/substitute it shows the
instead-of fact; for adjacent, the same-workflow fact with none; for a channel relation it may
repeat a span from `spans` when nothing else fits.

{{host}} — how this run found it, {{seenIn}} queries in all:
{{foundBy}}

The queries are evidence with a direction: a `rival` query means it surfaced beside a competitor
the anchor itself published, an "alternatives" query means a shortlist page put it there, a
platform tag means buyers arguing rather than a vendor's own site. Weigh them WITH the page — but
the page outranks the query when they disagree: the road explains how the host got here, only the
page says what it is.

Its front page, condensed:

{{page}}
