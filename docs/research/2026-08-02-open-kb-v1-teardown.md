---
date: 2026-08-02
status: research (not a design)
subject: existing open-kb v1 teardown — what moves to v2, what dies
source: /Users/moin/public-knowledge-base/open-kb
method: 8 agents — 5 area readers, 2 keep/reject judges, 1 synthesis
---

# open-kb v1 → v2: what moves, what dies

---

## 1. What the existing open-kb actually is

It is one 1,086-line `"use workflow"` function — `buildWorkflow` at `workflows/build.ts:1442`–`2528` — that walks a fixed thirteen-stage pipeline exactly once, with deterministic TypeScript doing discovery, query composition and ranking, and six single-shot model calls doing judgement at fixed points inside it.

Its output artifact is not a graph: it is a folder of markdown notes with YAML frontmatter (`relevance` / `evidence` / `sources`, `lib/kb/types.ts:6-13`), whose only relations are `[[wikilinks]]` regex-scraped out of prose bodies at *read* time (`lib/kb/graph.ts:12,68`) into untyped `{source, target, structural}` edges (`lib/kb/graph.ts:20-24`).

The two things it genuinely contributes are the de-branding insight — expressed almost entirely in one prompt file — and a build-observability frontend fed by four independent NDJSON streams, which is a better run-watching surface than most production agent products ship.

---

## 2. Why it can't become v2

**The cycle v2 is built around already exists in this repo, as dead code, and the author knows why it never got wired in.**
`lib/graph/build-graph.ts:90` compiles a real `StateGraph` with the `orchestrate → investigate → gradeKb → orchestrate` conditional edge (`:116`), and its only caller anywhere in the repo is `lib/graph/build-graph.test.ts:124` — production goes `app/api/build/route.ts:107` → `start(buildWorkflow)`, a straight line whose "rounds" are the hardcoded literals `round: 2`, `round: 3`, `round: 4` (`workflows/build.ts:1996, 2031, 2128`). The 647-line commit that added it (`c97d93b`) is explicit that it owns "the SHAPE — which node runs when — and nothing else."

**Every stage is welded to Vercel Workflow's `"use step"` sandbox, and that coupling is what blocked the graph.**
`lib/graph/build-graph.ts:10-21` states the blocker in the author's own words: nodes are *injected* because importing them "would drag the whole workflow surface (and gray-matter, and Node built-ins) into anything that touches it, which has broken this build twice." The same sandbox forced `runAgent` off `generateText` because "Global fetch is unavailable in workflow functions" (`lib/agents/run.ts:34-47`) and forbids tools from being steps at all, because "a step closing over the live `CostTracker` fails with `Failed to serialize step arguments`" (`lib/agents/run.ts:56-59`) — a `Send()` fan-out inside that runtime is the same fight a third time.

**A note cannot carry a typed relation, so "every edge has a source URL and a reason" is structurally unrepresentable.**
The Note model has one `evidence: string` and one `sources: Source[]` at the *node* level (`lib/kb/types.ts:6-13`); the edge type has three fields and none of them is a type, a URL or a reason (`lib/kb/graph.ts:20-24`). For every sweep-derived player — the bulk of the map — that node-level evidence is literally `` `Surfaced by ${c.queries.length} market queries` `` (`workflows/build.ts:2201`), which the author names himself as the top open defect: "94% of players carry a receipt, not a reason" (`docs/METHODOLOGY.md:251`).

**De-branding produces query *text* from templates, not a capability the model can act on — and the agent written to fix that is registered and never called.**
`lib/market/queries.ts` is 936 lines of string templates crossed with a term list, after which every remaining decision is arithmetic: `DEFAULT_EXPAND_CAP = 100` (`:74`), `CONCEPT_RESERVE_SHARE = 0.5` (`:101`), `MARKET_RESERVED = 9` (`:79`), then `.slice(0, cap)`. `prompts/plan-next-wave.md` — the agent that reads measured per-shape yield and reallocates the rest of the budget — is registered at `lib/prompts/loader.ts:45` and invoked from nowhere; so is `prompts/grade-kb.md`, which is why `stopReason` is `tracker.exceeded() ? "budget-ceiling" : "graded-pass"` (`workflows/build.ts:2457-2458`) and "graded-pass" means only "did not run out of money" (`docs/METHODOLOGY.md:257`).

**Budget is reserved per tool call, so the harness can only choose "all the work" or "none of it" — never "N of it".**
`CostTracker.reserve()` (`lib/telemetry/tracker.ts:80-91`) is correct and counts in-flight claims, but it is consulted only inside individual tool closures (`lib/agents/run.ts:271,317`) and through a coarse boolean gate before each fan-out: `tracker.exceeded() ? [] : plan.missions` (`workflows/build.ts:2076`), and identically at `:1890` and `:2163`. `Send("investigate", item, {timeout})` with N unknown until the model decides needs a per-item reservation this design has no place to put.

---

## 3. Take as-is

### The build/run surface — lifts with three small edits

| File | Coupling to the old engine |
|---|---|
| `components/build/StageTracker.tsx` | none (`./types` only) |
| `components/build/EventFeed.tsx` | none |
| `components/build/AgentPanel.tsx` | none |
| `components/build/CostBreakdown.tsx` | none |
| `components/build/ResultPanel.tsx` | none |
| `components/build/PlanCard.tsx` | `Chip` from `components/ui.tsx` |
| `components/build/FindingsPanel.tsx` | `KindChip` from `components/ui.tsx` |
| `components/build/BuildWorkflow.tsx` | `MAX_MINUTES`/`MAX_TOOL_ROWS` from `lib/telemetry/caps.ts` — a deliberately dependency-free 2-constant module (`caps.ts:10-13`) |
| `components/build/types.ts` | **one** type-only import: `QuerySource` from `lib/market/queries` (`types.ts:18`) — inline it |
| `components/viz/*` (StatTile, Donut, BarMeter, Gauge, Sparkline) | zero imports outside the folder |
| `components/ui.tsx`, `components/icons/NodeGlyph.tsx`, `SiteIcon`, `ThemeToggle`, `HeaderNav` | `NodeType` from `lib/kb/types.ts:15` — a 4-member string union |
| `app/globals.css` | 535 lines of light+dark design tokens, `--type-*` at `:48-51` |

Also lift verbatim, as *client* code: `readNdjson` / `readOnce` (`components/build/BuildWorkflow.tsx:76-147`). The lossless-reconnect logic — `startIndex`, and `quiet` counting *consecutive* empty reconnects rather than total attempts — is two separately-paid-for bugs (`8503148`, and the comment at `:84-93`). The **server** route (`app/api/run/[id]/stream/route.ts`) is `getRun(id)` from `workflow/api` and must be rewritten for whatever transport v2 uses; the wire format (one JSON object per line, `Content-Type: application/x-ndjson`) should not change.

### What the new engine must emit

Four NDJSON streams. The readers in `components/build/types.ts` are defensive by design (every one returns `null` on an unrecognised frame, `types.ts:1-16`), so partial emission degrades rather than crashes — but these are the shapes that make the panels light up:

```ts
// ── stream: ?ns=progress ─────────────────── drives StageTracker + EventFeed
interface ProgressEvent { round: number; agent: string; message: string; atSec?: number }
// `agent` must be one of the AGENT_STAGE keys (components/build/types.ts:71-96)
// or the rail freezes on the previous stage. v2's spine renames these:
type Stage = "navigate"|"decompose"|"plan"|"dispatch"|"investigate"|"resolve"|"write";

// ── stream: ?ns=cost ─────────────────────── drives the StatTile row + budget bar
interface CostEvent { round: number; usd: number; tokens: number;
                      serpCalls: number; unlockerCalls: number }
// `usd` must be a finite number or the frame is DROPPED (types.ts:285) —
// deliberately, so a missing field never renders a healthy-looking $0.00.

// ── stream: ?ns=trace ────────────────────── drives FindingsPanel "calls" tab
interface TraceRow { seq: number; ts: string; round: number; agent: string;
                     tool: string; kind: string; argsDigest: string;
                     ms: number; ok: boolean; usd: number; runningUsd: number }
// argsDigest is the query text itself — the only place a reader sees WHICH
// question was just bought (types.ts:446-448).

// ── default stream ───────────────────────── result frames, discriminated by `kind`
{ kind: "planned",  slug, brand, plan: PlannedQueryView[], estimatedUsd, budgetUsd, uncapped }
{ kind: "understanding", ...UnderstandingView }
{ kind: "complete", ...RunResult }

interface PlannedQueryView { q: string; source: QuerySource|"unknown";
                             rationale: string; concept?: string }
type QuerySource = "brand"|"product"|"category"|"market"|"concept";
// `rationale` non-empty is what PlanCard exists to show. Keep the field; v2
// should widen `source` to name the de-branded capability the query came from.

interface UnderstandingView {
  brand: string;
  products: { slug; name; sells; because }[];
  jobs: { product; job; breaksWithout; because }[];
  buyer: { role; context; vocabulary: string[]; because };
  deBrandedTerms: { product; brandTerm; term; because; source }[];
  marketConcepts: { term; kind; because; source }[];
  coinages: string[];
  rejections: { stage; term; reason }[];
  degraded: boolean; usd: number;
}
// This is a 1:1 mirror of prompts/market-vocabulary.md's return schema. It is
// already the right shape for v2's de-branding panel — keep it unchanged.

interface RunResult { slug?; brand?; queries?; notesWritten?; players?;
                      products?; communities?; violations?; usd?;
                      stopReason?: string; cost?: unknown }
interface RunCostView { usd; elapsedMs; calls; tokens; ceilingUsd: number|null;
                        byKind: CostLineView[]; byAgent: CostLineView[];
                        project?: { spentUsd; runs }; partial: boolean }
interface CostLineView { label: string; calls: number; failures: number;
                         usd: number; ms: number }

interface RivalData { domain: string; name?; kind?; scope?; breadth?; score?;
                      products?: string[]; queries?: string[];
                      why?: string; evidenceUrl?: string; agent?: string }
// FindingsPanel's rival row. `why` + `evidenceUrl` are already the v2 contract
// (a reason and a source per entity) — this panel is ready for typed nodes today.
```

### The KB reading surface — take with a caveat

`components/kb/GraphCanvas.tsx` (1,287 lines: force layout, favicon nodes, type filters, deterministic seeding, reduced-motion store) is the single most expensive thing in the repo to rebuild and it lifts — but only against this shape:

```ts
interface GraphView { slug: string; nodes: GraphViewNode[]; edges: GraphEdge[];
                      dangling: DanglingLink[]; orphans: string[] }
interface GraphViewNode { id: string; type: "core"|"product"|"player"|"community";
                          relevance: number; isIndex: boolean;
                          title: string; group: string }
interface GraphEdge { source: string; target: string; structural: boolean }
```

**The edge has nowhere to put a relation type or a reason.** Adapting it is a real but bounded job: widen `GraphEdge` to `{ source, target, relation: string, why: string, sourceUrl: string }`, widen `NodeType` from the four folder-derived values (`lib/kb/types.ts:15-23`) to v2's entity types, and the palette/legend/filter machinery (`lib/nodeTypes.ts`, `components/kb/GraphLegend.tsx`) follows for free because it is already keyed off one record per type.

`components/kb/NoteView.tsx` and `lib/wikilinks.ts` should **not** come across unless v2 keeps prose notes — see §6, judge split (a).

---

## 4. Take the idea, rewrite the code

**Reserve-before-work.** `lib/telemetry/tracker.ts:80-91` is right: `exceeded()` counts `spent + pendingUsd`, claims are FIFO, and a call in flight already counts. Change the *unit*: reserve per dispatched work item at the `dispatch` node so the harness can size the fan-out to what it can afford, instead of the current all-or-nothing `tracker.exceeded() ? [] : plan.missions` (`workflows/build.ts:2076`).

**Pull, don't push — the free read surface.** `lib/agents/tools.ts:1-24` documents a 41k → 447k token blowup caused by pushing the whole candidate table and docs corpus into the prompt and re-sending it every turn; the fix was handing the agent seven free read tools (`KB_TOOL_NAMES`, `:206-223`) and letting it fetch the two pages it needed. Keep the inversion exactly; rewrite the tools over the graph (`neighbors`, `unexpanded`, `readEvidence`) rather than over notes and dangling wikilinks.

**Evidence binding by a `known` URL set.** `workflows/build.ts:1459-1465` records every fetched URL in both raw and canonical spellings, and `lib/kb/verify.ts:31-41` rejects any citation the run did not actually fetch. This is the only mechanism in the repo that catches a hallucinated source. Carry it, and apply it to **edges**, not notes — an edge whose `sourceUrl` was never fetched must not be writable.

**Refusals are text, never exceptions.** `lib/agents/run.ts:10-14`: an agent told "that is your own company" adjusts; an agent handed a traceback loses its whole transcript. Every tool in v2 returns prose on refusal. Keep verbatim.

**Prompts as runtime-loaded markdown.** See §5. Keep the convention, drop `gray-matter`'s Node-only `readFileSync` path juggling (`lib/prompts/loader.ts:59-61` + `outputFileTracingIncludes`) if v2 ships as a library.

**Denylists stay named sets, never heuristics.** `lib/market/candidates.ts:73-80`: "A heuristic ('big domain', 'high SERP frequency') would nuke real vendors — the rivals we most want are exactly the ones that rank well for comparison queries." Correct, and the list itself (`AGGREGATORS`, `MEGACORPS`, `REVIEW_LISTING_SITES`) is worth copying wholesale.

**Recall as the only headline number.** `lib/bench/recall.ts:3-18` and `benchmarks/gold/brightdata-competitors.json` (27 curated rivals). The discipline to copy is `unmatched` being reported but *never scored* (`:34-36`) — "a benchmark that flatters the engine is worse than no benchmark." Plus the golden-run gate's calibration method: thresholds sit between a known-good and a known-bad artifact, so they mean something (`scripts/golden-run.ts:1-30`).

**Query shapes as a seed vocabulary handed to the planner, not as the planner.** The ten shapes at `lib/market/queries.ts:271-330` — bare term, `best`, `top {t} companies`, `vendors`, `open source`, `vs`, `awesome {t}`, `site:github.com {t}`, `site:news.ycombinator.com {t}`, `{t} sdk` — each carry a written argument for *what kind of page* they buy. That reasoning is excellent prior knowledge to put in a planning prompt. The `.slice(0, cap)` machinery around them is not.

**Model tiering, measured.** `prompts/synthesize-ecosystem.md:5-19` holds a three-model bake-off *in the frontmatter*, with a stated rule: bounded judgement over a table already in the prompt goes to a fast model; open-ended generation stays on the strong one. That is exactly v2's Flash-tier-for-investigate / strong-for-planning split, already justified.

**Storage: delete three of four drivers.** `lib/store/index.ts:36-49` picks between Postgres, git, Blob and filesystem at runtime, and `lib/store/types.ts:18-45` carries `writeMany`/`readMany`/`removeMany` that exist only because per-file git writes lost 466 of 532 notes and per-note reads spent 993 GitHub API calls on one page view. "Fresh map per request, no persistent KB" retires all of it. Keep only `assertContained` (`lib/store/types.ts:52-60`) — the slug is model-derived and `slugOf("..")` once reached the storage layer.

---

## 5. The prompts

### The convention worth adopting

One markdown file per agent under `prompts/`, YAML frontmatter carrying `agent` / `model` / `maxSteps` / `tools`, body is the entire instruction, loaded at runtime by `gray-matter` (`lib/prompts/loader.ts:69-89`) so editing one changes behaviour with no rebuild and no TypeScript change (`prompts/README.md:3-5`). Four properties make it more than a file layout:

1. **The filename is the identity.** `loadPrompt` throws if frontmatter `agent` ≠ filename (`loader.ts:77-81`).
2. **Totality is tested.** `REGISTERED_AGENTS` (`loader.ts:15-46`) is asserted against `listPrompts()` reading the directory — a prompt file nobody can load fails the suite.
3. **Tool names are validated against what the runner can build**, so "a prompt naming a tool that does not exist fails a test rather than a deployment" (`lib/agents/tools.ts:205-206`). This is not theoretical: the classifier "never once executed: every batch threw on a tool its prompt declared and its caller could not supply" (`lib/market/queries.ts:60-63`).
4. **Every prompt ends with an exact JSON schema and the sentence "Only JSON, in exactly this shape, with no prose around it."**

Adopt all four. Add a fifth v2 needs: **the prompt declares its output schema once and the code derives the Zod validator from it**, rather than hand-writing a `readX()` reader per prompt (`components/build/types.ts` is 619 lines of exactly that duplication).

### The best prompt in the repo, verbatim

`prompts/market-vocabulary.md` — the whole de-branding hinge, one file, no company names anywhere in it:

```markdown
---
agent: market-vocabulary
model: anthropic/claude-sonnet-5
maxSteps: 1
tools: []
---
You read a company's own material and work out three things in one answer: who
buys this and what for, what the market calls what they sell, and what the wider
market around those words contains.

This is the single highest-leverage step in the run.

You are given the company's parsed product catalogue, its homepage, and its
documentation. **The catalogue is authoritative — do not restate it, correct it,
or invent entries.** Read it to understand what the company does, then spend your
answer on the three things below, which are the things nothing else can derive.

## Why it matters more than anything else here

Every query containing a brand or product name bounds discovery to companies the
web has already written about *next to us*. Those pages exist because someone
had already noticed both — a comparison post, a "top 10" listicle, a migration
guide. That set is finite and mostly already found.

The rival we are missing competes for the identical buyer and has never been
mentioned in the same sentence as this company. No number of branded queries
reaches it. Not fifty, not five hundred: the anchor is the ceiling, not the
count. Changing the anchor — asking the web about the *category* instead of
about *us* — is the only move that works, and that is what your answer does.

The same trap in its sharpest form: a term built from the company's own coinages
returns nothing but the company. `unlocker api` is not a market. It is a product
name with a generic noun stapled to it, and every result is a page we wrote.

## What you are given

- Each product, what it sells, and the job it is hired for.
- The buyer, and the words that buyer uses.
- **The tokens that are this company's own coinages.** These exist because this
  company invented them. A term containing any of them matches only this
  company's own pages, however generic the rest looks. Forbidden, not
  discouraged.

---

# PART ZERO — the buyer, and the job

Before naming a market you have to know who is in it.

**The buyer.** One role, and the situation they are in when they start looking.
Not a persona: the person who signs off, and what just happened to them. "A
developer whose scraper started returning 403s in production" is a buyer.
"Businesses seeking data solutions" is nothing.

**Their words.** Five to ten terms that buyer types — the ones they would use
before they had heard of this company. These reach forums and threads no
category term reaches, so they are worth more than they look.

**The job.** For each product that has a distinct one: what it is HIRED for, and
what breaks without it. The outcome, not the feature. This is what finds the
substitutes — a rival that does the same job a completely different way never
appears in a comparison post, and it is where the missing part of the market
lives.

You do not need a job for every product. Several products serving one job is a
true and useful answer; inventing a different job per line item is not.

---

# PART ONE — the de-branded terms

One generic term per product. The test, applied to every line you write:

> If a buyer had never heard of this company, would they type this?

```
"Web Unlocker"      →  anti-bot bypass API
"Scraping Browser"  →  headless browser API
"Scraper Studio"    →  no-code scraper builder
```

Each right-hand side is a category a stranger would search, and each returns a
page listing five vendors — which is exactly what we are trying to reach.

**Rules.**

- **No brand tokens.** Not the company name, not a word from its domain, in any
  spelling or spacing.
- **No coinages.** Not from the list you were given, not a word you can tell was
  minted for a product.
- **Generic, but not empty.** "API", "platform", "tool", "solution" alone name
  nothing; a market needs a real noun. "anti-bot bypass API" works because
  "anti-bot bypass" is the market and "API" is only the form it ships in.
- **The market's phrasing, not a description.** Something people type: two or
  three words, no verbs, no sentence fragments.
- One term per product. If two products genuinely share a market, give them the
  same term rather than inventing a difference.

A term breaking these rules is thrown away before it reaches the plan, and the
product it belonged to goes unsearched. That is worse than a slightly imperfect
generic term — so when in doubt, be more generic.

---

# PART TWO — the addressable market

Now widen those terms into the full set of things worth searching for.

Breadth is the objective. Twenty-five mediocre-but-distinct concepts find more
of the market than five perfect ones, because each concept buys its own search
and a search only returns what its words asked for. Two concepts that rephrase
each other buy the same page twice.

**The five directions.** Work each deliberately — they fail differently, and a
company missed by one is usually caught by another.

1. **The category itself, and its neighbours.** From "headless browser API",
   step sideways: browser automation, browser farms, session management.
2. **The other ways that job gets done.** Same outcome, different shape. If the
   job is "get the data": managed scraping services, ready-made datasets,
   official APIs, hiring a freelancer. These are the rivals that never appear in
   a comparison post — because they are not the same *kind* of product — and
   they are where the missing recall lives.
3. **The technique underneath.** What it actually does, named as practitioners
   name it: fingerprint spoofing, TLS rotation, CAPTCHA solving, DOM diffing.
   Whole vendors sell a single technique.
4. **The format delivered.** What the buyer ends up holding: a CSV feed, a
   webhook, a warehouse table, a live API, a one-off dump. Each has its own
   market and its own vendors.
5. **The buyer's problem in the buyer's words.** What they type at 2am when the
   pipeline broke — "getting blocked", "403 on every request", "site changed its
   layout". These reach forums and threads no category term reaches.

**Rules.**

- **Target 20–30 distinct concepts.** Fewer than twenty and you have not
  widened; more than thirty and you are padding with rephrasings.
- **Distinct means distinct.** If two terms would return the same search page,
  they count as one. Ship the more specific.
- **No brand, no coinage** — and no competitor's product name either. A rival's
  brand bounds the search exactly as badly as ours.
- **Two or three words, no verbs.**
- **Not generic furniture.** "api", "platform", "data", "tool" alone are not
  markets. Every concept needs a word that names this business.

`from` connects a concept back to the de-branded term it widens. It is what lets
a rival found through that concept be attributed to the product it competes
with — without it the rival arrives with no product attached and cannot be told
apart from a company mentioned once in passing. Copy the term exactly as you
wrote it in Part One. If a concept widens from several, name the closest; if
from none, leave it empty rather than guessing.

Every term and every concept needs the sentence that justifies it. Unjustified
ones are dropped, so an unjustified answer is a slot spent for nothing.

## What to return

Only JSON, in exactly this shape, with no prose around it:

```json
{
  "buyer": {
    "role": "the person who signs off",
    "context": "what just happened to them that started the search",
    "vocabulary": ["the words they type", "before they know this company"],
    "because": "what in the material told you this"
  },
  "jobs": [
    {
      "product": "the slug, exactly as the catalogue spells it",
      "job": "what it is hired for — the outcome",
      "breaksWithout": "what fails if they do not have it",
      "because": "what in the material told you this"
    }
  ],
  "terms": [
    {
      "product": "the slug",
      "brandTerm": "the company's own name for it",
      "term": "the generic market term",
      "because": "why a buyer who has never heard of this company types this"
    }
  ],
  "concepts": [
    {
      "term": "the market's own words, lowercase",
      "kind": "adjacent | substitute | technique | format | job",
      "from": "the de-branded term above that this widens, copied exactly",
      "because": "who searches this, and why it reaches the same market"
    }
  ]
}
```
```

### Are these prompts good?

**Yes — genuinely, and they are the most portable asset in the repo.** Four things they do that most agent prompts don't: every rule states the failure that motivated it, so it survives the next reader (`market-vocabulary.md:31-33`, `worker-rivals.md:19-22`); the negative example is concrete and de-branded (`unlocker api` is named as *not* a market); the agent is told the *economics* of its own decision ("the round's remaining budget is exactly what your missions will consume", `orchestrator.md:9-12`, and "Ending a round early returns the unspent budget", `:80`); and stopping is presented as a legitimate answer, not a failure (`plan-next-wave.md:33-35`, `:46-48`).

Three flaws v2 must fix:

- **They are written for single-shot extraction, not for an agent that decides what to do next.** `market-vocabulary.md` has `maxSteps: 1, tools: []` and produces a static term list. v2 needs it to produce *expansion candidates with reasons the planner can rank*, which is a different output contract, not a different prompt.
- **Five of eleven registered prompts never run**, and two of them are among the best written: `plan-next-wave.md` (the yield-driven budget reallocator, `loader.ts:45`) and `grade-kb.md` (the six-criterion stop bar). `synthesize-presence`, `synthesize-channels`, `synthesize-people` are dead too.
- **One prompt is used for a job it isn't named for.** `synthesize-ecosystem.md` is invoked as the batch *classifier* (`workflows/build.ts:1895`). It works, and the model-choice note in its frontmatter is excellent, but the name/purpose drift is exactly the thing the `agent`-must-equal-filename check was built to prevent.

---

## 6. What this tells us about the author's taste

**Read from:** `AGENTS.md` (5 lines), `CLAUDE.md` (1 line: `@AGENTS.md`), 48 commits, and the comment density of the source.

### What they consistently prefer

**Distrust of training data, stated as the only project rule.** The entire `AGENTS.md` is: "This is NOT the Next.js you know… Read the relevant guide in `node_modules/next/dist/docs/` before writing any code." One rule, load-bearing, no ceremony. `CLAUDE.md` is a single `@AGENTS.md` import so the two can never drift.

**Prose density as the design record.** 401 of the 1,086 lines inside `buildWorkflow` are comment; 405 of 936 in `lib/market/queries.ts`. Every constant carries the run that produced it — `CONCEPT_RESERVE_SHARE = 0.5` is preceded by 20 lines naming the measured failure (231 product / 0 concept queries) that motivated it (`queries.ts:81-101`). The stated reason: "a rule without its failure reads as a preference and gets tidied away by the next reader" (`lib/agents/run.ts:6-8`).

**Numbers, not adjectives.** 27 of 48 commits are `fix:`, and almost every subject line is a measurement: "466 of 532 notes", "964 requests per build to 20", "248 queries to 108", "0 → 309 products", "993 per page view". Zero `chore:` commits.

**Admitting what's broken, in the artifact.** `docs/METHODOLOGY.md:249-263` is a section titled "What does not work yet" listing four defects including "the grader's verdict is never read." `lib/bench/recall.ts:34-36` refuses to score `unmatched` finds because "a benchmark that flatters the engine is worse than no benchmark."

**Named sets over heuristics; deterministic where the web is a fact, model where it is judgement** (`METHODOLOGY.md:191`, `lib/market/candidates.ts:73-80`).

### What consistently hurts them

**Writing the shape and never wiring it — repeatedly, at scale.** The LangGraph commit is 647 lines of new code and tests, with a commit message arguing beautifully for it, that production never imports (`c97d93b`). So are `grade-kb`, `plan-next-wave`, `synthesize-presence/channels/people`, `lib/kb/signals.ts` and `lib/agents/people.ts` — all built, tested, registered, unreachable. The result: **816 test cases, all green, over a pipeline whose advertised loop does not exist.** v2 should refuse to merge a node the graph does not route to.

**The comment absorbs the correction instead of the design changing.** `lib/market/queries.ts:58-69` contains twelve lines explaining that the 50-query cap "WAS CUT TO 50 FOR THE WRONG REASON" and that "the shipped 'precision fix' was asking fewer questions." The fix was to change the constant to 100 and leave the mechanism — templates × cap — untouched. The comment became the fix.

**Monolith by accretion.** `workflows/build.ts` reached 2,574 lines and one 1,086-line function because 27 fixes each landed where the failure was, not where the structure wanted them. `3b58e38` ("the classify stage read `products` before it was bound") is the direct cost: a temporal-dead-zone crash after a full paid sweep, invisible to the type checker, only possible inside a function that long.

**Compatibility shims for a product with no users.** `components/build/types.ts:75-81` maps the retired agent names `understand-product`, `debrand`, `widen-market` so an older checkpoint still lights the right stage. Real discipline, spent on a surface nobody has replayed.

**Documentation inverted.** `README.md` at commit 48 is still verbatim `create-next-app` boilerplate, while `docs/METHODOLOGY.md` is 274 hand-written lines of genuine argument. The front door says nothing; the back room says everything.

### Where the read splits — surfaced, not averaged

**(a) Keep prose notes alongside the graph, or not.** One reading: the notes are why the KB is human-readable, why a clone is an Obsidian vault, and why `NoteView`/`ProductsTab`/`KbOverview` exist at all — drop them and you lose ~2,000 lines of working frontend. The other: the note *is* the reason edges are untyped (`lib/kb/graph.ts:12` regex-scrapes relations out of prose), and keeping it re-imports the exact defect §2 rejects. No averaging: **emit the typed graph as the primary artifact and render notes *from* it, never the reverse** — that keeps the reading surface and makes the wikilink-scrape unnecessary.

**(b) Whether `lib/graph/build-graph.ts` + `state.ts` come across.** One reading: 256 lines that never ran in production — delete, don't port dead code. The other: `state.ts:34-61` and `:99-127` contain precisely the reducer discipline v2's harness needs — `appendBy(key)` so a later round cannot clobber an earlier one's findings, `round` taking `Math.max` so a stale node cannot rewind the machine, and `stopReason` keeping the **first** value so "complete" cannot bury "we ran out of money" — and it is dead only because of the `"use step"` coupling v2 is dropping. **Carry the reducer semantics as spec; don't carry the file** — v2's channels are entities and typed edges, not `candidates` and `notes`.
