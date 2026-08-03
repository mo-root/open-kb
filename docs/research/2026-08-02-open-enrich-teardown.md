---
date: 2026-08-02
status: research (not a design)
subject: open-enrich teardown, read as a precedent for open-kb
method: 13 agents — 7 subsystem readers, 5 adversarial critics with distinct lenses, 1 synthesis
---

> Research input, not a decision record. Every claim below is grounded in code at
> `inspiration/open-enrich`. Design decisions live in `docs/adr/`; this file only
> establishes what is true about the precedent.

# open-kb: decision-grade synthesis

## 1. What open-enrich actually is

open-enrich is a **fixed six-node acyclic DAG over LangGraph** that runs once per CSV row, fanning out to nine hand-written agent files whose field ownership is hardcoded as string arrays; the topology is nine literal `.addEdge()` calls (`packages/core/src/agents/graph.ts:94-102`) and `graph.compile()` takes no arguments (`graph.ts:104`) — a repo-wide grep for `addConditionalEdges`, `recursionLimit`, and `checkpointer` returns **zero hits**. The model's entire decision surface is bounded *inside* a node: it picks among 2-5 pre-assigned tools, writes the query strings, and self-reports a confidence number — it never decides where to go next, never adds work, never revisits. It is a **batch ETL pipeline with LLM-shaped extractors in the cells**, wrapped in an `AsyncIterable<Event>` that two real surfaces consume; the agent framework is present but the control model is `for each row: run the same 6 nodes`.

## 2. Why it feels wrong to build on

**1. The work list is a read-only input; discovery is architecturally treated as noise.** `requestedFields` is a bare `Annotation<T>` with no reducer and no default (`state.ts:35`), written once at `graph.invoke` (`run-enrichment.ts:271`), and every one of the nine agents *filters down* from it — there are zero writers. Then a node named `validate` exists specifically to delete anything discovered that wasn't pre-requested (`graph.ts:112-121`). open-kb's Expand stage produces *nothing but* unrequested discoveries, so the one node in this design that expresses editorial intent is pointed exactly backwards.

**2. Nothing can stop a run except the shape of the graph.** There is no step budget, no token budget, no timeout, no convergence check. `CostTracker.snapshot()` is read at exactly **one** non-definition site in the entire repo — `run-enrichment.ts:300`, post-hoc, to decorate a finished result. The declared per-agent timeout is literally discarded (`run-enrichment.ts:71`: `void AGENT_TIMEOUT_MS;`) and the `AbortSignal` is checked only at batch boundaries (`run-enrichment.ts:124`) and never forwarded into `graph.invoke`. This is survivable *only* because the number of LLM calls is a source-code constant. **The absence of agency and the absence of a brake are the same fact** — you cannot safely retrofit "the model decides what's next" onto a substrate where nothing can say stop.

**3. The state model is append-only, so prune / dedupe / retract / merge are unimplementable — and the codebase proves it silently.** `validateResults` returns `{completedFields: filtered}`, but the channel's reducer is a union over `[...left, ...right]` keeping max confidence (`state.ts:77-90`). Since `filtered ⊆ left`, `reducer(full, filtered) === full`. The node runs on every row of every run and **has never removed anything**. open-kb's Resolve stage is defined by exactly the four operations this model forbids.

**4. Identity is an attribute name, not an entity — the state shape cannot hold two companies.** The merge key is `r.field` (`state.ts:81`); output flattens to `result.enrichments[field.field]` (`run-enrichment.ts:296-298`); `EnrichmentResult.field: string` is a scalar attribute, so *"A competes-with B" is unrepresentable in the type system*. Two discovered companies both having `employee_count` collide on one Map key and the lower-confidence one is silently discarded.

**5. Provenance is a payload field the model fills in, not a capability the harness grants — and the harness fabricates it when the model doesn't.** `sources: z.array(sourceSchema)` has **no `.min(1)`** and `url` is `z.string()`, not `.url()` (`submit-tool.ts:52-54`) — an unsourced claim is structurally legal end-to-end. Worse: `deep-discovery-agent.ts:198` synthesizes the proving quote *from the value* (`snippet: \`${field}: ${value}\``), `person-agent.ts:181-186` promotes the value to its own source URL when the model returns prose, and the UI prints `title="${count} sources agree"` (`enrichment-table.tsx:74`) over a count of strings the model typed in one tool call. `corroboration` exists as a type at `types/enrichment.ts:31,50` and has **zero writers**. There is no fetched-URL ledger anywhere; `scrape-tool.ts:46` knows the URL it fetched and throws that fact away. And there is no reasoning field of any kind — grep for `reason|rationale|why` across tools/schemas/types/state returns nothing. open-kb's "plain-language why" has no antecedent to adapt; it must be designed from zero.

## 3. What it got right — keep these

- **`AsyncIterable<TypedEvent>` as the sole engine→surface contract** (`run-enrichment.ts:50-52`). Pull-based, so backpressure and cancellation are free; the web route's body is literally `for await (…) send(event)` (`web/app/api/enrich/route.ts:148`) and the CLI switches on `event.type` (`cli/src/commands/enrich.ts:164`). This survives the row→graph shape change intact — only the union's variants change. Best structural idea in the repo.
- **Credentials as a parameter, resolved at the surface.** `grep -rn "process.env" packages/core/src` returns **nothing**. This is the one architectural rule that survived, and it survived because it is checkable in one grep (`route.ts:111` states it as a comment). Copy the rule *and the checkability*.
- **The push/queue bridge turning N concurrent producers into one ordered stream** (`run-enrichment.ts:90-102` + drain loop `170-181`). Indifferent to whether there are 30 producers or 300; transplants directly onto a frontier.
- **Commutative, order-independent merge reducer** (`state.ts:77-90`). The *shape* is correct — any number of parallel writers is safe. Only the key (`r.field`) and the append-only semantics are wrong.
- **Batch-first tool schema**: `queries: z.array(z.string()).min(1).max(10)` (`search-tool.ts:33-37`) with cross-query URL dedupe (`serp.ts:48-58`). One model turn = a whole breadth-first wave. This is *already* the right frontier-expansion primitive.
- **Error-as-tool-output**, written as instructions to the model rather than stack traces (`scrape-tool.ts:22-27, 50-55`), plus pre-flight URL validation before spending money.
- **Locate-or-fetch with a path guard** (`linkedin-tool.ts:12-29`): SERP for `site:linkedin.com/company`, then `r.url.includes("linkedin.com/company/")`. The **only** place in the repo where a hallucinated URL is structurally impossible. This is the correct template for open-kb's entire Navigate stage.
- **`Promise.allSettled` + degrade-to-log** (`graph.ts:134, 160-166`). Mandatory when most expansion probes will fail.
- **The demo quota** (`web/lib/demo-mode/quota.ts:34-74`): atomic `BEGIN IMMEDIATE` reservation *before* work, `granted = min(requested, remaining)`, three-state return (ok/partial/blocked), fail-closed with the reasoning written down in the source. This is a **correct budget enforcer wearing the wrong unit, standing in the wrong package**.
- **The `wrapToolCall` middleware seam** (`progress-middleware.ts:14-30`) and per-run dependency threading via `config.configurable` (`graph.ts:31-32`). Both seams are in exactly the right place; the author hung nothing but log strings on them.
- **Structured output via `responseFormat: toolStrategy(zodSchema)`** — the codebase's own verdict on transcript-scraping, stated at `deep-discovery-agent.ts:36-37`. The migration is 3-of-9 done; finish it in open-kb by never shipping the old mechanism.
- **`schemas/extraction.ts:185-196`** — the runtime schema builder emitting value/`_confidence`/`_sources: {url,quote}[]`. Correct shape, written, exported, never called by anything. Resurrect the shape, tighten the schema.

## 4. The shape change

**Grid work: the denominator exists before the first LLM call. Frontier work: there is no denominator, ever.**

In open-enrich the size of the job is known so completely that the engine *enumerates it as events before doing any work* — `for (let i = 0; i < rows.length; i++) yield {type:"pending", rowIndex:i, totalRows: rows.length}` (`run-enrichment.ts:83-85`). Everything downstream inherits that certainty: the CLI's progress bar is `completed/total` (`io/progress.ts:142`), the pre-run cost estimate is `rows.length * 6 * 0.0015` (`cli/src/commands/enrich.ts:110-111`), the concurrency loop bound is `rows.length` (`run-enrichment.ts:118-146`), the output writer drains `while (buffer.has(nextExpected))` on a dense integer keyspace (`cli/src/io/output.ts:43-55`), and resume is "count the lines already written." Every one of these is a correct engineering decision *for a rectangle*.

**Before:** the caller hands the engine N × M cells. The engine's job is to fill cells. Parallelism is a window over an array. Completion is "all cells attempted." Cost is linear in N. A row that discovers something interesting has nowhere to put it. Failure is a cell-level fact.

**After:** the caller hands the engine *one seed*. The engine's job is to **decide what to look at next**, forever, until something makes it stop. The work list is created by the work: scraping stripe.com/docs yields the primitive "card-fraud scoring on the authorization path," which yields four queries, which yield six candidate companies, three of which are already in the graph under different names, one of which is a payment-infrastructure vendor whose own docs reveal two more primitives. Parallelism is a pool pulling from a queue that other workers are pushing into. Completion is a *judgment* — budget spent, depth reached, or new-entity yield fell below a floor. Cost is unbounded by construction and must be *reserved*, not observed. Failure is normal and expected: most expansion probes return nothing useful, and the run must be unbothered.

Three consequences that are easy to under-weight:

1. **Progress can no longer be a fraction.** The only thing with a known denominator at t=0 is the *budget*. Emit `discovered`, `outstanding` (frontier depth), and `spent/ceiling` as three independent monotone counters. Any surface computing `completed/total` has reintroduced the grid.
2. **Termination becomes a designed object, not a property of the code's shape.** In a DAG, "when do I stop?" is answered for free. Delete the DAG and the question is suddenly load-bearing and unanswered.
3. **Redundancy compounds instead of multiplying.** In a grid, re-scraping the same page five times is a constant factor (`graph.ts:134-140` launches five agents at one company with five independent scrape tools, zero caching). In a frontier, the same docs page is reachable from many expansion paths, so a budget with no fetch cache is exhausted on re-reads rather than on coverage — the worst possible failure mode for a map.

## 5. Harness: the open questions

**Fork A — Is the frontier a reduced state channel or a mutable queue driven by a worker pool?**
The agentic-control lens argues for a `frontier` annotation channel with a commutative merge reducer (dedupe on canonical key, keep shallowest depth) — the same mechanism as `state.ts:77-90`, generalized. The work-shape lens argues for a plain mutable priority queue in run state with `while (queue.nonEmpty() || inFlight > 0)` and **no barrier** — a worker that finishes immediately pulls the next-highest-priority item. *These are genuinely incompatible.* Reduced channels buy you order-independent concurrent writes, free serialization, and a natural checkpoint; they cost you an awkward fit with a pool (a reducer merges *snapshots*, it doesn't schedule) and they drag in a framework whose scheduler you'd be fighting. A mutable queue buys you real work-stealing, immediate re-prioritization on discovery, and the ability to abort mid-flight; it costs you hand-written concurrency safety and a checkpoint you must design yourself.
**Lean: mutable priority queue + worker pool, with the *merge function* borrowed from the reducer.** Keep the commutative-merge discipline for `nodes`/`edges` (which really are order-independent accumulations) and use an explicit queue for scheduling, which is not. The batch barrier at `run-enrichment.ts:145` is the single clearest thing to not rebuild.

**Fork B — Who orders the frontier: the model or the harness?**
"Fully agentic" is a hard requirement, but budget determinism pulls the other way. Option 1: the model calls `spawn_investigation(items[])` and chooses both the items and the count (generalizing the one place open-enrich lets the model size its own work — `deep-custom-agent.ts:92-93`). Option 2: the harness scores every frontier item (seed distance, relation-type weight, source authority, novelty) and pops deterministically; the model only *proposes* items and supplies the reasoning. Option 1 buys the "the model decides strategy" property that is the point of the project and costs reproducibility and predictable spend. Option 2 buys a run you can explain, cap, and diff between two executions on the same seed — and costs the honesty of the agentic claim.
**Lean: model proposes with a priority hint and a stated reason; harness owns the pop.** The model's agency is real (it decides *what exists* on the frontier and why), and the harness keeps a lever that a budget can actually pull. Be explicit that this is the compromise and where the line sits — this is the single question most likely to be re-litigated later.

**Fork C — What does "done" mean, and how many stop conditions ship in v1?**
Options: (a) budget-only — spend until dollars/ops run out, always return partial; (b) budget + structural caps (max depth, max nodes, frontier empty); (c) all of the above plus **convergence** (`newEntitiesInLastN / poppedInLastN < yieldFloor`). Budget-only is one number, trivially explainable, and produces maps whose size is a function of spend rather than of the domain — stripe.com and a 6-person startup cost the same and produce equally-sized graphs, which is wrong. Convergence is the only condition that reflects the *territory*, but it is a tuned heuristic that will fire early on sparse ecosystems and never on dense ones.
**Lean: ship (b) in v1 with the convergence hook stubbed and measured but not enforced.** Emit `{type:"terminated", reason}` as a distinct typed variant per condition from day one — the reason is the most valuable thing the run tells the user about its own output, and adding a variant later is a four-surface change.

**Fork D — One agent context that fans out via batch tools, or N independent agent contexts in a pool?**
Single context: the model sees the whole map as it grows, so dedupe and cross-referencing are free (it *knows* it already saw this company), and expansion is one big batch tool call per wave. Cost: the context window is the ceiling on graph size, and a wave is serialized behind one model turn. Pool of contexts: real parallelism and no window ceiling, but each worker is blind to what siblings found, so entity resolution moves entirely into the harness and redundant fetches multiply — exactly the failure at `graph.ts:134-140` where five agents independently scrape the same homepage.
**Lean: pool, with a shared run context object (`{fetchCache, searchCache, visited, budget, signal}`) threaded into every tool call.** The `config.configurable` pattern at `graph.ts:31-32` is the right transport; the mistake to avoid is putting *nothing but observability* in it.

**Fork E — Is the event stream the state, or a projection of it?**
Event-sourced (nodes/edges/evidence are derived by folding the event log) buys you a free partial-result guarantee, a free debug artifact, and a resume story for nothing; it costs you a fold on every read and the discipline that no mutation may bypass the log. State-first with events as a projection is simpler to write and is what open-enrich does — and it is why the web surface has no partial result at all when the tab reloads, while the CLI does (`io/output.ts:43-55`) only because someone wrote a reorder buffer by hand. Note the tension with FRESH-MAP-PER-REQUEST: the cost lens wants resumability in core; the work-shape lens says ship *no* resume rather than a positional one that silently skips work.
**Lean: event-sourced log as the canonical artifact, no resume in v1, and say so out loud.** Emit `node_discovered` / `edge_discovered` / `evidence_attached` incrementally — never one terminal graph blob — so the partial map at the instant of termination is already fully materialized on the consumer side. Resume then becomes a later feature that costs almost nothing, rather than a rewrite.

## 6. Tool contract: the open questions

**Fork 1 — How does a tool signal partial success?**
open-enrich has three inconsistent conventions: caught→in-band JSON (`scrape-tool.ts:50-55`), uncaught→thrown (`search-tool.ts` has no try/catch at all), and service-level null-erasure that collapses 404/blocked/timeout/empty into one indistinguishable case (`web-unlocker.ts:46`, `web-scraper.ts:48`). Options: (a) universal error-as-data — every tool returns `{ok:false, reason, retryable, hint}` and never throws, so the model adapts; (b) a typed `Result<T, ToolError>` union parsed by the harness, with the *harness* deciding whether the model ever sees the failure. (a) maximizes model agency and is the pattern the repo already got right in 2 of 7 tools; it also means a budget-exhausted refusal can be delivered in-band so the model degrades into *finishing* rather than crashing. (b) gives the harness a chance to retry, re-route, or re-enqueue without burning a model turn.
**Lean: both, layered — typed result union at the boundary, harness-owned retry/route policy, and only the residue surfaced to the model as an in-band hint written for a reader.** Partial success specifically (scraped 3 of 5 URLs, search returned 10 results but 2 were 403) must be *structurally* representable: `{ok:true, items:[...], failures:[{input, reason}]}` with positional alignment preserved — the one thing `web-unlocker.ts:88-96` does correctly.

**Fork 2 — How is provenance made structurally mandatory?**
Option (a), **evidence handles**: fetching tools write `{url, fetchedAt, contentHash, content}` into a run-scoped `EvidenceStore` and return opaque handles; `Evidence.url` is a branded type mintable only by `store.cite(handle, quote)`, which throws if the quote is not a substring of stored content. The model never types a URL into a claim. Option (b), **verify-at-merge**: the model supplies `{url, quote}` freely and the mint function checks both against the store, rejecting unverifiable claims. (a) makes hallucinated citations *unreachable*; it also makes it awkward for the model to follow a link it read inside page content, which is a normal and necessary navigation move. (b) preserves that freedom at the cost of a rejection path that must be tested and observable.
**Lean: (b) with (a)'s store underneath and a `fetch_and_cite` primitive that returns handles.** Either way, three things are non-negotiable and none of them exist in open-enrich: `sources` typed as a non-empty tuple (not `z.array()` without `.min(1)` — `submit-tool.ts:52-54`), a **single mint function with zero `?:` fallback branches** so no code path can synthesize evidence the way `deep-discovery-agent.ts:198` does, and `reasoning: string` in the *same required position* as evidence. Optional provenance fields in this codebase have a 100% non-population rate (`corroboration`, `scrapedAt`) — ship reasoning in v0 or it will never be filled.
Related, and worth deciding now: **confidence must be computed by the harness** from distinct-domain support count, source tier (docs > pricing/changelog > marketing > SERP snippet), and presence of contradicting evidence. If the model's self-report is kept at all, it lives in a separate `modelSelfReport` field that no surface renders as trust. And **contradiction is a first-class state** — `{supports, contradicts, status: corroborated|single-source|contested}` merged additively — not a merge casualty the way `state.ts:83` silently drops the loser and all of its evidence.

**Fork 3 — Are nested agents tools?**
open-enrich has both: a real in-process subagent (`deep-custom-agent.ts:74-87`, a `SubAgent` object with its own prompt and tools, spawned via deepagents' `task`) and an agent-as-tool where the agent runs in someone else's cloud (`services/deep-lookup.ts` — no LLM locally, just fetch + ~5 minutes of polling, and wired to zero agents). Options: (a) yes — `investigate(entity, goal)` is just a tool with a longer latency, which keeps one uniform contract and lets the model spawn depth freely; (b) no — sub-investigations are *harness moves*, dispatched by the pool, so the parent's context stays small and every child's spend is attributable.
**Lean: no — subagents are harness-dispatched work units, not tools.** The decisive argument is metering: `deep-custom-agent.ts:85` hands the `field-researcher` the *raw, untracked* tool pair while only the coordinator gets the wrapped ones, so the agents doing the actual research spend invisibly. Any design where a tool can secretly spawn an unbounded amount of work defeats the budget, which per §2 is the prerequisite for everything else. If a nested agent is exposed as a tool anyway, it must reserve budget from the parent's ledger before it starts.

**Fork 4 — Do tools return content, or do they return work?**
Today a tool call is a leaf: every tool ends in `JSON.stringify` and nothing re-enters the harness as new work. Option (a): tools return `{results, evidence[]}` and the model decides what becomes a frontier item (maximum agency, one extra model turn per wave). Option (b): tools return `{results, evidence[], discovered: FrontierItem[]}` and the harness enqueues candidates automatically (cheap breadth, but the harness is now doing entity extraction that the model should arguably own).
**Lean: (a), with the harness free to enqueue *cheap* structural discoveries only** (e.g. a sitemap link to `/docs`, a canonical redirect) — never entity-level claims, which must always carry model-supplied reasoning.

## 7. Repo shape

```
open-kb/
├─ .github/            workflows (see below), PR template requiring a pasted run
│                      transcript for one named seed, issue templates w/ env table.
│                      MUST NOT be the only quality gate that exists (open-enrich has
│                      exactly one workflow, release.yml, and zero tests).
├─ packages/
│  ├─ core/            @open-kb/core — the harness. Frontier, budget, stop policy,
│  │                   run context, tool CONTRACT (types only), event union,
│  │                   node/edge/evidence types + mint functions, entity resolution.
│  │                   MUST NOT contain: any provider SDK, any vendor name, any
│  │                   `process.env`, any DOM API, any HTTP/SSE framing, any prompt
│  │                   that names a data source.
│  ├─ providers/       @open-kb/providers — adapters implementing core's interfaces:
│  │                   search, fetch, LLM. One directory per vendor. MUST NOT be
│  │                   imported by core; core depends on the interface, never the impl.
│  ├─ cli/             @open-kb/cli — argv, credential resolution + on-disk store,
│  │                   TTY rendering, NDJSON. MUST NOT contain run policy (this is
│  │                   where open-enrich leaked resume, field resolution, cost
│  │                   estimation, and CSV escaping).
│  └─ web/             private, never published. Transport + presentation only.
│                      MUST NOT re-declare a core type or re-derive a run-level fact.
├─ skills/
│  └─ map-a-domain/    SKILL.md + references/ + scripts/. Contains the RITUAL only —
│                      zero engine facts, zero numbers, zero cost constants. Every
│                      fact comes from `open-kb plan <domain> --json` at runtime.
├─ docs/
│  ├─ adr/             one decision per file, dated. Each fork in §5-6 becomes one.
│  ├─ specs/  plans/   dated, at the ROOT — not under a surface package.
│  └─ testing.md       the two-tier boundary: deterministic vs live-web, in writing.
├─ fixtures/           recorded HTTP cassettes + golden graphs for one or two seeds.
│                      This is what makes the deterministic tier possible at all.
├─ scripts/            check-public-api, check-core-purity, bump-version.
└─ (root)              one tsconfig.base.json that ALL packages extend, .gitattributes
                       eol=lf, AGENTS.md → CLAUDE.md symlink, LICENSE, CODE_OF_CONDUCT.
```

**Dependency direction (one-way, enforced):**
`core` imports nothing from this repo. `providers` → `core` (types only). `cli` → `core` + `providers`. `web` → `core` + `providers`. `skills` → the published `cli` binary via argv and exit codes, never a TypeScript import. Nothing ever imports `web` or `cli`.

**Public surface:** a hand-written `packages/core/src/api.ts` exporting ~8 symbols (`runKbMap`, `KbEvent` schema+type, `KbGraph`/`KbNode`/`KbEdge`, `Credentials`, `RunKbOptions`, `decodeEvent`) — **not** an `index.ts` that re-exports `*`. `core` is published to npm for real, not `private: true`.

**Five things about open-enrich's layout that directly caused §2:**

1. **`core/src/index.ts` re-exports the entire implementation** — ~30 of ~40 runtime exports have zero consumers. With no public/private line, a surface author has no signal about what is safe to depend on, and the cheapest correct move became "reimplement it locally." That is the mechanical origin of three copies of identifier detection, two copies of the run-cost fold, and a byte-identical duplicate of `formatValue`.
2. **`tsconfig.base.json` puts `"DOM"` in `lib` for every package**, which is how `document.createElement` and `navigator.clipboard` ended up inside the headless engine (`csv/format.ts:201-220`) and got minified into a Node binary. `core` gets its own `lib` with no DOM; `web` adds it in its own override.
3. **Core exported primitives but not policy**, so each surface wrote its own version of every run-level decision (field resolution, limits, resume, cost total). The rule that fixes it: *if two surfaces would both need it, it is a field on `RunKbOptions` with a core default* — never surface code.
4. **`identifier/skip-domains.ts` is the accidental home of `CONCURRENT_ROWS` and `AGENT_TIMEOUT_MS`** — the two most important tuning knobs in the system, sitting above a list of Gmail-alikes. Homeless constants become dead constants (`void AGENT_TIMEOUT_MS;`). Give budget/concurrency/stop policy a module named for what it holds.
5. **Specs and plans live under `packages/web/docs/`** describing *core* work, so every path in them went stale the day the monorepo was retrofitted (one day, 17 commits) and one still hardcodes the author's home directory. Docs describing the engine live at the repo root.

**What should exist, without designing it here:** one CI workflow running (i) a public-API snapshot test on `@open-kb/core`, (ii) a purity grep — `process.env|document\.|window\.|/api/` in `packages/core/src` must be empty, (iii) `assertNever` exhaustiveness on every surface's event switch, (iv) an event-passthrough deep-equality test (no surface may rewrite an id or an event — this is what `adjustRowIndex` at `cli/src/commands/enrich.ts:193-206` was), (v) a `plan`-mode test with throwing LLM and fetch adapters that must exit 0 (open-enrich's `--dry-run` claim of "no API calls" is false precisely because nothing tested it), and (vi) a fixture-backed test asserting that a retraction *shrinks* a channel and that resolve *reduces* node count. Write these before the second surface exists — open-enrich's copies were all made in the fortnight after the monorepo was assembled.
