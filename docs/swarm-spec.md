# The swarm

The authority for this is the owner's own words, transcribed here. Where a design workflow or my
judgement disagrees with this, this wins.

## What it is

A swarm of agents running in parallel that maps the market around one company. Each agent decides how
to act and what to do next rather than following a fixed script. Because it is a swarm it goes deeper
and returns stronger than a single pass.

Everything that decides behaviour lives in `prompts/` and the workflow the agents run, editable
without a rebuild.

## The three phases

**1 — Understand the company from its own docs.** Agents take the company, break it down, and piece
it together primarily from the company's own documentation. They use whatever tools they need
(`search`, `fetch`, `read`, `remember`) and pull the corpus themselves rather than being handed it.
Docs usually surface a large number of products; capture ALL of them and classify each correctly.
This is where today's engine is weakest: a company with dozens of product lines extracted three.

**2 — Build outward.** From the products, map the ecosystem with SERPs and go deep. Agent-driven:
the agent sees what came back and decides where to push, not a fixed wave loop.

**3 — Every product, stripped, searched for alternatives.** Take each product, strip it out, and
SERP for its alternatives. Two channels per product, and each finding records which surfaced it:

- **de-branded** — the job phrased as an outcome, naming no vendor. Finds the market and its
  substitutes. This is the only channel the understand phase may ever use.
- **branded** — the raw product name in Google: `<product> alternatives`, `<product> vs`. Finds the
  comparison ecosystem that forms around a named product. Reverses the coinage ban FOR THIS PHASE
  ONLY, deliberately, because the two channels find different things and the map wants both.

Every entity records: what it is, how it was found (which channel, which product's search), its tags,
and how it connects to everything else.

## The bar

At least as good as v1, and self-evolving on top of it. v1 reached ~309 products on brightdata and
attached each finding to the product whose search surfaced it. Match that shape, beat that depth.

## Default mode

The swarm is THE run. Every map goes through it. Deeper and stronger by default, at higher cost:
estimated $2–5 and 5–10 minutes against today's $0.58 and 2 minutes, unmeasured until it runs. The
current fast pipeline survives as a fallback flag; nothing advertises it.

## Self-evolving, v0

Build the substrate now, not the feature. Every run writes a journal of what worked — per-query
yield, per-stage outcomes, dead ends — and the next run's agents read the journals for that market
before planning. That is the minimum that makes "improves from its own past runs" real. How far to
push it beyond that is the owner's call, later.

## What stays mechanical, and why

Keep as code, because each was MEASURED to beat the model:

- **the evidence mint** (`evidence.ts`) — a claim carries a literal quote from a fetched page or it
  does not exist. The guarantee, never an agent's discretion.
- **product-page discovery** (`catalog.ts`) — reading pages beat reading an index 9 products to 2.
  Agents decide WHICH pages matter; the fetch and the fact-extraction are code.
- **entity linking by name-match** — string matching produced defensible edges for free where the
  paid model pass produced `github.com discusses reddit.com`.
- **span accounting and the spend ceiling** — every call billed, the ceiling read from the provider.

Agentic where the answer is a judgement: what to read, what to search next, whether a thread is
exhausted, what a host actually is once its page is fetched. Not agentic where the answer is a
lookup: the classifier judging a host from a snippet was wrong 121 times in 207, and the fix was to
fetch the page, which an agent can do but a snippet-judge cannot.

## Migration

Each step measurable against today's $0.58 / 2 min / ~160 entities. One phase at a time; the fast
pipeline stays runnable for comparison until the swarm beats it on every domain in the five-company
spread (resend, clerk, brightdata, flexport, grundfos).
