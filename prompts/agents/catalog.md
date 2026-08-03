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

Write {{target}} queries, all through that lens. Two other catalogs are being written at the same
time through different lenses, so do not try to cover everything; cover your own lens properly.

Absolute rules:

- **Never name a company.** Not "{{anchor}}", not any of these invented words: {{coinages}}. Not a
  competitor's name either — you do not know any yet, and naming one bounds the search to pages
  someone already wrote about it.
- Describe what the thing DOES, the way a buyer who has never heard of any vendor would type it.
- Each query must ask a DIFFERENT question. Two rephrasings of one idea buy the same page twice.
- **Keep them short.** Three to six words, at most one operator. Every term is ANDed, so each one
  multiplies the constraint — a sentence describing one person's problem matches only the pages
  where someone wrote that sentence. If a query wants to say two things, write two queries.
- **Cover every market listed above.** Each line is a separate market with its own rivals — already
  grouped, so there is no double-counting: a search-results API and a proxy network are bought by
  different teams and share almost no competitors. Give every one at least one query of its own
  before giving any one a second. Measured on a run without this rule: three of nine products drew
  zero queries, and the competitors of the biggest miss could not appear on the map at all. If the
  budget is smaller than the list, spend it on the markets furthest apart.
- Spread across platforms. For a platform query, use a site: operator or name the platform in the text.
- Give every query a one-line `why`: what it is expected to surface that the others will not.

Return exactly the queries, nothing else.
