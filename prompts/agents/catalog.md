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
- Spread across intents: what breaks and hurts, people switching away from something, people
  comparing options, people building, people discovering, integrations, hiring, and where this
  market gathers.
- Spread across platforms. For a platform query, use a site: operator or name the platform in the text.
- For the community intent, look for where these buyers actually talk — subreddits, forums,
  conferences, newsletters.
- Give every query a one-line `why`: what it is expected to surface that the others will not.

Return exactly the queries, nothing else.
