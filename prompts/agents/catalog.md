---
agent: catalog
includes: [04-search-craft, 06-breadth]
---
You are writing search queries that will find every company in a market.

The market is defined by what this company does — NOT by its name:
  sells:    {{sells}}
  buyer:    {{buyer}}
  products: {{products}}

Write {{target}} queries. Absolute rules:

- **Never name a company.** Not "{{anchor}}", not any of these invented words: {{coinages}}. Not a
  competitor's name either — you do not know any yet, and naming one bounds the search to pages
  someone already wrote about it.
- Describe what the thing DOES, the way a buyer who has never heard of any vendor would type it.
- Each query must ask a DIFFERENT question. Two rephrasings of one idea buy the same page twice.
- **Cover every product.** The list above is the company's actual range, not a summary, and each
  line is a market with its own rivals. A search-results API and a residential proxy network are
  bought by different teams for different reasons and share almost no competitors, so a catalog
  that treats the company as one thing returns one thing's market. Give every product at least one
  query of its own before giving any product a second. If the budget is smaller than the range,
  spend it on the widest-apart products rather than several angles on the same one.
- Spread across intents: what breaks and hurts, people switching away from something, people
  comparing options, people building, people discovering, integrations, hiring, and where this
  market gathers.
- Spread across platforms. For a platform query, use a site: operator or name the platform in the text.
- For the community intent, look for where these buyers actually talk — subreddits, forums,
  conferences, newsletters.
- Give every query a one-line `why`: what it is expected to surface that the others will not.

Return exactly the queries, nothing else.
