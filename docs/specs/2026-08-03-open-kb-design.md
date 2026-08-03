---
date: 2026-08-03
status: draft for review
supersedes: nothing — this is v2, built fresh
---

# open-kb — design

## 1. What it is

Give it a company domain. It returns a map of the market around that company: the companies, what
they sell reduced to brand-free capability, and the typed relations between them. Every node and
every edge carries a source URL and a plain-language reason.

A domain is the primary input. A bare link, a GitHub repo, or a plain description of an idea are
alternate entry points into the same first step — they change what the lead reads to understand the
thing, and nothing downstream. An idea with no company behind it still yields a market map; it just
starts from the description instead of deriving one.

Users are founders and operators. The bar is that one of them finishes a run and knows where to
show up and who they're up against — not that the taxonomy is elegant.

**The hinge is de-branding.** A company describes itself in language it invented. Searching that
language returns only that company. You reach a market by describing *what the thing does*, in the
words a stranger would use.

## 2. The evidence this is built on

Every design decision below traces to something measured, not assumed. Full experiments in
`docs/research/`.

| finding | measurement |
|---|---|
| Describing the product beats naming its category | 2 queries of description found **15 vendors** vs **8** for the category label (software), **17 vs 8** (industrial). Overlap: 3 and 2. |
| Brand-anchored queries are weak discovery | Software: found 12 vendors to de-branded's 25. Industrial: **5 results, all junk, zero real companies.** |
| Query strategies barely overlap | Software: 5 of 32 domains appeared in more than one strategy. Industrial: **0 of 28.** |
| The cheap read route inverts by company type | Stripe: homepage is an empty JS shell, `llms.txt` is 65KB. Industrial: no `llms.txt` at all, homepage gives 8,335 chars to a free `curl`. |
| Compression is nearly free when structure exists | Stripe's 65KB `llms.txt` → 684 bytes of headings containing all 23 product names. |
| Status codes lie | Unlocker on `stripe.com`: **HTTP 200, zero bytes, 33–60s**, on two zones. `vercel.com/llms-full.txt`: **200 with 487KB of HTML.** |
| Snippet heuristics misclassify | A "is this a listicle" rule filed `iproyal`, `decodo`, `scrape.do`, `mailtrap`, `sender.net` as publishers. All are real vendors. |
| A rival writing "alternatives to X" is a rival | Those five announced themselves as competitors by buying SEO against the seed. Signal, not noise. |

## 3. The run

`stripe.com`, no ceiling, convergence-terminated.

1. **t=0.1s** — streams open. Stage rail, empty map, cost bar render. Zero model calls.
2. **t=0.2s** — lead's first turn. Prompt is the doctrine plus `Target: stripe.com. GO.`
3. **t=2.6s** — lead calls `fetch` on several candidate surfaces at once, each with a stated `why`.
   Trace rows appear carrying the reason next to the URL. *This is the first interesting thing on
   screen, and it is reasoning, not data.*
4. **t=3.5s** — the apex page returns 200 with almost no extractable text → `status: blocked`,
   `reason: "thin-render"`. A machine-readable summary returns 65KB → stored whole, lead receives an
   8KB slice plus a handle. No branch fires. The lead is simply told what happened.
5. **t=5.8s** — lead reads the stored bytes through a **free** projection tool, gets 684 bytes of
   structure, and writes the first nodes. Radar → *"card-fraud scoring on the authorization path."*
   **Thirteen nodes on the map at six seconds.**
6. **t=6–9s** — a second, independent read: how *third parties* describe this company, diffed
   against its own words. Catches a mis-framing before any search is bought.
7. **t=9–15s** — the lead writes missions to the board. Each names a lens and a brief in the
   market's language. Missions hit lanes as the JSON streams, not all at once when the turn ends.
8. **continuous** — investigator lanes drain the board. Each investigator searches, resolves who is
   real with free root fetches, unlocks only pages worth reading whole, and writes nodes and edges
   **as it finds them**.
9. **continuous** — the lead re-enters on its own declared condition, reads what landed, and writes
   more missions. Any investigator finding something picture-changing pulls it forward.
10. **end** — the lead judges that new searches are returning companies already on the map, and
    stops. The screen says why it stopped.

## 4. Architecture

```
packages/
├── core/         the engine. Lead loop, board, lanes, budget ledger, evidence store,
│                 event stream, tool contract, node/edge/evidence types.
│                 MUST NOT contain: a vendor name, a provider SDK, process.env,
│                 a DOM API, HTTP framing, or any URL convention.
├── providers/    adapters implementing core's interfaces: search, fetch, model.
│                 One directory per vendor. core never imports this.
├── cli/          argv, credentials, terminal rendering, NDJSON out.
└── web/          the demo. Transport and presentation only. Never re-derives a run fact.

prompts/
├── doctrine/     shared knowledge, composed into agents. Numbered — knowledge has a reading order.
├── agents/       one file per agent type. NOT numbered — the lead decides who runs.
└── schemas/      output contracts. Zod is derived from these; never hand-written per prompt.
```

**Dependency direction, one-way:** `core` imports nothing local. `providers → core` (types only).
`cli → core + providers`. `web → core + providers`. Nothing imports `web` or `cli`.

**Public surface:** a hand-written `core/src/api.ts` exporting ~8 symbols. Not `export *`.

## 5. The orchestrator

A `while` loop wrapped around one model conversation — the lead.

**The lead decides:** what the company sells, how to say that without its own words, what to search,
what is worth reading, what to investigate next and in what order, and when the map is done.

**The harness decides nothing about the market.** It owns exactly four things:

- **Money** — reserved before work, per item, settled at actuals. Not a limit; an accounting truth.
- **Evidence** — a quote is citable only if it is a literal substring of bytes this run fetched.
- **Transport truth** — a 200 with an empty or non-substantive body is a failure regardless of the
  status line. Content is sniffed, never trusted.
- **The clock** — per-task timeouts, and a runaway backstop far above any real run.

It never chooses a query, a URL, a lens, a node type, or a priority.

**Non-blocking spawn.** Writing a mission returns immediately. Lanes drain the board greedily: a lane
frees, the highest-priority mission starts. No barrier, no rounds, no wave counter.

## 6. The agents

**Lead.** Holds the full doctrine. Tools: `search`, `fetch`, `read`, `remember`, `recall`, `spawn`,
`retract`, `done`. Sees the map as it grows via `recall`, never by having it pushed into its prompt.

**Investigator.** Holds the doctrine minus the planning sections, plus one mission. Tools: `search`,
`fetch`, `read`, `remember`. Own context window. Returns a summary; its findings are already written.

Only the lead retracts. One editor.

## 7. The tools

| tool | who | cost | on failure |
|---|---|---|---|
| `search(queries[])` | both | cheap, fast | per-query status; a failed query doesn't fail the batch |
| `fetch(urls[], mode)` | both | free direct / expensive unlocked | `{status: blocked \| not_found \| thin}` with a reason in words |
| `read(handle, projection)` | both | **free** | returns what it could project |
| `remember(nodes, edges)` | both | free | rejects anything failing the evidence mint, saying why |
| `recall(query)` | lead | **free** | what the map already holds |
| `spawn(missions[])` | lead | free | returns immediately |
| `retract(id, why)` | lead | free | — |
| `done(reason)` | lead | — | ends the run |

**The agent chooses the transport.** No escalation ladder. Every tool declares its price and latency
in its description, and the `why` on a call must justify the spend, not only the intent.

**Refusals are prose, never exceptions.** An agent told "that domain is already mapped" adjusts. An
agent handed a stack trace loses its turn.

**Batch by default.** One `search` call takes many queries. One model turn buys a whole wave.

## 8. Data model

```ts
type Status = "found" | "not_found" | "blocked"

interface Evidence { url: string; quote: string; fetchedAt: string; status: Status }

interface Node {
  id: string
  kind: "company" | "capability" | "buyer"
  name: string
  what: string          // what it sells, to whom
  whyHere: string       // why it belongs on THIS map, against the anchor
  howFound: string      // the query or page that surfaced it
  evidence: [Evidence, ...Evidence[]]   // non-empty by type
  confidence: number    // computed by the harness, never self-reported
  contradicts: Evidence[]
}

interface Edge {
  from: string; to: string
  relation: "competitor" | "substitute" | "dependency" | "integration" | "shaper"
  whyHere: string
  howFound: string
  evidence: [Evidence, ...Evidence[]]
  confidence: number
}
```

`competitor` is head-on. `substitute` does the same job a different way. `shaper` is the incumbent
or standard everyone positions against without competing with directly. `dependency` and
`integration` are the stack around it.

**One mint function, no fallback branch.** No code path may synthesize a URL, a quote, or a source.
Contradicting evidence is kept, never dropped by a merge.

**Confidence is computed, not claimed.** From three inputs: how many *distinct domains* support the
claim, what tier those sources are (the company's own material > a third party writing about it > a
search snippet alone), and whether contradicting evidence exists. A claim with one snippet and no
corroboration is low regardless of how certain the model sounds. If a model self-assessment is kept
at all it lives in a separate field that no surface renders as trust. The exact weighting is tuned
against real runs — what is fixed here is that the harness owns the number.

## 9. Events

Four NDJSON streams, one JSON object per line.

```ts
Span { seq, ts, runId, agentId, parentId, kind, name, argsDigest,
       ms, ok, error?, tokensIn?, tokensOut?, usd, runningUsd }
```

`argsDigest` carries the real query or URL — the only place a viewer sees which question was bought.
`parentId` makes the spawn tree reconstructable and cost attributable per agent. Failed calls emit a
span too. A cost frame with a non-finite value is dropped rather than rendered, so a missing field
never displays a healthy-looking `$0.00`.

## 10. Termination

The run ends when **the lead judges that more searching won't close the remaining gaps** — new
queries returning companies already on the map. That makes map size a function of the market, not of
the budget.

Every stop is a distinct named reason on screen: `converged`, `board-empty`, `backstop-time`,
`backstop-cost`, `cancelled`, `failed`. A backstop firing is a bug signal, not a normal outcome.

Cost is measured throughout so we learn what a good run actually costs. No ceiling until the data
says what one should be.

## 11. Frontend

Lifted from the previous version, branding included. It consumes the streams above. Two decisions
carried over deliberately: the four-stream NDJSON format, and rendering the actual query text so a
viewer sees what was bought.

## 12. Build order

1. **Tool contract + evidence store + span stream.** Provable with a fake provider, no network.
2. **Providers.** Search and fetch against the real APIs, with content sniffing.
3. **Investigator alone.** One agent, one mission, hand-run. Prove a finding lands with real evidence.
   Needs a first-draft doctrine to run at all — write the minimum here (what de-branding is, what
   makes a claim citable) and let step 5 grow it.
4. **Lead + board + lanes.** The loop. Prove parallel fan-out and non-blocking spawn.
5. **Doctrine.** Written from the measurements, iterated against real runs. This is where most of
   the quality lives, and it is the step most likely to be under-budgeted.
6. **Web demo.** Streams into the lifted frontend.
7. **CLI**, then the skill.

## 13. What this is not

- Not a staged pipeline. There is no fixed sequence of steps in the engine.
- Not a ladder. No `try X, then Y` for reading a company — the route inverts by company type.
- Not a denylist. Host identity is resolved by a free fetch, not a regex on a title.
- No opportunity layer, no channel scouting, no persistence across runs.
- No prompt that cannot be reached by the graph. CI fails on a dead prompt.

## 14. Open

- Model tiering: which model runs the lead vs the investigators. Decided by testing, not by guessing.
- What a good run actually costs. Measured over the first ten real runs.
