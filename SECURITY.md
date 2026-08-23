# Security

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/mo-root/open-kb/security/advisories/new)
on this repo (Security tab → "Report a vulnerability") rather than a public
issue. If that's not available to you, email the maintainer at the address on
their GitHub profile. Include the affected file(s), a repro if you have one,
and what you think the impact is. No bounty program — this is a small open
source project — but real reports get a real response.

## What's in scope

The engine fetches arbitrary third-party web pages (via Bright Data) and
sends page content to a third-party model (via OpenRouter). Both are
credentialed integrations, and the web app accepts a domain from a visitor
and starts a run against it. Bugs in how those inputs are handled — request
forgery, injection into a fetched page or model prompt that escapes into
something it shouldn't, auth bypass on the hosted app's basic-auth gate, spend
caps that can be bypassed to run up someone else's bill — are all in scope.

## Keys

`OPENROUTER_API_KEY`, `BRIGHTDATA_API_TOKEN`, and the Supabase keys live only
in `.env` (see `.env.example`), which is gitignored. Never commit a real key,
and never put one in a prompt, test fixture, or example run committed to
`runs/` or `examples/`. If you find a credential accidentally committed
anywhere in this repo's history, report it the same way as above — it needs
rotating, not just deleting.
