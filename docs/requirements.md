# open-kb — requirements

Living document. Everything locked so far, in one place, so the build has a spec to check itself
against. Research that led here lives in `docs/research/`. Decisions get their own ADR in
`docs/adr/` once the design lands.

---

## What it is

Give it one company web domain. Get back a map of the market around that company — companies,
products, capabilities, and the typed relations between them — where **every node and every edge
carries a source URL and a plain-language reason.**

The hinge is **de-branding**: reduce products and companies to brand-free primitives before any
matching happens. *"Stripe Radar" → "card-fraud scoring on the authorization path."* You cannot
find a competitor by name, only by what it does.

---

## Locked decisions

| | |
|---|---|
| Run model | Fresh map per request. No persistent KB, no cross-run entity resolution. |
| Control | Orchestrator spawns agents holding a skill + tools + one target, and says go. Not a staged pipeline. |
| Agency | The model decides: what a company sells, how to de-brand it, what to search, what to read, what to expand, when to stop. |
| Harness | The harness owns limits only: budget, dedupe, evidence binding, concurrency, timeouts. |
| Parallelism | Default, not an optimization. Accepted cost: a heavier system. |
| Generality | Tools stay dumb and general. Knowledge lives in the skill. No web convention hardcoded in the engine. |
| Build order | Web demo first. The skill ships later over the same architecture. |
| Stack | TypeScript. LangGraph for orchestration. OpenRouter for models. Bright Data SERP + Unlocker for data. |
| Escape | Must not run inside Vercel Workflow's `"use step"` sandbox — that is what killed v1's orchestration. |

---

## Provenance — every claim is debuggable

A claim with no evidence must be **structurally impossible to write**, not merely discouraged.
v1's schema allowed it (`sources` had no minimum, `url` was a bare string), and the harness
synthesized evidence when the model failed to supply it. That must not recur.

Every node and every edge carries:

| field | what it holds | why |
|---|---|---|
| `what` | what it is / what it sells, and to whom | description |
| `relation` | `competitor` · `substitute` · `dependency` · `integration` · `shaper` | direct vs indirect vs key player, distinguishable |
| `why_here` | why it belongs on **this** map, stated against the anchor | **the reasoning** — not the description |
| `how_found` | the exact query or page that surfaced it | the cheapest, most legible reasoning there is |
| `evidence[]` | `{ url, quote }` — quote must appear on a page the run actually fetched | unfalsifiable citation |
| `confidence` | computed by the harness, never self-reported by the model | see below |
| `contradicts[]` | evidence pointing the other way, kept, never dropped | disagreement is signal |

**Rules:**

- Evidence is minted by one function with no fallback branch. No code path may synthesize a
  source, a quote, or a URL.
- A URL is citable only if the run fetched it. The run keeps a ledger of fetched URLs in both raw
  and canonical spellings; a citation outside the ledger is rejected.
- `confidence` is derived from distinct-domain support, source tier, and presence of
  contradicting evidence. If the model's self-assessment is kept at all, it lives in a separate
  field that no surface renders as trust.
- Contradictions are a first-class state (`corroborated` · `single-source` · `contested`), merged
  additively. A merge never silently discards the loser or its evidence.
- `why_here` and `evidence` are required in the same position in the schema. Optional provenance
  fields have a 100% non-population rate in practice.

---

## Telemetry — every action is measured

One span per tool call and per model call, emitted whether it succeeded or not.

```ts
interface Span {
  seq: number            // monotonic within the run
  ts: string             // ISO
  runId: string
  agentId: string        // which agent
  parentId: string|null  // spawn tree — who spawned whom
  kind: "model" | "search" | "fetch" | "record" | "spawn"
  name: string           // model id, or tool name
  argsDigest: string     // the query text / the URL — what was actually bought
  ms: number             // latency
  ok: boolean
  error?: string         // the reason, in words
  tokensIn?: number
  tokensOut?: number
  usd: number            // cost of THIS call
  runningUsd: number     // cumulative at this point in the run
}
```

**Rules:**

- `argsDigest` carries the real query or URL. It is the only place a viewer sees *which question
  was just bought*, and it is the most compelling thing on screen.
- `parentId` makes the spawn tree reconstructable — who spawned whom, and what each child cost.
- Cost is attributed to the agent that spent it. v1 handed sub-agents untracked tools, so the
  agents doing the actual research spent invisibly.
- Failed calls emit a span too, with `ok:false` and `error` in plain words. A silent failure that
  emits nothing is indistinguishable from work never attempted.
- Rolls up to: per agent, per relation type, per run. Cost per company mapped is the headline
  efficiency number.

**Known failure modes that must be detected, not just logged:**

- HTTP 200 with an empty body (measured: Bright Data Unlocker on `stripe.com`, 33–60s, twice).
- HTTP 200 with HTML where structured content was expected (measured: `vercel.com/llms-full.txt`,
  487KB of HTML).
- A cost frame with a non-finite value is dropped rather than rendered, so a missing field never
  displays a healthy-looking `$0.00`.

---

## Tools and transport

The agent holds every tool, including both data products. **It decides when to unlock.** There is
no harness rule choosing plain fetch over Unlocker, no escalation ladder, no "if the page looks
like X" branch. The transport is a judgement.

That only works if the cost is visible at the moment of choosing, so:

- Every tool declares its price and typical latency in its description. Plain fetch is free and
  instant; a SERP call is cheap and fast; an unlock is 13–16s and costs real money.
- The `why` on a tool call must justify the **spend**, not only the intent. *"A roundup that likely
  names ten vendors in its body, worth 15 seconds"* is a reason. *"Fetching the page"* is not.
- Refusals come back as prose the agent can act on, never as exceptions. A budget refusal reads
  like advice — the agent should degrade into finishing, not crash.

Breadth is the default posture: many searches, few unlocks. Search is how you find out what exists;
unlocking is how you read the one page that names ten things at once.

## Budget

- Reserved **before** work, per work item — not per tool call, and not as an all-or-nothing gate.
  v1 could only choose all the work or none of it.
- The fan-out is sized to what remains affordable. Twelve targets and budget for five means five
  are spawned, and the user is told.
- Exhaustion returns a **partial map with an honest stop reason**, never an error.
- Every termination path is a distinct, named reason surfaced to the user: budget ceiling,
  frontier empty, converged, wall-clock, cancelled.

---

## Organization

```
prompts/
├── doctrine/          shared knowledge, composed into agents — NUMBERED (reading order)
├── agents/            one file per agent type — NOT numbered (the orchestrator decides order)
└── schemas/           output contracts; Zod derived from these, never hand-written per prompt
```

Numbering agents by stage would make the directory the pipeline. Knowledge has a reading order;
agents do not.

**Enforced by CI:**

- Every file in `agents/` is reachable — routed to by something. A prompt nobody can invoke fails
  the build. (v1 shipped 5 dead prompts under 816 green tests.)
- Every `includes:` resolves.
- `agent:` frontmatter equals the filename.
- Each prompt's JSON block is generated from its schema, so prompt and validator cannot drift.
- The engine contains no `process.env`, no DOM API, no vendor name.

---

## Open

- What the user walks away with: explorable graph, written brief, ranked table, or vault.
  This defines "done" for the orchestrator and everything downstream follows from it.
- Model tiering: which model runs the orchestrator vs the investigators. Cost is dominated by the
  investigator tier.
