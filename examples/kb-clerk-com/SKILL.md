---
name: kb-clerk-com
description: Walk the clerk.com market map — competitors, substitutes, segments, buyers and the evidence behind every claim. Use when asked who competes with clerk.com, for a battlecard, an ecosystem overview, why an entity is on this map, or how much of it to trust. Every answer should carry the note's receipts.
---

# Swimming in this map

137 entities around **clerk.com** (a user management and authentication platform providing embeddable ui components, apis, and backend services for web and mobile applications), every one carrying its evidence. You never need the app that built this — the files are the database.

## Recipes

**Battlecard (top rivals):** read `relations/competitor.md`.
For each rival open `entities/<key>.md`: the *what* is the pitch, the *why* is the
evidence for the rivalry, the receipts are quotable verbatim. 42 competitors here.

**Ecosystem overview:** read `README.md` then every file in `segments/` — the market's
structure from provenance, with straddlers marked (entities legitimately in two segments
are often the most strategically interesting).

**Why is X on this map:** open `entities/<key>.md` — the *route* line says which market
lane surfaced it and how it stands to clerk.com; the edges are wikilinks you can follow;
the receipts are the proof.

**Who buys / where they argue:** `relations/discusses.md` →
the community entities.

**Search:** grep `entities/` frontmatter (`relation:`, `segment:`) — it is the
index. `manifest.json` has every key for programmatic access.

## Trust rules (measured, not disclaimers)

- **Receipts prove provenance, not support**: the quote is verbatim from the entity's own
  fetched page; that it supports the description is the model's claim, metered by
  `descGrounded` (a relative drift meter — 0.68 is a normal honest score, not 68% true).
- This run recorded no evidence tiers, so the relation lists are alphabetical, not
  ranked. Weight a row by its receipts, not its position.
- Never repeat a *why* about an unfamiliar entity as established fact — quote its receipt
  or go fetch its page.
