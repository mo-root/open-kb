---
date: 2026-08-03
status: design proposal (not approved, no code written)
subject: open-kb orchestration — the run's shape, sub-agents, tools, decision ownership, stopping, and 300 nodes
grounded in: packages/core/src/*.ts @ feat/foundation-and-investigator, runs/stripe-com.json, runs/resend-com.json,
             docs/research/*, docs/design/2026-08-02-orchestration.md, inspiration/query-catalog-ALL.md
---

# Orchestration

Every number marked **[M]** is measured — either from this repo's own run artifacts (`runs/*.json`, which
I re-parsed) or from `docs/research/`. Every number marked **[E]** is arithmetic over [M] plus an assumed
token price, and **[E] numbers are currently unverifiable in this codebase** for the reason in §7.1.

---

## 0. What I measured before designing

I re-parsed the two live runs committed to the repo. Three things in them contradict assumptions in the
existing design docs, and all three change the orchestration.

**SERP is cheap. SERP is not fast.** Across 52 real SERP calls in `runs/stripe-com.json` and
`runs/resend-com.json`:

| | ms |
|---|---|
| min | 1,330 |
| p50 | 8,826 |
| p75 | 13,822 |
| p90 | 25,155 |
| p95 | 43,419 |
| max | **177,876** |
| mean | 14,458 |

13% of queries exceed 20s. **[M]** `docs/design/2026-08-02-orchestration.md` prices SERP at "~1.5–2.5s"; that
is wrong by roughly 6×. The unlocker is 13–16s **[M]**; the *mean* SERP call is 14.5s. They are the same
latency class. Only the price differs ($0.0015 vs $0.008).

`search` today is `Promise.all` over the batch (`tools.ts:336-337`), so **a batch costs its slowest query.**
In the resend run, one query — `emailgeeks chat` — took 177.9s and held a six-query batch. That single call
is **44% of the entire 406s run.** A design that issues 300 queries as 25 model-issued batches of 12 pays
roughly p92 of that distribution 25 times over. That alone rules out the naive shape.

**Direct fetch is the cheap, fast, high-yield primitive, and it is underused.** Across 34 direct fetches:
p50 511ms, p90 1,121ms, max 2,026ms, cost $0.00 **[M]**. In the stripe run, 7 of 8 speculative `llms.txt`
probes on unknown vendor hosts succeeded, in under 1.1s each, for nothing. Turning a roster host into a
citable node costs one free sub-second GET. **This is why 300 nodes is affordable at all**, and it is the
single most important measurement for this design.

**The single agent does not record as it goes, and the doctrine cannot make it.** `03-evidence.md` says
"never batch to the end." The resend run called `remember` exactly twice, at t=354s and t=377s of a 406s
run — the last 13%. **[M]** The first call had 3 of 17 claims rejected. The stripe run called `remember` 15
times and 11 wrote nothing at all. A long-lived agent holds findings; a short-lived one cannot. This is a
structural argument for many small agents that is independent of throughput.

**Two code facts that are harmless at 14 nodes and expensive at 300** (both verified by grep):

- `EvidenceStore.hasFetched()` (`evidence.ts:77`) is referenced **only by tests**. The `fetch` tool
  (`tools.ts:362-398`) calls `ctx.fetch.get` unconditionally, mints a second handle for a URL already in the
  store, and re-sends another 8KB slice into a context. With one agent this never fires. With 35 agents
  sharing one store it is the "redundancy compounds instead of multiplying" failure named in
  `docs/research/2026-08-02-open-enrich-teardown.md` §4.3.
- `SpanKind` declares `"model"` and `"spawn"` (`spans.ts:1`) and **nothing emits either**. `tokensIn`/
  `tokensOut` are declared and never populated. The honest `$0.054` of the resend run is provider-only. At
  30-way model concurrency the model tier dominates the bill, so today the project **cannot measure the
  thing the owner set a $1 target on.**

---

## 1. The run's shape

### 1.1 Interrogating the proposed shape

> decompose → generate a query catalog → fire it in parallel → the model classifies the bag → sub-agents
> prove what matters

It is right in outline and wrong in five specific places.

**Wrong 1 — "fire it in parallel" cannot be a sequence of model turns.** At p90 = 25s per query and a
`Promise.all` batch, the model must not be in the query loop. The model writes the catalog; **the harness
fires it.** This is not a loss of agency: the harness never writes, rewrites, reorders for merit, or drops a
query — it owns concurrency, per-query deadline, exact-string dedupe, and accounting. That is the same
division `search` already has, moved up one level.

**Wrong 2 — a phase is missing between "fire" and "classify": the harness must reduce hits to hosts.**
300 queries × ~18 organic hits (`brd_json` with `num=20`) ≈ 5,400 hits ≈ **380k tokens [E]** if handed to a
model raw. Re-sent across a 20-turn conversation that is $3.80 in input alone — more than the map. Reduction
to per-host aggregates is pure counting and belongs to the harness. ~500 hosts at ~25 tokens each is a 13k
token table. **This omitted phase is where the design lives or dies.**

The aggregate must carry **distinct-query count and distinct-intent count**, not a hit count — because the
measured noise case (a perfume site tying a major vendor at 3 hits) had all three hits from *one malformed
query*. With distinct-query counts on screen the model sees that instantly. The harness counts; the model
judges. A hit count alone is the frequency-counter failure the project already paid for.

**Wrong 3 — "classify the bag" and "prove what matters" are the same act, done twice.** A classification
made from SERP snippets cannot become a node: `cite()` requires a literal substring of bytes *this run
fetched* (`evidence.ts:95`), and search results never enter the `EvidenceStore`. So every classified host
must be fetched anyway — and doctrine 05 already says the free front-page GET is *definitive* for host
identity. Classifying before fetching is guessing at something you are about to be told for free in 500ms.
**The judgement of what a host is happens once, inside the agent that opened it.**

What survives as a genuinely global decision is *routing*: which hosts to open, how deep, and grouped with
which others. That needs the whole bag and it needs no page bytes at all.

**Wrong 4 — "prove what matters" implies a filter, and the measurement says there is nothing to filter.**
"Everything that comes back is some kind of player; the job is classification, not filtering." The default
is therefore: **every roster host gets opened**, because opening is free. What varies is depth — a vendor
gets a front page and a node; a directory gets an unlocker and yields forty names. The routing decision is
`resolve | mine | place`, not `keep | drop`.

**Wrong 5 — it is a line, and it must be a loop.** The yield curve was still climbing at query 40 (~3.2 new
hosts/query) **[M]**. More importantly, catalog #1 is written before the run knows anything: after the first
sweep the run holds ~200 company names it had never heard of, knows which intents paid and which capability
terms were barren. A second catalog written with that in hand asks *different questions* — rival-anchored
comparisons (a rival's name is a different anchor with different neighbours than the anchor's), rewrites of
barren terms, and buyer-voice community queries. Doctrine 01's "the anchor is the ceiling" is about *the
anchor*, not about all brands.

### 1.2 The shape I propose

Eight phases, one loop, one lead, four sub-agent roles. Phases 2–5 **overlap** — the sweep streams into the
roster and routing runs in waves against a growing roster. Nothing waits for the whole catalog. A host's
aggregate only ever grows, so an early routing decision is never invalidated, only strengthened.

| # | phase | who | produces | cost | wall |
|---|---|---|---|---|---|
| 0 | **Read the anchor, twice** | 2 `reader` sub-agents, parallel | two independent decompositions | ~$0.02 **[E]** + $0.009 SERP **[M]** | ~30s |
| 0b | **Diff the two** | lead, 1 turn | the decomposition + coinage list | ~$0.005 **[E]** | ~8s |
| 1 | **Write the catalog** | 6–10 `lens` sub-agents, parallel | 250–400 queries w/ metadata | ~$0.07 **[E]** | ~20s |
| 2 | **Sweep** | harness | hits, streaming | 320 × $0.0015 = **$0.48** **[M]** | 110–145s @32-way |
| 3 | **Reduce** | harness | the roster (host aggregates + yield curve) | $0 | ms |
| 4 | **Route** | lead, 1–3 turns | groups → missions | ~$0.03 **[E]** | ~10s/wave |
| 5 | **Prove** | 20–40 `prover` + 5–10 `miner`, parallel | nodes + edges | **~$0.55–0.70** **[E]** | ~90s |
| 6 | **Loop or stop** | lead, 1 turn on harness counts | catalog #2, or `done` | ~$0.01 + ~$0.4 for a 2nd lap | ~120s |
| 7 | **Shape & close** | lead, 1 turn | stop reason, gaps, retractions | ~$0.01 **[E]** | ~15s |

**Total ≈ $1.6 [E]** — provider ≈ $0.68 **[M-priced]**, model ≈ $0.9 **[E, unverified: no model spans]**.
**Wall ≈ 250s with overlap, ~400s without.** Today's single investigator: 406s, $0.054 provider-only, 14
nodes **[M]**. So: ~20× the nodes, ~1× the wall clock, ~12× the provider spend, and a model bill nobody has
ever measured.

Phase-by-phase, with the argument for each:

**Phase 0 — two readers, not one.** The correlated failure of any lead-shaped design is that one framing
written in the first 30 seconds is inherited by everything downstream; parallelism *multiplies* it rather
than diversifying it. Two readers run concurrently on deliberately different material: **reader A** on the
company's own surfaces (apex, `/llms.txt`, `docs.<domain>/llms.txt` — 10/14 and 12/14 hit rates **[M]**),
**reader B** on third-party material only (SERP snippets and one or two writeups, forbidden from fetching
the anchor's own host). Each returns a structured decomposition; neither ever sees the other's transcript.
The lead diffs them in 0b. Where they disagree about what a product *is*, that disagreement is the most
valuable signal in the run and it costs ~$0.01 and ~8s.

Putting the reads in sub-agents (rather than in the lead, as the prior design does) has a second payoff:
**page bytes never enter the lead's transcript.** The lead's context holds only decompositions, roster
tables and count reports — all compact — for the whole run.

**Phase 1 — the catalog is written by several contexts, not one.** The shape comes from
`inspiration/query-catalog-ALL.md`, read for structure only: it is a grid of **platform × intent ×
capability**, 602 rows, of which only ~13% carry a competitor- or switching-intent (the ones that name a
vendor). Transferable intents: `pain, switching, evaluation, build, discovery, competitor, launch,
integration, hiring`. Platforms are `site:`-shaped lenses, not a list of hosts to trust.

The axes go in **doctrine prose**, never in code: v1's 936 lines of query templates × cap is the named
failure, and the comment in that file admits the "precision fix" was asking fewer questions. `sweep` buys
the literal string the model wrote.

Why several lens agents rather than one 300-line output: (a) one context producing 300 query strings drifts
toward one phrasing, and the whole thesis is that near-identical queries buy the same page twice; (b) a
12k-token output turn is ~60s of streaming, versus ~20s for eight parallel 40-query turns. **This is an
experiment, not a certainty — see §8.1.**

One harness check here, and it is counting, not judging: the readers named the anchor's coinages; the
harness reports *"9 of your 320 queries contain a term you listed as a coinage of this company"*. The model
decides what to do about it. It never edits a query.

**Note on malformed entries:** 110 of the 602 rows in the reference catalog (18%) are **bare URLs**, not
queries. Fed to a SERP endpoint, a pasted URL is precisely the malformed query that produced the perfume-site
noise. A URL is a URL — that is transport shape, not market knowledge — so the harness refuses a URL-shaped
catalog entry *in words* ("this is a URL, not a query — fetch it instead") and never silently rewrites it.

**Phase 2 — the sweep is the harness's whole job.** Bounded concurrency, a per-query deadline, exact-string
dedupe (never fuzzy — a similarity threshold silently deletes the model's ideas), canonical-URL hit
accounting, per-query failure reported and never failing the sweep (already the `SearchPort` contract).
A 30s deadline clips at roughly p90 **[M]**, costing ~10% of queries and bounding the 178s pathological tail.
Whether that clipping loses real hosts is measurable — §8.3.

**Phase 3 — the roster.** Per registrable host: distinct queries that surfaced it, distinct intents,
distinct capabilities, best rank, first-seen query, up to 3 titles/snippets, state
(`unseen | routed | opened | recorded | closed`). Plus the **yield curve**: new hosts per query, in the
order results landed. All of it is counting; none of it is a verdict.

**Phase 4 — routing, and it outputs groups, not per-host lines.** The lead sees a 25-token-per-host table
(no snippets — those go to whichever agent opens the host). It emits ~40 groups of the form
`{group, hosts[8-15], depth, brief}` ≈ 30 tokens each ≈ 1.2k output. Grouping is what makes *edges*
writable: an agent holding twelve related entities can state how they relate; an agent holding twelve
alphabetical strangers can only write nodes. The harness offers a mechanical default grouping (by the
capability/intent cluster whose queries surfaced the host — free, from the aggregate) and the model
overrides it. When the roster is larger than capacity, the *ordering* of which hosts get opened is a model
judgement over the whole bag, which is exactly why this phase sees everything at once.

**Phase 5 — proving is the bulk of the run.** §2 details the agents. The economics: ~300 free front-page
GETs at p50 511ms **[M]**, ~$0 provider, and the entire cost is model input for reading them.

**Phase 6 — one loop boundary, maybe two.** The harness renders four curves (§5). The model writes catalog
#2 or calls `done`. Sweep #1 is capability-shaped; sweep #2 should be buyer-shaped and rival-shaped — this
is where communities are actually bought, since vendor queries return vendors and the 18 community hosts in
40 queries **[M]** were incidental rather than targeted.

**Phase 7 — the shape pass.** At 14 nodes a human reads the map back, which is what doctrine 06 asks for
("if nearly every edge says competitor, you have spent the whole run looking through one lens"). At 300
nodes only a harness-computed count report makes that possible: nodes by kind, edges by relation, nodes with
one evidence vs many, capabilities with zero companies, companies with zero edges, communities recorded,
suspected duplicate names, unopened roster depth. The lead reads it, writes cross-cluster edges the provers
could not, retracts what it should, and states what the run failed to find. **The gaps are half the
deliverable** and nobody but this turn can see them.

---

## 2. Sub-agents

`investigate()` already takes a `RunContext` carrying `agentId`/`parentId` and a shared `graph`,
`evidence`, and `spans` (`tools.ts:8-18`). A sub-agent is a second `ToolLoopAgent` over a context with a new
`agentId`, `parentId: parent.agentId`, and the same three shared objects. Nothing structural is missing.

### 2.1 The four roles

| role | handed | returns | concurrency | tools |
|---|---|---|---|---|
| **reader** | the anchor domain; a *side* (own material \| third-party only) | a structured decomposition: products, capability per product in brand-free words, buyer + buyer vocabulary, coinage list | 2, once | search, fetch, read |
| **lens** | one capability + the decomposition + the platform×intent grid | 30–50 queries, each `{q, platform, intent, capability, why}` | 6–10, once | *none* (single structured turn) |
| **prover** | 8–15 roster hosts w/ aggregates, the decomposition, the coinage list, the node ids already in its group | ≤120-token digest | 20–40 | search, fetch, read, remember, propose |
| **miner** | ONE page that promises to name many things, + the decomposition | ≤120-token digest | 5–10 | fetch (unlocker allowed), read, remember, propose |

**A sub-agent is for one bounded slice of *proof*, not for one entity and not for one intent.** One entity
per agent is too small — the fixed cost is the doctrine prefix (~2.5k tokens re-sent every turn), so a
one-host agent spends most of its money on instructions. One intent per agent is too big and produces the
alphabetical-strangers problem: it cannot write edges. **One coherent group of 8–15 hosts is the unit**, and
it is coherent because the harness grouped by the queries that surfaced them.

**Why `miner` is a separate role rather than a deep `prover`.** Different economics (one expensive unlocked
fetch plus many free `read`s, vs many free fetches), a different prompt (doctrine 05's index-versus-dump
judgement — 65KB/23 headings is an index, 615KB/5 headings is a link dump **[M]** — matters here and nowhere
else), and a different failure mode (a directory behind auth is a cheaply-closed lens reported in one line,
which is a *good* outcome). Mixing them makes both prompts worse.

**Prompt composition per role is already supported.** `composePrompt` reads an `includes:` frontmatter list
(`prompts.ts:29-38`). A prover does not search for coverage and does not plan breadth, so it should not
carry `04-search-craft` or `06-breadth`. That is ~1.5k tokens × ~5 turns × 35 provers ≈ 260k tokens ≈ **$0.13
saved [E]** and, more importantly, a shorter instruction it will actually follow.

### 2.2 How findings merge without polluting

Five mechanisms, four of which already exist:

1. **Separate contexts by construction.** Each `ToolLoopAgent` owns its message list. No agent ever reads
   another's transcript, summary, or reasoning. A prover's ≤120-token digest goes to the **lead only**; the
   lead may turn it into a new mission brief it writes itself, but never forwards it.
2. **The shared objects are facts, not opinions.** `EvidenceStore` (bytes fetched), the graph (claims that
   passed the mint), the roster (counts), the span log. Sharing bytes is a feature: `cite()` checks the
   store, so agent B *could* cite bytes agent A fetched — and since B is never handed A's text, this can
   only ever mean B fetched the same URL, which the cache should make free.
3. **Writes are atomic.** `remember`'s `execute` body contains **no `await`** (`tools.ts:456-519`), so under
   Node's single-threaded loop it runs to completion without interleaving. 40 concurrent writers need no
   lock. This is worth writing down before someone adds an `await` to it.
4. **Node merge is additive on evidence** — `existing.evidence.push(...ev)` (`tools.ts:479`).
5. **Edges resolve only against nodes already on the graph** (`resolveEndpoint`, `tools.ts:191`), with no
   fuzzy matching. Correct, and it creates a new failure at 40-way concurrency: an edge to a node a
   *sibling* is about to write is rejected. Answers: the grouping (co-dependent entities land in one agent),
   plus phase 7 writing cross-cluster edges after everything has landed.

**One real merge defect, visible only at scale.** At `tools.ts:479`, when a node id already exists, the new
node's `what`, `whyHere` and `howFound` are **silently discarded** — only evidence is kept. With one agent
this is invisible. With 35 agents, the second, third and fourth reason anyone gave for a company being on
this map are thrown away, and those reasons are the deliverable. The merge must keep them (append to the
node, attributed to the agent that wrote them) or at minimum record the conflict for the shape pass. This is
the same class of bug as open-enrich's `state.ts:83` silently dropping the loser.

### 2.3 Depth

**Depth is 1.** Only the lead spawns; provers and miners `propose`. A miner that opens a directory naming 40
companies proposes 40 hosts onto the roster, and the lead routes them on the next wave — which is fast,
because routing waves are ~10s. Unbounded recursion is where "the model sizes its own work" becomes an
unmeterable bill, and there is no measurement suggesting depth 2 pays. Revisit only with data.

---

## 3. The tool set

Four exist. I add five and refuse one. Each argument is "what breaks without it", because every tool is
prompt surface the model must understand.

### 3.1 Keep, unchanged

**`search`** — small, blocking, ≤12 queries, for a specific question a prover has right now. It survives
`sweep` because "is this host the same company as that one" is three queries, not a catalog.

**`read`** — free re-read from an offset. Untouched; it is what keeps an 880KB page out of every prompt.

### 3.2 Keep, with a change each

**`fetch` — add a cache hit and a slice size.**
- *Cache*: consult `evidence.hasFetched(url)` (which exists and is used only by tests) and return the
  existing handle, marked `cached`, free and instant. Without it, 35 agents sharing a store re-buy the same
  homepage and re-send another 8KB per agent. This is a ledger fact, not a judgement.
- *Slice*: `SLICE` is a fixed 8,000 (`tools.ts:313`). A prover resolving twelve host identities needs the
  first ~2KB of each, not 96KB in one turn. Make it a model-chosen parameter (`brief | full`), because "how
  much of this page do I need" is a judgement. **This single change is worth ~$0.5 per run [E]** — see §7.4.

**`remember` — add an optional `home` for identity.** See §7.2. The model supplies a URL the run actually
fetched; the harness derives the canonical host and keys `company` nodes on it. Host identity is a fact the
harness owns (`canonicalUrl` already exists); which host is a company's home is a claim the model makes and
proves.

### 3.3 Add

**`sweep(catalog[])` — the one genuinely new primitive.**
*Without it:* 300 queries means ~25 blocking model turns, each costing p92 of a distribution whose p90 is
25s and whose max is 178s **[M]**. That is the difference between a 250-second run and a 20-minute one.
*What it is:* takes the whole catalog with per-entry `{q, platform, intent, capability, why}`, returns
immediately with a receipt, and the harness fires it under a concurrency cap and a per-query deadline,
streaming hits into the roster. The metadata is load-bearing: it is what lets the roster distinguish "3
hits across 3 intents" from "3 hits from 1 malformed query."
*Cost of adding:* one description. Worth it.

**`roster(filter)` — free, read-only, the bag.**
*Without it:* the bag has to be pushed into the prompt, which is v1's measured 41k→447k token blowup, and
the fix the teardown says to keep verbatim is exactly the pull inversion. There is no other way for the
model to see what came back.
*Contract:* a compact table — host, distinct queries, distinct intents, best rank, state, one title —
filtered by state/group/capability, with counts. Snippets only when asked for one host.

**`map(filter)` — free, read-only, what is proven.**
*Without it:* a prover cannot resolve an edge endpoint it did not itself write, and the lead cannot see the
shape of a 300-node graph without it being pushed. Kept **separate** from `roster` rather than folded into
one `recall(op:…)`: they answer different questions for different roles (provers read `map`, the lead reads
both), and two narrow descriptions are less prompt surface than one polymorphic union of five result shapes.
The prior design's 7-op `recall` is more surface, not less.

**`spawn(missions[])` — free, non-blocking, lead only.**
*Without it:* dispatch is a harness policy, and the owner's instruction is explicit ("tell the agent to
expand the sub-agents"). More concretely: the routing turn's output *is* a mission list, so `spawn` is not
an extra mechanism — it is the mechanism, called once per routing wave with ~40 compact groups and again at
loop boundaries. Returns in ~1ms; the lead never blocks on its own workers.
*The metering objection dissolves* once model spans exist: every child's spans carry `parentId`
(`spans.ts:8`), so a spawned agent's spend is attributable by construction. Until §7.1 is fixed, `spawn` is
a tool that spends invisibly, which is the one condition under which it should not ship.

**`propose(hosts[]|missions[])` — free, prover/miner only.**
*Without it:* a miner that opens a registry naming 40 companies has nowhere to put 39 of them, and the run
loses its highest-yield artifact. Writes onto the roster with a reason, deduped by canonical host, reported
back. It does **not** create nodes — nothing proven, nothing claimed.

**`done(reason, gaps[])` — lead only.**
*Without it:* termination is "the agent stopped talking", which is indistinguishable from a crash. The
requirements doc demands a distinct named stop reason on screen; this is where the model's own reason comes
from.

### 3.4 Refuse: a way to record without proving

The brief names this as a candidate for tail entities. **I would not build it, and I think it is the most
dangerous idea on the list.**

The artifact's entire value rests on `cite()` having no fallback branch (`evidence.ts:44`, and the comment
above it naming the previous generation that synthesised proving quotes from the values they proved). The v1
teardown's headline defect is `` `Surfaced by ${c.queries.length} market queries` `` as node-level evidence —
"94% of players carry a receipt, not a reason." A record-without-proof tool re-creates exactly that node,
and the model will reach for it precisely when proving is inconvenient, which is precisely the tail. The
failure is invisible in the worst way: the map looks *bigger* and is worth *less*, and no reader can tell
which nodes are which.

**The need behind the request is real, and it already has an answer.** A host that the run surfaced and
never opened should not vanish silently — so **the roster ships with the run as residue**: "180 hosts this
run surfaced and did not open, with the query that found each and how many distinct intents it appeared
under, ranked." That is honest, costs nothing, is structurally not a node, and cannot be mistaken for a
proven claim.

And the case people usually mean — a roundup that names thirty vendors — needs no new tool at all. The
roundup's own bytes are fetched, so each vendor's name *in that page* is a citable quote. Doctrine 05
already says this: "record what a page names, not the page."

### 3.5 Final surface, by role

| role | tools | count |
|---|---|---|
| lead | sweep, roster, map, spawn, search, fetch, read, remember, done | 9 |
| reader | search, fetch, read | 3 |
| lens | — (one structured turn) | 0 |
| prover | fetch, read, remember, map, propose, search | 6 |
| miner | fetch, read, remember, propose | 4 |

No agent holds nine tools except the lead, which makes ~8 decisions in a whole run. The prover — the role
that runs 40 times — holds six, one more than today's investigator.

---

## 4. Where the model judges

Everything about the market. Nothing about counting, transport, or limits.

| decision | owner | why |
|---|---|---|
| What the anchor sells; each product in brand-free words | **model** (reader) | the de-branding hinge; measured 2× vendor yield |
| Which surfaces to read to find that out | **model** | the cheap route inverts by company type **[M]** |
| Which of two disagreeing decompositions is right | **model** (lead, 0b) | judgement over two structured opinions |
| Which words are this company's coinages | **model** states; **harness** counts occurrences in the catalog | stating is judgement; counting is arithmetic |
| Which queries to buy, and how many | **model** (lens agents) | the whole thesis; zero templates in code |
| Whether a catalog entry is a URL rather than a query | **harness**, refused in words | a URL is a URL — transport shape |
| Query concurrency, per-query deadline, exact-string dedupe | **harness** | limits, never merit; no fuzzy dedupe ever |
| Which host a hit belongs to | **harness** (`canonicalUrl`) | URL fact |
| Whether a fetch actually succeeded | **harness** (`sniff`) | status codes lie **[M]**; transport truth |
| Whether frequency means anything | **model**, given distinct-query and distinct-intent counts | the perfume-site case: a counter would rank it with a major vendor |
| Which hosts to open, in what order, how deep, grouped with which | **model** (routing turn) | needs the whole bag; capacity is the harness's fact |
| Whether a host is a competitor / substitute / directory / community | **model**, and only after fetching it | doctrine 05: the free front page is definitive |
| Which page is worth an unlocker | **model** | cost and success do not move together **[M]** |
| Which entities deserve a sub-agent, and how many | **model** (routing + `spawn`) | the owner's explicit instruction |
| How many sub-agents run at once | **harness** | provider rate limits are per account |
| What a sub-agent may see | **harness** | its group's ids + the decomposition; never a sibling's transcript |
| Whether a claim is provable | **harness** (`cite`, no fallback) | the one thing that makes the map trustworthy |
| Whether two names are the same entity | **harness** when both proved the same host; **model** otherwise | a host match is a fact; a name match is a guess |
| Confidence | **harness**, computed | never self-reported (requirements.md) |
| Whether the run has stopped learning | **model**, shown four curves | the most editorial judgement in the product |
| When to kill the run regardless | **harness**, wall-clock/loop backstop only | firing is a bug signal, not an outcome |
| What the run failed to find | **model** (shape pass) | half the deliverable |

**The one place the harness departs from the model's stated order**, and it must be said on screen every
time: if the roster grows past the concurrency the run can hold, the harness runs the model's groups in the
model's order and defers the rest — it never re-ranks and never promotes.

---

## 5. Stopping

There is no budget ceiling by choice, so "it stops when it stops learning" must be operational.

**Four curves, all computed by the harness, none of them a verdict, all shown to the model at every loop
boundary:**

1. **Barren-query fraction, per catalog.** The share of that catalog's queries that returned *zero* hosts
   not already on the roster. This is the sharpest signal available and it is per-catalog, not per-query:
   if catalog #1 was 10% barren and catalog #2 is 70% barren, the market is enumerated. The 40-query
   experiment measured the *opposite* end of this curve — still 3.2 new hosts/query at q40 **[M]** — which
   is exactly why the rule must be a measured fraction and not a tuned threshold picked now.
2. **Node yield per prover, last 5 vs previous 5.** "The last six landings produced 2 new companies; the six
   before that produced 14."
3. **Unproven roster depth.** Search saturating and proving saturating are *different events*. A run with
   200 unopened hosts has not stopped learning even if every new query is barren. The run should typically
   stop proving last.
4. **Relation and kind mix.** New nodes still arriving as substitutes, communities and capabilities means the
   run is still finding *kinds* of things; a stream of pure `competitor` means one lens.

**The rule:** the model calls `done(reason, gaps)`. The harness never stops on a number. This is the prior
design's explicit position and I agree with it — a yield floor fires early on a sparse market and never on a
dense one, and deciding whether a market is mapped is the single most editorial judgement in the product.

**The harness owns exactly three stops, and each is a bug signal except the last:** wall-clock backstop
(far above any real run), loop cap (a loop detector, not a budget), cancellation. Each emits a distinct named
reason. If a backstop fires, that is a defect to investigate, not a normal ending.

**Two harness rules that are not stops but bound the run:** never buy the same query string twice in a run
(exact match), and never open the same URL twice (canonical match, via the fetch cache). Both are ledger
facts.

---

## 6. What breaks at 300 nodes that does not break at 14

### 6.1 Entity resolution

`nodeId(kind, name)` slugs whatever the model typed (`tools.ts:104`). At 14 nodes one agent remembers what
it called things. At 300 across 35 contexts, `SendGrid` / `Twilio SendGrid` / `sendgrid.com` are three nodes
and no reader can tell. `endpointIndex` indexes id, name, and id-minus-kind and **deliberately refuses
prefix, substring and edit-distance matching** (`tools.ts:146`) — that refusal is correct and must survive.

**Answer: identity by host, where a host was proved.**
- `remember` accepts an optional `home` on a node. It must be a URL this run fetched (else it is an unproven
  claim and is rejected like any other).
- For `kind: "company"`, the id becomes `company:<canonical host of home>`. For `kind: "community"`,
  `community:<canonicalUrl(home)>` — a subreddit's identity is its path, not its host.
- For `product`, `capability`, `buyer`: name-keyed as today. Two products of one company share a host, so
  host-keying them would merge things that are genuinely different.
- The model's name is kept as the display name and added to `endpointIndex` as an alias, so edges written by
  name still resolve.
- **Fails safe:** no `home`, no merge. Nothing that works today breaks.
- Use the canonical host as-is. Registrable-domain extraction needs a public-suffix list, which is a
  dependency and a source of its own errors; `docs.stripe.com ≠ stripe.com` is an acceptable and visible
  imprecision.

**Residual, deliberately unsolved:** one company at two hosts (`twilio.com` / `sendgrid.com`). That is a
judgement, not a fact. The shape pass reports the suspicion ("3 nodes share the token 'sendgrid'") — counting
— and the model writes a `same_as` edge or retracts. The harness never merges on a name.

### 6.2 Context size

Three blowups, three answers:

- **The bag.** 5,400 hits ≈ 380k tokens **[E]** → host aggregates at 25 tokens/host ≈ 13k. Solved by phase 3.
- **Page bytes.** Solved already by the 8KB slice + free `read`, and improved by the model-chosen slice size
  (§3.2). The measured direct-fetch corpus is the risk: 300 pages × 8KB = 2.4MB ≈ 600k tokens if each is read
  once, ~$0.30 **[E]** — affordable *only* if each page enters exactly one context exactly once. The absent
  fetch cache (§0) is what breaks that invariant.
- **Edge resolution.** Today a prover that does not know an id pays a full round trip to a rejection. At 300
  nodes that rate explodes. Answer: hand each prover its own group's ids at spawn (a few dozen strings), give
  it `map` for lookups, and leave cross-group edges to phase 7.

The lead's own transcript stays small precisely because readers hold the page bytes and die: ~8 turns,
~80k cumulative input, ~$0.04 **[E]**.

### 6.3 The graph's shape — the most under-appreciated problem

Doctrine 02 opens with "every edge is stated **from the anchor outward**." The measured runs bear it out:
stripe 8 edges / 4 nodes, resend 13 / 15 — about one edge per node, nearly all anchored **[M]**. Scale that
to 300 nodes and you get a **300-spoke star**: maximal edge count, zero structure, unreadable, and it does
not answer "where should I stand."

At 300 nodes the value is in the edges that *do not* touch the anchor: company→product, product→capability,
company→community, and substitute relations between rivals. Two changes:

- **Doctrine edit (prose, not code):** for the prover role, an edge must be justified by *why it matters to a
  reader of this map*, which is not the same as "stated against the anchor." The anchor-outward rule is right
  for a 14-node map and wrong for a 300-node one.
- **Capabilities are the hubs.** 300 companies hanging off 12 capability nodes is a readable map; 300
  companies hanging off one anchor is not. This is also why `capability` nodes must actually be populated —
  the run that recorded four nodes recorded zero, which is why `NODE_KIND_GUIDE` exists (`tools.ts:37`).

The grouping in phase 4 is the mechanism: an agent holding twelve related entities *can* write the
non-anchored edges. An agent holding one entity cannot.

### 6.4 The cost of proving everything

Opening every host is nearly free ($0, ~0.5s each **[M]**); *reading* every host is the bill. Three levers,
all already available: the model-chosen slice size (§3.2), the per-role prompt trim via `includes:` (§2.1),
and the fetch cache (§3.2). Together these move phase 5 from ~$1.6 to ~$0.55–0.70 **[E]**.

The thing that must not be the lever: opening fewer hosts. "Everything that comes back is some kind of
player" — a run that opens 120 of 400 hosts has not saved money, it has produced a map with an invisible
hole.

### 6.5 The quote-verification tax, at scale

Measured: the resend run's large `remember` had **3 of 17 claims rejected** (18%); the stripe run had 11
consecutive `remember` calls that wrote nothing **[M]**. At 300 nodes an 18% rejection rate is ~60 lost
findings and ~60 wasted round trips. The mint must not soften — no fallback branch is the whole point.

Two mitigations that are harness work, not judgement:
- **Make the rejection cheaper to fix.** The message already says "quote not present in <url>". Adding the
  nearest matching span from the stored bytes is string search over bytes the harness holds. Whether it cuts
  the retry rate is measurable — §8.5.
- **Shorten the leash.** The resend run batched 400 seconds of findings into two calls because the agent
  lived 400 seconds. A prover that lives 60 seconds cannot batch more than 60 seconds of work. **Many small
  agents fix "record as you go" structurally, where the doctrine could not.**

### 6.6 Merge loses reasons

§2.2, item 5: on an id collision only evidence survives; `what` / `whyHere` / `howFound` from every writer
after the first are discarded (`tools.ts:479`). At 300 nodes with 35 writers this is the deliverable being
thrown away. Must be fixed before concurrency ships.

---

## 7. Prerequisites — things that must land before parallelism

Ordered by how badly their absence invalidates the design.

**7.1 Emit `model` spans with token counts and cost.** `SpanKind` declares `"model"` and `"spawn"`; nothing
emits either; `tokensIn`/`tokensOut` are never populated. Today's honest $0.054 is provider-only, and every
[E] number in this document is unverifiable as a result. `ToolLoopAgent.generate()` returns usage; core
computes cost from usage × a price passed in as a parameter (core must not name a model — the purity gate
forbids the string, `check-core-purity.mjs`). **Without this, "$1 per map" is not a target, it is a
guess**, and `spawn` becomes a tool that spends invisibly — the exact defect the open-enrich teardown calls
decisive against agent-spawning tools.

**7.2 Host-keyed identity for company and community nodes** (§6.1).

**7.3 The fetch cache** (§3.2) — one `hasFetched` check that already exists.

**7.4 Model-chosen slice size** (§3.2) — the largest single cost lever.

**7.5 Keep every writer's reason on merge** (§6.6).

None of these is large. All five are in `packages/core/src/tools.ts` and `evidence.ts`.

---

## 8. Where I am uncertain, and the experiment that settles it

**8.1 One catalog or eight?** Does one context writing 300 queries produce fewer distinct hosts than eight
contexts writing 40 each? *Experiment:* run both catalogs on the same anchor, count distinct hosts and
distinct hosts-per-dollar. ~$0.9 total. This decides whether `lens` is a role at all.

**8.2 The SERP concurrency ceiling.** Everything about wall clock assumes 32–64 concurrent SERP calls hold
their latency. Unknown. *Experiment:* fire 100 identical-cost queries at 16, 32, 64, 96 concurrency; measure
p50/p95 and error rate at each. ~$0.6. This sets the sweep's shape.

**8.3 Does a 30s per-query deadline lose real hosts?** *Experiment:* run a sweep with no deadline, record
which queries exceeded 30s, and count how many hosts *only* those queries surfaced. ~$0.05 on top of a sweep
already being run.

**8.4 Does the yield curve actually saturate?** The 40-query experiment cannot answer this; it was still
climbing linearly. *Experiment:* one 320-query sweep, plot new-hosts-per-query in landing order. $0.48, and
it also produces the first real roster. **This is the experiment I would run first** — it is cheap, it
validates or kills the entire premise of a few-hundred-query catalog, and it produces a reusable artifact.

**8.5 Does a nearest-substring hint reduce citation retries?** *Experiment:* A/B one prover cohort; measure
rejections per accepted node. ~$0.1.

**8.6 What does a prover actually cost?** Unmeasurable until 7.1 lands. Every model figure here is [E].

**8.7 Does host-keying actually collapse duplicates?** *Experiment:* after a 300-node run, count nodes
sharing a significant token whose ids differ. If it is 5%, name-keying was fine. If it is 25%, §6.1 was the
right call and there is more to do.

---

## 9. The riskiest thing

**Parallelism multiplies one upstream judgement instead of diversifying it.** Three hundred queries, forty
provers and every edge on the map inherit one decomposition written in the first thirty seconds from at most
ten pages. If "Connect" is read as "payment links" rather than "multiparty split settlement," the run is
confidently, expensively and uniformly wrong — and unlike today's 14-node run, it will *look* impressive
while being wrong.

Three partial defences, and they are partial:
- Two independent readers on deliberately different material, diffed (phase 0) — catches a mis-frame for
  ~$0.01 before any query is bought.
- Barren-term detection at the loop boundary — a capability with zero proven companies after two catalogs
  means the *term* is wrong more often than the market is empty, and the model can rewrite it.
- Retraction through the same mint as every other write.

None of these is a full fix, and the failure is silent from inside the run: everything found confirms the
angle taken, and the facets never phrased leave no trace of their absence (doctrine 06 says exactly this).
It is the thing I would watch first on every real run.
