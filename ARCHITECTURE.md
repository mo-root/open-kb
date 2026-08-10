# Architecture

The [README](./README.md) explains what open-kb does. This explains how, at the
level of detail you need before changing it.

Two engines sit over one evidence store. `sweep` buys breadth in a single pass;
`swarm` buys depth through an agent loop. Both take their capabilities as
injected ports, which is why the whole suite runs offline.

---

## The shape of the repo

| Package | Job | Depends on |
|---|---|---|
| `@open-kb/core` | Evidence store, ports, tools, judge, ledger, breaker, scorecard. No network, no keys, no vendor names. | `ai`, `zod` |
| `@open-kb/providers` | The only place vendor HTTP lives. Credentials are a parameter. | core |
| `@open-kb/sweep` | The breadth engine and its rank kernel. | core, providers |
| `@open-kb/swarm` | Orchestrator, lead and investigator agents, board, map. | core |
| `web` | Next.js app — start a run, stream spans, browse the map. | core, providers, sweep |

Prompts are markdown on disk, loaded at runtime. Edit a file, run again,
behaviour changes — no rebuild.

---

## Ports, and the gate that keeps core honest

`packages/core/src/ports.ts` declares two interfaces and nothing else.

**`SearchPort`** is batched: one row per *distinct* query, keyed by the query
and never by index. A per-query failure rides inside its own row rather than
rejecting the batch. Dedupe is a **billing** rule and lives here, because the
port is the only layer that knows one query means one billable request.

**`FetchPort`** is `get(url, "direct" | "unlocked", { signal })`, returning the
bytes alongside the `ms` and `usd` they cost.

Nothing in core constructs either one. `sweep()`, `runSwarm()`, `judgeHosts()`
and the tool layer all take them as parameters, and the Bright Data
implementations live only in `providers`.

`scripts/check-core-purity.mjs` enforces the boundary mechanically: inside
`packages/core` it forbids `process.env`, DOM globals, HTTP framing, and any
vendor name. It is deliberately hardened against being neutered — there is no
flag that narrows the scan, `--also` can only add roots, an unrecognised
argument exits `2` so "did not run" cannot be mistaken for "clean", and a scan
that finds zero files is a failure rather than a pass.

The payoff is `packages/core/src/testing/fake-provider.ts`: deterministic
`FakeSearch` and `FakeFetch` that bill the way the real ports do. The suite runs
complete engine runs — including multi-agent swarm runs — with **no network and
no credentials**. The doubles are firewalled by a test that scans every shipping
`src/` for an import of them, plus a second test asserting some test still
imports them, so the guard cannot go stale watching a dead string.

---

## The evidence model

One function mints a citation and it has no fallback branch:

```ts
const ev = cite(handle, "…the sentence, as it appears on the page…")
```

`CitationError` on any of: an unknown handle; a record whose status is not
`found`; a quote under `MIN_QUOTE_LENGTH` (8) — too short to prove anything; or
a quote not literally present in the stored bytes, compared whitespace-squashed
and case-folded.

A rejected claim is **not written to the graph**, and the refusal goes to both
the model's tool result and the span log — a refusal recorded only in the reply
is invisible the moment the run ends. `checkQuote` is exported so the sweep's
own span verification asks the identical question.

Two evidence tiers exist at the core level. `page` means this run fetched the
URL and read the bytes; `snippet` means the search engine's own title and
description for a URL nobody opened. Snippets are admitted deliberately —
refusing them was measured throwing away most of what a run found — and the tier
travels with the evidence to inform confidence. **It is never used to reject.**

The swarm adds a third, stronger tier: `own-page`, meaning the quote came from
the claimed host's own site.

> A previous generation of this system synthesised the proving quote out of the
> value it was meant to prove, which made every citation on screen meaningless.
> That is why this layer is severe.

---

## `sweep` — breadth in one pass

Six phases. Three of them spend.

**understand** reads `llms.txt`, the sitemap and the nav, and produces a
decomposition: what the company sells, its products, its capabilities, and the
words it invented. Those coinages matter in the next phase.

**plan** runs one catalog call per funded product, six in parallel, stripping
each product to one to three terms a buyer would actually type. Deterministic
templates are dealt alongside the model-written queries, so no clever day can
skip the query that finds the centre of a market.

Then the hinge: `banned(q, family, anchorName, coinages)` drops any non-branded
query naming the anchor or one of its coined words — **before it is bought**.

**sweep** fires the queries through a continuous worker pool, twenty wide by
default, three SERP pages each.

**assess** is the widening loop, and it runs *concurrent with* the workers so
assessment overlaps searching instead of interrupting it. It reads a per-family,
per-product yield table and either releases held templates, writes new queries,
or seals the run. Four independent rules can stop it — the model says enough; it
wants more but proposes none; everything proposed was already asked or banned;
the round that landed added almost nothing — and `MAX_WAVES` bounds how often
the planner is consulted at all.

**rank** judges every host from its own front page. Subdomains fold first. A
host that cannot be read settles by arithmetic for `$0`, keeping a stable
`unreadableReason` rather than a sentence. Only the readable residue reaches a
model, and every quote it returns is re-checked in code; a claim with zero
verified spans has its prose replaced by a refusal.

**link** draws edges. A free pass first, where one host's own SERP title and
description name another entity — those are `measured`. The residue goes to a
batched model call over co-occurring pairs — those are `inferred`. An edge whose
endpoint is not on the map is dropped.

---

## `swarm` — depth on a budget

Not a pipeline. A **lead** agent holds one metered conversation, writes its own
follow-up questions onto a priority board, and funds each from a shared ledger.
Investigator lanes pop whatever they can afford. Nothing barriers: the loop is
fill / think / wake around a race.

A **mission** is a question, not a task — a lens, a brief, a why, a priority, a
tier and a dedupe key. Tiers carry allowances, and a mission is funded before it
runs. The lead's questions occupy the upper priority band; an investigator's
proposals sit below and only run once the lead's band is empty.

**Four commissioners besides the lead** write onto that board: the harness's
orienting seed, a family floor that opens a fixed deck of market questions, a
sweep handoff (`--from-sweep`), and investigators proposing upward. This matters
for the finish gate below.

The **map** keys identity on the registrable host, so `docs.apify.com` and
`apify.com` are one node. A merge keeps the displaced account rather than
discarding it. Provenance is **computed, never asserted**. A retraction is a
claim with a reason, and a retracted node takes its edges with it.

---

## The finish gate

The failure this exists for is on the record: a run ended `lead-finished` at
eight nodes with $3.55 of a $5.00 ceiling unspent.

A code-side scorecard computes fractions that carry their own arithmetic —
families with no page-tier node, claims resting on a single source, pool left
unspent — and `finishTool` refuses a finish the scorecard objects to.

**What clears a refusal is work the loop counted, and both halves are narrow.**

A **page** counts when the lead's own fetch produced a `found` reading for which
the run held neither the *address* nor the *bytes*. Address means registrable
host plus path; bytes means a digest of the extracted text, kept alongside a
digest with the requested URL masked out. Between them these close: a dead host
(which resolves rather than throws, and would otherwise be free), a re-fetch, an
alias with a different query string, a scheme flip, a redirect landing on a page
already held, and a soft 404 that echoes the path it was handed.

Two costs are accepted on purpose. A site addressing distinct pages by query
alone reads as one address — keeping the query would restore an unbounded supply
of fresh addresses at $0 a fetch, which was a measured bypass. Subdomains fold
too, inherited from the identity rule; that one is the more debatable, since a
docs subdomain is usually a genuinely different page.

A **mission** counts only when the *lead itself* commissioned it, which on the
default path is a minority of them. Re-ranking a harness row does not make it
the lead's — the board records whether a row was an investigator's unreviewed
proposal, which is the only promote that represents a real commission. Neither
does killing a row and spawning it again under the same key: the commissioner
survives the kill. The re-spawn may change the mission's lens, tier, seeds and
which reservation pays; what it cannot change is whose commission the key is. A
genuinely different question, under a key nothing was commissioned under, does
count.

Refusals are bounded at two and counted **per turn**, so several finish calls in
one model message are one finish, re-issued. The gate never holds a run open:
`turns <= turnCap - 2` makes the last two turns un-refusable whatever the
ceiling is, and every accepted finish records *why* it stood — clean, work,
disarmed, turn-cap, budget-floor, or refusals-spent — beside a receipt naming
the page or mission that paid.

**Status.** The gate is covered by tests, including complete offline runs, but
it landed after the runs currently on disk were captured. No stored artifact
carries its fields yet.

---

## How a run ends

Seven typed endings, each producing a map: the lead finished; the budget floor
was reached; the wall clock expired; the turn cap was hit; the lead faulted
twice in a row; the run was stillborn (no readable anchor and no search results
inside the opening window); or the caller aborted.

---

## Honest limits

- **Bot walls.** Thirteen to eighteen per cent of hosts cannot be read. They stay
  on the map with a machine-readable reason.
- **Grounding.** Description grounding averages 0.55–0.60. It is measured on
  every description and **nothing gates on it**.
- **Edges are the weaker claim.** They carry a reason and a confidence, but not a
  URL, and a minority are inferred from co-occurrence rather than from a page.
- **Recall is crude.** The probe counts every outbound host on a page as
  something the map should have found, so `googleapis.com` and `linkedin.com`
  count against it. The number is deflated by construction.
- **The swarm is far more expensive per entity than the sweep** and has never
  exceeded a few dozen entities in a run. It is research, not the product.
- **The harvest tier and the proposal band ship but have never fired** in a
  stored run.
- **No quality number is verified.** The audit exists to measure a wrong-rate and
  no packet has been scored.
