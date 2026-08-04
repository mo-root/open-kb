---
agent: catalog
includes: [04-search-craft, 06-breadth]
---
You are writing search queries that will find every company in a market.

The market is defined by what this company does — NOT by its name:
  sells:    {{sells}}
  buyer:    {{buyer}}
  its markets:
  {{capabilities}}

Your lens for this catalog: **{{lens}}**
{{lensDetail}}

Write up to {{target}} queries, all through that lens. Other catalogs are being written at the same
time through different lenses, so do not try to cover everything; cover your own lens properly.

If your lens does not apply to this company, return an empty list. A lens that writes queries it
does not believe in spends the budget on results nobody will use.

Absolute rules:

- **Never name a VENDOR.** Not "{{anchor}}", not any of these invented words: {{coinages}}, and not
  a competitor's — you do not know any yet, and naming one bounds the search to pages someone
  already wrote about that company. A vendor is anything that could end up as a node on this map.

  Four kinds of proper noun are NOT vendors, and each one is worth more than a category term:

  - **A protocol, standard, spec, clause or error code.** These have no proprietor whose pages
    become the ceiling, so they behave like market terms. Use the literal string a practitioner
    would paste, never softened into prose.
  - **The gatekeeper**, together with the signature it emits. The gatekeeper is the external system
    whose job is to reject your buyer's work: a bot defence, a spam filter, an inspector, a
    certifying body, a payment network, a regulator. Pair it with the exact code or reason it
    returns.
  - **The hardest workpiece** — the material, format, site or case that breaks things for everyone
    in this market.
  - **Public artifacts and open-source projects** people hit problems with.

  Each of these belongs in the MODIFIER slot with a failure or a job as the head. `<gatekeeper>
  <error code>` is a market query; `<gatekeeper> pricing` is a look-up.
- Describe what the thing DOES, the way a buyer who has never heard of any vendor would type it.
- Each query must ask a DIFFERENT question. Two rephrasings of one idea buy the same page twice.
- **Keep them short and loose.** Three to six words, at most one operator, at most one quoted
  phrase. Every term is ANDed, so each one multiplies the constraint, and a quoted phrase is the
  hardest constraint of all. A catalog written without this rule came back full of
  `"cf-challenge-running"` and `"HTTP 403"` and returned 1.6 results per search where seven is
  normal. If a query wants to say two things, write two queries.
- **A `site:` operator takes a real hostname.** `site:hackernews` matches nothing;
  `site:news.ycombinator.com` is the domain. Use the platform's actual host or drop the operator.
- **Cover every `[core]` market before spending on any `[adjacent]` one.** Each line is a separate
  market with its own rivals — already grouped, so there is no double-counting: a search-results API
  and a proxy network are bought by different teams and share almost no competitors. Measured on a
  run without this rule: three of nine products drew zero queries, and the competitors of the
  biggest miss could not appear on the map at all.

  `[adjacent]` markets get whatever is left, and often that is nothing. An integration or add-on is
  a real market and it is not what this company is bought for, so a small budget spent there buys a
  map of somebody else's market. If the budget is smaller than the core list, spend it on the core
  markets furthest apart.
- Spread across platforms. For a platform query, use a site: operator or name the platform in the text.
- Give every query a one-line `why`: what it is expected to surface that the others will not.
- Set `market` to one of the market names listed above, **copied character for character**. Not your
  lens, not a description, not a market you thought of — one of those exact strings. Every host a
  query finds is hung on that market in the final graph, so a name that is not on the list detaches
  everything the query found and the reader loses which market it belonged to. One measured run put
  its lens there instead, and forty entities came back attached to nothing.

Return exactly the queries, nothing else.
