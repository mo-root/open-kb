# Query Families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-product query generation dealt across three families — plain (templates), debranded (model), branded (templates) — with a strip step, family tagging through the whole pipeline, an assess loop that widens per product per family, and clickable references including the anchor's own catalog.

**Architecture:** Pure template expansion lives in `packages/core/src/families.ts` (tested). The sweep (`packages/sweep/src/sweep.ts`) folds the strip into the existing per-product catalog call, stamps family/product on every query mechanically, gives EVERY product an opening hand (the funding contest dies), and holds unreleased templates in a per-product reserve the assess loop draws from. The web surfaces family chips and `foundAt` links.

**Tech Stack:** TypeScript, zod, `ai` SDK structured outputs (Gemini via OpenRouter), vitest, Next.js 16.

## Global Constraints

- `packages/core/src/**` stays pure: no `process.env`, no vendor names, no HTTP framing. Enforced by `scripts/check-core-purity.mjs` (runs inside `pnpm check`).
- `prompts/render()` REJECTS a call whose keys don't all appear as `{{placeholders}}` in the prompt file, and a file with placeholders not supplied. Every new placeholder needs both sides changed together.
- Gemini structured output rejects array-length constraints in schemas — never use `.min()`/`.max()` on arrays in a model-facing zod schema; clamp in code after the call (existing pattern at `sweep.ts:961`).
- `pnpm check` = purity gate + `tsc -b` + web typecheck. Must pass before every commit.
- `pnpm test` = vitest over `packages/core/tests` + `tests/`. Must pass before every commit.
- No cost estimates in code comments or docs — cost is measured by span accounting at runtime.
- Comment style: repo comments explain the measured failure that motivated a rule. Match that idiom; no filler comments.
- Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: The family module (pure, tested)

**Files:**
- Create: `packages/core/src/families.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/tests/families.test.ts`

**Interfaces:**
- Consumes: nothing (pure strings).
- Produces:
  ```ts
  export type QueryFamily = "plain" | "debranded" | "branded"
  export interface FamilyQuery {
    q: string
    family: QueryFamily
    product: string   // the product this query hunts alternatives for
    term: string      // the stripped term it expanded from; "" for branded
    why: string       // one line: what this shape buys
  }
  export function openingHand(product: string, terms: string[]): { open: FamilyQuery[]; reserve: FamilyQuery[] }
  ```
  Task 3 imports `openingHand`, `FamilyQuery`, `QueryFamily` from `@open-kb/core`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/families.test.ts
import { describe, expect, it } from "vitest"
import { openingHand } from "../src/families.js"

describe("openingHand", () => {
  it("opens with the bare term, its alternatives, and the branded alternatives", () => {
    const { open } = openingHand("Web Scraper API", ["web scraper", "web scraping api"])
    expect(open.map((q) => q.q)).toEqual([
      "web scraper",
      "web scraper alternatives",
      "Web Scraper API alternatives",
    ])
    expect(open[0]).toMatchObject({ family: "plain", product: "Web Scraper API", term: "web scraper" })
    expect(open[2]).toMatchObject({ family: "branded", term: "" })
  })

  it("reserves the remaining plain shapes, the extra terms, and branded vs", () => {
    const { reserve } = openingHand("Web Scraper API", ["web scraper", "web scraping api"])
    expect(reserve.map((q) => q.q)).toEqual([
      "best web scraper",
      "web scraper vs",
      "top web scraper companies",
      "open source web scraper",
      "web scraping api",
      "Web Scraper API vs",
    ])
  })

  it("drops case-insensitive duplicates: a product named exactly its term", () => {
    const { open, reserve } = openingHand("web scraper", ["web scraper"])
    const all = [...open, ...reserve].map((q) => q.q.toLowerCase())
    expect(new Set(all).size).toBe(all.length)
  })

  it("every query carries a non-empty why", () => {
    const { open, reserve } = openingHand("X", ["y"])
    for (const q of [...open, ...reserve]) expect(q.why.length).toBeGreaterThan(0)
  })

  it("tolerates an empty terms list: branded only", () => {
    const { open, reserve } = openingHand("Web Scraper API", [])
    expect(open.map((q) => q.q)).toEqual(["Web Scraper API alternatives"])
    expect(reserve.map((q) => q.q)).toEqual(["Web Scraper API vs"])
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm vitest run packages/core/tests/families.test.ts`
Expected: FAIL — cannot resolve `../src/families.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/families.ts
/**
 * The three query families, and the templates that guarantee two of them.
 *
 * A catalog prompt instructed on five clever shapes still skipped the single
 * highest-yield query a market has: the bare category term. One manual search
 * of "web scraper" returned the head-to-head field that forty model-written
 * queries missed. So the boring families are code: deterministic, free, and
 * immune to a model having a clever day. Only the debranded family — where
 * judgement actually pays — is written by a model.
 */
export type QueryFamily = "plain" | "debranded" | "branded"

export interface FamilyQuery {
  q: string
  family: QueryFamily
  /** The product this query hunts alternatives for. */
  product: string
  /** The stripped term it expanded from; "" for branded. */
  term: string
  /** One line: what this shape buys that the others do not. */
  why: string
}

/**
 * Deal one product's hand: a small opening across the families, and a reserve
 * of the remaining templates for the widening loop to draw from. The opening
 * is an opening, not a cap — a run widens on yield, and nothing here seals it.
 */
export function openingHand(product: string, terms: string[]): { open: FamilyQuery[]; reserve: FamilyQuery[] } {
  const [t0, ...rest] = terms.map((t) => t.trim()).filter(Boolean)
  const p = product.trim()

  const open: FamilyQuery[] = []
  const reserve: FamilyQuery[] = []

  if (t0) {
    open.push(
      plain(p, t0, t0, "the bare term — the center of the market, who competes head-to-head"),
      plain(p, `${t0} alternatives`, t0, "the comparison field, as buyers phrase it"),
    )
    reserve.push(
      plain(p, `best ${t0}`, t0, "ranked lists and roundups"),
      plain(p, `${t0} vs`, t0, "head-to-head comparison pages, vendors unnamed"),
      plain(p, `top ${t0} companies`, t0, "the vendor field by name"),
      plain(p, `open source ${t0}`, t0, "the DIY route and who outgrows it"),
    )
    for (const t of rest) reserve.push(plain(p, t, t, "the next strip term — a different door into the same market"))
  }

  open.push(branded(p, `${p} alternatives`, "the ecosystem that forms around the name: migration threads, comparison posts"))
  reserve.push(branded(p, `${p} vs`, "who reviewers weigh this product against"))

  return dedupe(open, reserve)
}

const plain = (product: string, q: string, term: string, why: string): FamilyQuery => ({
  q, family: "plain", product, term, why,
})
const branded = (product: string, q: string, why: string): FamilyQuery => ({
  q, family: "branded", product, term: "", why,
})

/** A product named exactly its category term makes branded and plain collide;
 *  the first spelling wins and the duplicate is never bought. */
function dedupe(open: FamilyQuery[], reserve: FamilyQuery[]): { open: FamilyQuery[]; reserve: FamilyQuery[] } {
  const seen = new Set<string>()
  const take = (qs: FamilyQuery[]) =>
    qs.filter((x) => {
      const k = x.q.trim().toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  return { open: take(open), reserve: take(reserve) }
}
```

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, next to the other exports add:

```ts
export { openingHand, type FamilyQuery, type QueryFamily } from "./families.js"
```

- [ ] **Step 5: Run tests and the full check**

Run: `pnpm vitest run packages/core/tests/families.test.ts && pnpm check`
Expected: PASS, purity gate clean (no env, no vendor names in the new file).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/families.ts packages/core/src/index.ts packages/core/tests/families.test.ts
git commit -m "feat(core): query families — templates guarantee plain and branded

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The doctrine and the rewritten catalog prompt

**Files:**
- Create: `prompts/doctrine/07-query-families.md`
- Modify: `prompts/agents/catalog.md` (rewrite body; add `07-query-families` to `includes`)
- Modify: `prompts/agents/assess.md` (add `{{families}}` and `{{reserve}}` placeholders + widening doctrine; add `07-query-families` to `includes`)
- Test: `packages/core/tests/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: `loadPrompt`/`render` from `packages/core/src/prompts.ts` — `render` throws if supplied keys and `{{placeholders}}` don't match exactly.
- Produces: `catalog.md` renders with keys `{ anchor, target, product, productDoes, market, centrality, sells, buyer, siblings, coinages }` (UNCHANGED list — Task 3 depends on this). `assess.md` renders with its existing keys `{ anchor, sells, buyer, capabilities, waves, hosts, asked, angles, sample }` PLUS `families` and `reserve` (Task 4 depends on this).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/tests/prompts.test.ts` (follow the file's existing pattern for loading with an explicit agents dir — read the top of the file first):

```ts
describe("query-families doctrine", () => {
  it("catalog includes the families doctrine and keeps its placeholder set", () => {
    const p = loadPrompt("catalog", "prompts/agents")
    expect(p.body).toContain("plain")
    expect(p.body).toContain("debranded")
    expect(p.body).toContain("branded")
    // the catalog call's render keys, unchanged — sweep.ts passes exactly these
    for (const k of ["anchor", "target", "product", "productDoes", "market", "centrality", "sells", "buyer", "siblings", "coinages"]) {
      expect(p.body).toContain(`{{${k}}}`)
    }
  })
  it("assess gained the family table placeholders", () => {
    const p = loadPrompt("assess", "prompts/agents")
    expect(p.body).toContain("{{families}}")
    expect(p.body).toContain("{{reserve}}")
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm vitest run packages/core/tests/prompts.test.ts`
Expected: FAIL — doctrine words and placeholders absent.

- [ ] **Step 3: Write the doctrine file**

`prompts/doctrine/07-query-families.md`:

```markdown
# Query families

Market-research queries come in families, the way SEO classifies search intent. Each family opens a
different door into the same market, and a map built through one door reads as complete while
missing what the other doors see.

- **plain** — the stripped category term and its commercial forms: the bare term, `best <term>`,
  `<term> vs`, `<term> alternatives`, `top <term> companies`, `open source <term>`. Finds the
  CENTER: who competes head-to-head and how the market talks about itself. These are template
  queries written by code; you never need to write one, and you must never avoid a category term
  out of cleverness — the category is not a brand.
- **debranded** — the job as an outcome, the moment it breaks, the DIY route, where buyers argue.
  No vendor and no category label. Finds SUBSTITUTES and adjacent solvers no comparison article
  lists. This is the family YOU write, because a template cannot know the job or the failure.
- **branded** — the product's own name plus `alternatives` / `vs`. Finds the ecosystem that forms
  around a name. Template-written; the coinage ban is reversed for this family only, deliberately.

## The agent-demand lens

The map leans developer, on purpose. When the product's buyer can be an AI agent or the team
building one, queries from that world matter more than another synonym: the MCP server for this
job, the agent harness it plugs into, the tool-call integration, the failure an agent's run hits
that a human's script never did. The lens applies across families and is gated hard: name the new
consumer, the new socket and the new failure, or skip it. A pump manufacturer cannot fill the
slots, and a query that pretends it can spends budget invisibly.
```

- [ ] **Step 4: Rewrite `prompts/agents/catalog.md`**

Frontmatter becomes `includes: [04-search-craft, 06-breadth, 07-query-families]`. Keep the header block (product/job/market/siblings/sells/buyer context lines) and the Absolute rules section VERBATIM — they are measured. Replace the "Spend your queries across these shapes" section and the demand-wave section with:

```markdown
## First: strip the product

Before any query, strip {{product}} to the 1–3 terms a buyer with no vendor in mind would actually
type when shopping for this job — ordered, closest first. `Web Scraper API` strips to
`web scraper`, then perhaps `web scraping api`. A term is a category a stranger searches, not a
description: three words or fewer, no brand, no coinage. Return them in `terms`. Code expands the
plain and branded families from your terms; you never write those queries.

## Then: write ONLY the debranded family

Write up to {{target}} debranded queries. The plain center and the branded ecosystem are already
bought from your terms, so every query you write must earn its place by finding what those cannot:

1. **The job, as an outcome.** What the buyer is trying to achieve, naming no product category.
   Finds the substitutes solving the same problem a different way.
2. **The moment it breaks.** The gatekeeper and its signature, or the failure everyone in this
   market hits. Two to four words.
3. **The DIY route.** The open-source or hand-rolled way, plus the word meaning it stopped working.
4. **Where this product's buyers argue.** The forum, Q&A tag or newsletter for this job.

Apply the agent-demand lens from the doctrine: if this product's buyer can be an AI agent or the
team building one, at least one of your queries comes from that world — and if you cannot name the
consumer, the socket and the failure, the lens does not apply and no query should pretend it does.
```

- [ ] **Step 5: Extend `prompts/agents/assess.md`**

Add `07-query-families` to its `includes`. After the existing per-run context lines, add:

```markdown
What each family has bought so far, and what remains unreleased:

    {{families}}

Template queries still held in reserve, per product:

    {{reserve}}

Widening is per product, per family. A product whose queries keep returning the same hosts is a
door already walked through — draw a DIFFERENT family or its next term from reserve. A family
returning fresh hosts on a product is paying — release more of its reserve. A product whose whole
hand came back thin gets more, taken from nobody. Ask for reserve releases in `draw`
(product + how many), and write fresh debranded queries only for gaps no template can reach.
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/tests/prompts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prompts/doctrine/07-query-families.md prompts/agents/catalog.md prompts/agents/assess.md packages/core/tests/prompts.test.ts
git commit -m "feat(prompts): family doctrine — strip step, debranded-only catalog, widening assess

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire families through the sweep

**Files:**
- Modify: `packages/sweep/src/sweep.ts`
- Modify: `packages/web/app/api/map/route.ts` (make `queries` a pure optional override)
- Modify: `packages/web/components/build/BuildWorkflow.tsx` (stop sending `queries`)

**Interfaces:**
- Consumes: `openingHand`, `FamilyQuery`, `QueryFamily` from `@open-kb/core` (Task 1); the catalog prompt's unchanged render keys (Task 2).
- Produces (Task 4 and 5 depend on these):
  ```ts
  type SweptQuery = PlannedQuery & { family: QueryFamily; product?: string; term?: string }
  // asked: SweptQuery[]              — every query fired, tagged
  // reserve: Map<string, FamilyQuery[]> — per product, unreleased templates
  // Entity gains: families?: QueryFamily[]  (alongside foundBy)
  // `searched` result frames gain: family, product
  // report gains: families: Record<string, number>, strips: {product, terms[]}[], readPages: string[]
  // Decomposition products gain: foundAt (url or "")
  ```

- [ ] **Step 1: Type the tagged query**

Below `export type PlannedQuery = z.infer<typeof PlannedQuery>` (sweep.ts:283) add:

```ts
import type { FamilyQuery, QueryFamily } from "@open-kb/core"

/** A query as the sweep fires it: the model's PlannedQuery plus the mechanical
 *  tags. Family and product are stamped in code, never asked of the model —
 *  a tag the model can forget is a tag the join cannot rely on. */
export type SweptQuery = PlannedQuery & { family: QueryFamily; product?: string; term?: string }
```

Change `Entity`'s type extension (sweep.ts:296) to:

```ts
export type Entity = z.infer<typeof Entity> & { foundBy?: string[]; families?: QueryFamily[] }
```

- [ ] **Step 2: Product citations from the understand call**

In the `Decomposition` zod (sweep.ts:196–201), extend products:

```ts
products: z.array(
  z.object({
    name: z.string(),
    does: z.string().describe("what this product does, stripped of the company's own naming"),
    foundAt: z
      .string()
      .describe("the url of the company's own page that establishes this product, copied from the pages given; empty string if none does"),
  }),
),
```

Add one line to `prompts/agents/understand.md` where products are described: "For each product, copy into `foundAt` the url of the page that establishes it — the product pages carry their urls — or an empty string if only the homepage mentions it."

Also capture which pages the understand call read. Find the `read` helper that fills `pages` (near sweep.ts:660–700, the surfaces loop) and collect urls:

```ts
const readPages: string[] = []
// inside read(), after a successful page is pushed onto `pages`:
readPages.push(url)
```

(Adapt the variable name to the actual parameter in `read`; the point is: one url per page that reached `pages`, in order.)

- [ ] **Step 3: Fold the strip into the catalog call and kill the funding contest**

Replace the funding block (sweep.ts:872–911, `queues` through the `missed` warning) and the catalog calls (913–948) with:

```ts
  // Every product gets a hand. The funding contest died with the spec of
  // 2026-08-04: a product left unfunded is an entire market the map never
  // sees, which is the exact failure phase 3 exists to prevent. Core markets
  // still go first so the pool starts on what the company is bought for.
  const queues = ranked.map((c) => ({
    market: c,
    products: (c.covers.length ? c.covers : [c.name]).slice(),
  }))
  const funded: { market: (typeof ranked)[number]; product: string }[] = []
  {
    let moved = true
    while (moved) {
      moved = false
      for (const q of queues.filter((x) => x.market.centrality === "core")) {
        const p = q.products.shift()
        if (p) { funded.push({ market: q.market, product: p }); moved = true }
      }
    }
    moved = true
    while (moved) {
      moved = false
      for (const q of queues.filter((x) => x.market.centrality !== "core")) {
        const p = q.products.shift()
        if (p) { funded.push({ market: q.market, product: p }); moved = true }
      }
    }
  }
  say("plan", `${funded.length} products, every one dealt an opening hand`)

  // Debranded ask per product. Small on purpose: the templates already hold
  // the center, so the model's few are spent where templates cannot go.
  const debrandedAsk = Math.max(2, Math.min(PER_PRODUCT, 3))

  const strips: { product: string; terms: string[] }[] = []
  const reserve = new Map<string, FamilyQuery[]>()

  const catalogs = await Promise.all(
    funded.map(({ market, product }) =>
      call(
        "plan",
        `catalog: ${product}`,
        z.object({
          terms: z.array(z.string()).describe("1-3 terms a buyer types for this job, ordered, closest first"),
          queries: z.array(PlannedQuery),
        }),
        prompt("catalog", {
          anchor,
          target: debrandedAsk,
          product,
          productDoes: market.does,
          market: market.name,
          centrality: market.centrality,
          sells: decomp.sells,
          buyer: decomp.buyer,
          siblings:
            market.covers.filter((c) => c !== product).join(", ") || "(nothing else in this market)",
          coinages: decomp.coinages.join(", "),
        }),
        { think: "low", maxOutputTokens: 180 * debrandedAsk + 6_000 },
      ).then((out) => {
        const terms = out.terms.map((t) => t.trim()).filter(Boolean).slice(0, 3)
        strips.push({ product, terms })
        const hand = openingHand(product, terms)
        reserve.set(product, hand.reserve)
        const asFired = (fq: FamilyQuery): SweptQuery => ({
          q: fq.q,
          intent: fq.family === "plain" ? "evaluation" : "switching",
          platform: "web",
          why: fq.why,
          market: market.name,
          family: fq.family,
          product: fq.product,
          term: fq.term,
        })
        const debranded: SweptQuery[] = out.queries.map((q) => ({
          ...q,
          market: market.name,
          family: "debranded" as const,
          product,
        }))
        return [...hand.open.map(asFired), ...debranded.slice(0, debrandedAsk)]
      }),
    ),
  )
```

Then adapt the downstream lines: `catalogs.flatMap((c) => c.queries)` becomes `catalogs.flat()`; the dedupe filter keeps working on `q.q`. The clamp `planned.slice(0, target)` becomes an OVERRIDE, not a default:

```ts
  const planned = cat.queries
  // opts.queries is now an override for scripts that want a bounded probe.
  // Left unset — the normal case — the opening is the product count times the
  // hand, and the ceiling on the RUN is the spend ceiling, not a query quota.
  const queries = opts.queries !== undefined ? planned.slice(0, target) : planned
```

`asked`, `queries`, and every downstream array change type from `PlannedQuery[]` to `SweptQuery[]`. TypeScript will walk you to each site; there is no logic change in them.

- [ ] **Step 4: Carry the tags through firing and the join**

In `runOne` (sweep.ts:1050): `hits.push({ ...h, q: r.query, intent: batch[j]!.intent })` becomes

```ts
for (const h of r.hits) hits.push({ ...h, q: r.query, intent: batch[j]!.intent, family: batch[j]!.family, product: batch[j]!.product })
```

and the `searched` frame gains two fields after `platform`:

```ts
family: batch[j]!.family,
product: batch[j]!.product ?? "",
```

In the foundBy join (sweep.ts:1383–1403), alongside `marketOf` add `familyOf`:

```ts
const familyOf = new Map(asked.map((q) => [q.q, q.family]))
```

and inside the entity loop, next to the `counts` fill:

```ts
const fams = new Map<QueryFamily, number>()
for (const h of rows) {
  const f = familyOf.get(h.q)
  if (f) fams.set(f, (fams.get(f) ?? 0) + 1)
}
if (fams.size) e.families = [...fams.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
```

- [ ] **Step 5: Report what the families did**

In the `report` object (sweep.ts:1606) add:

```ts
families: count(asked.map((q) => q.family)),
strips,
readPages,
```

And right before the report, say it — a family contributing nothing must be reported, not absorbed:

```ts
{
  const fam = count(asked.map((q) => q.family))
  for (const f of ["plain", "debranded", "branded"] as const) {
    if (!fam[f]) say("plan", `the ${f} family asked nothing this run — its doctrine or templates have a hole`)
  }
}
```

- [ ] **Step 6: The web sends no quota**

`packages/web/app/api/map/route.ts:87`: `const requested = body.queries === undefined ? 40 : Number(body.queries)` — when `body.queries` is undefined, pass `undefined` through to the sweep instead of 40 (keep the 1..MAX_QUERIES validation for the defined case; `createRun(domain, queries)` may need its second argument to accept `number | undefined` — follow the type).

`packages/web/components/build/BuildWorkflow.tsx`: delete the `OPENING_QUERIES` constant and its comment block, and send `body: JSON.stringify({ domain: target })`.

- [ ] **Step 7: Check and commit**

Run: `pnpm check && pnpm test`
Expected: both clean. (No sweep unit tests exist; the type walk plus purity plus web typecheck is the gate here — live validation is Task 6.)

```bash
git add packages/sweep/src/sweep.ts packages/web/app/api/map/route.ts packages/web/components/build/BuildWorkflow.tsx prompts/agents/understand.md
git commit -m "feat(sweep): every product dealt a family hand — strip folded into catalog, tags through the join

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The widening loop draws from reserve

**Files:**
- Modify: `packages/sweep/src/sweep.ts` (assess loop, sweep.ts:1164–1230)

**Interfaces:**
- Consumes: `reserve: Map<string, FamilyQuery[]>`, `asked: SweptQuery[]`, `strips` (Task 3); assess prompt placeholders `families`, `reserve` (Task 2).
- Produces: assess verdicts that release reserve templates and add debranded follow-ups, all entering the same queue.

- [ ] **Step 1: Build the family and reserve tables for the prompt**

Immediately before the `verdict` call (sweep.ts:1174), add:

```ts
      // Per-family and per-product yield, computed from what was actually
      // asked and what actually landed — the table the widening judgement
      // reads. hostsOf is O(hits) per round; rounds are rare.
      const hostOfHit = (u: string) => {
        try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
      }
      const famTable = (() => {
        const rowsByFam = new Map<string, { asked: number; hosts: Set<string> }>()
        const rowsByProd = new Map<string, { asked: number; hosts: Set<string> }>()
        for (const q of asked) {
          const f = rowsByFam.get(q.family) ?? { asked: 0, hosts: new Set<string>() }
          f.asked += 1
          rowsByFam.set(q.family, f)
          if (q.product) {
            const p = rowsByProd.get(q.product) ?? { asked: 0, hosts: new Set<string>() }
            p.asked += 1
            rowsByProd.set(q.product, p)
          }
        }
        for (const h of hits) {
          const q = asked.find((x) => x.q === h.q)
          if (!q) continue
          const host = hostOfHit(h.url)
          if (!host) continue
          rowsByFam.get(q.family)?.hosts.add(host)
          if (q.product) rowsByProd.get(q.product)?.hosts.add(host)
        }
        const famLines = [...rowsByFam.entries()].map(
          ([f, v]) => `  ${f} — ${v.asked} queries, ${v.hosts.size} distinct hosts`,
        )
        const prodLines = [...rowsByProd.entries()].map(
          ([p, v]) => `  ${p} — ${v.asked} queries, ${v.hosts.size} hosts`,
        )
        return { families: famLines.join("\n"), products: prodLines.join("\n") }
      })()
      const reserveLines = [...reserve.entries()]
        .filter(([, v]) => v.length)
        .map(([p, v]) => `  ${p} — ${v.length} held: ${v.map((x) => `"${x.q}"`).join(", ")}`)
        .join("\n") || "  (all reserves released)"
```

- [ ] **Step 2: Extend the assess schema and prompt args**

The `verdict` call's zod gains `draw`, and its prompt args gain the two tables:

```ts
        z.object({
          enough: z.boolean().describe("is this a map worth showing, or is something obviously missing?"),
          missing: z.string().describe("what is thin or absent, one line. Empty if nothing is."),
          draw: z
            .array(z.object({ product: z.string(), n: z.number() }))
            .describe("reserve template queries to release, per product. Empty if none."),
          queries: z.array(PlannedQuery).describe("fresh debranded queries aimed at what no template can reach. Empty if enough."),
        }),
```

and in the `prompt("assess", {...})` object add:

```ts
          families: `${famTable.families}\n${famTable.products}`,
          reserve: reserveLines,
```

- [ ] **Step 3: Honor the draw, then the fresh queries**

After the `verdict.enough` early-return (sweep.ts:1200–1204), before the fresh-queries dedupe, release reserves:

```ts
      // Reserve first: a held template is a query already judged worth its
      // family, so it outranks a freshly invented one.
      const released: SweptQuery[] = []
      for (const d of verdict.draw ?? []) {
        const held = reserve.get(d.product)
        if (!held?.length) continue
        for (const fq of held.splice(0, Math.max(1, Math.floor(d.n)))) {
          released.push({
            q: fq.q,
            intent: fq.family === "plain" ? "evaluation" : "switching",
            platform: "web",
            why: fq.why,
            market: asked.find((x) => x.product === fq.product)?.market ?? "",
            family: fq.family,
            product: fq.product,
            term: fq.term,
          })
        }
      }
```

The existing `fresh` block then stamps its model-written queries before enqueueing:

```ts
      const fresh = verdict.queries
        .filter((q) => !seen.has(q.q.trim().toLowerCase()))
        .slice(0, Math.max(1, Math.floor(target / 2)))
        .map((q): SweptQuery => ({ ...q, family: "debranded" }))
```

Both `released` and `fresh` go through the same dedupe-against-`seen` and into the queue wherever the current code enqueues `fresh` (follow the existing `asked.push` / queue-feed lines a few lines below and feed `[...released, ...fresh]` through them). Note `target` may now be undefined-driven — replace `Math.floor(target / 2)` with `20` and a one-line comment: a round's fresh-invention allowance, distinct from reserve releases which are pre-judged.

- [ ] **Step 4: Check and commit**

Run: `pnpm check && pnpm test`
Expected: clean.

```bash
git add packages/sweep/src/sweep.ts
git commit -m "feat(sweep): widening draws reserve per product per family before inventing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: References and family chips in the web

**Files:**
- Modify: `packages/web/lib/kb-from-run.ts` (catalog gains foundAt; notes gain families; view carries readPages)
- Modify: `packages/web/lib/viewTypes.ts` (types for the above — read it first, extend in place)
- Modify: `packages/web/components/kb/ProductsTab.tsx` (foundAt links on catalog cards; sells/buyer sources)
- Modify: `packages/web/components/build/SearchesPanel.tsx` (family on each search row)
- Modify: `packages/web/components/kb/NoteView.tsx` (family chips on an entity)

**Interfaces:**
- Consumes: `run.result.decomposition.products[].foundAt`, `entity.families`, report `readPages`, searched frames' `family` (Tasks 3–4).
- Produces: user-visible links and chips; no new exports.

- [ ] **Step 1: Carry the fields through the view**

`kb-from-run.ts:259` becomes:

```ts
    catalog: (run.result.decomposition?.products ?? []).map((p) => ({
      name: p.name,
      does: p.does,
      foundAt: p.foundAt || undefined,
    })),
    readPages: (run.result.report?.readPages as string[] | undefined) ?? [],
```

and where notes are built (kb-from-run.ts:251, next to `foundBy: p.entity.foundBy`):

```ts
        families: p.entity.families,
```

Extend the matching types in `viewTypes.ts` (`catalog` entries gain `foundAt?: string`; the view gains `readPages: string[]`; note refs gain `families?: string[]`). Follow the existing type names in that file exactly — do not invent parallel types.

- [ ] **Step 2: Links on the catalog cards**

In `ProductsTab.tsx`, the catalog card (lines 174–182) becomes:

```tsx
              {catalog.map((p) => (
                <div key={p.name} className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-4">
                  <div className="min-w-0 text-sm font-medium text-slate-100">{p.name}</div>
                  <p className="mt-1 text-[13px] leading-snug text-slate-400">{p.does}</p>
                  {p.foundAt && (
                    <a
                      href={p.foundAt}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block max-w-full truncate font-mono text-[10px] text-sky-400 hover:text-sky-300"
                      title={p.foundAt}
                    >
                      {(() => { try { return new URL(p.foundAt).pathname } catch { return p.foundAt } })()}
                    </a>
                  )}
                </div>
              ))}
```

Under the "What this company sells" explainer paragraph (lines 169–172), cite the read:

```tsx
            {readPages.length > 0 && (
              <p className="mb-3 font-mono text-[10px] text-slate-600">
                read from:{" "}
                {readPages.map((u, i) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="text-sky-500 hover:text-sky-400">
                    {i > 0 ? " · " : ""}{(() => { try { return new URL(u).pathname || "/" } catch { return u } })()}
                  </a>
                ))}
              </p>
            )}
```

`ProductsTab` gains a `readPages?: string[]` prop, defaulted `[]`, passed from its caller (grep for `<ProductsTab` — one call site in `KbBrowser.tsx`).

- [ ] **Step 3: Family on searches and notes**

`SearchesPanel.tsx`: read the file first. `readSearched` parses the `searched` frames — add `family` (string, optional) to the parsed shape, and render it as the row's leading chip (the panel already renders `source`/intent per row; family goes beside it, same chip styling, distinct color per family: sky for plain, violet for debranded, amber for branded).

`NoteView.tsx`: where `foundBy` is rendered (grep `foundBy` in the file), add beside it:

```tsx
{note.families?.map((f) => (
  <span key={f} className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
    found via {f}
  </span>
))}
```

(Adapt the exact prop path to how NoteView receives the note — follow `foundBy`'s path.)

- [ ] **Step 4: Check and commit**

Run: `pnpm check`
Expected: clean, including the web typecheck.

```bash
git add packages/web
git commit -m "feat(web): foundAt links on the catalog, family chips on searches and notes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Live validation — the screenshot test

**Files:**
- Create: `scripts/hand.ts` (print one company's opening hands without searching)
- Modify: `package.json` (add `"hand": "tsx scripts/hand.ts"` to scripts)

**Interfaces:**
- Consumes: the whole pipeline.
- Produces: a written verdict against the spec's bar, in the run reports.

- [ ] **Step 1: The cheap probe first**

The owner's stated preference is to test things individually before full runs. The cheapest honest probe is a bounded run: `pnpm sweep <domain>` with the `queries: 12` override (the override survives exactly for this), reading the printed queries and `searched` frames before paying for a full map. Only build `scripts/hand.ts` if that proves too noisy to judge query quality from — and model it on `scripts/discover.ts`'s setup block if so. Do not build a parallel harness for one inspection when the override answers the question.

- [ ] **Step 2: Run the spread**

```bash
pnpm sweep brightdata.com
pnpm sweep grundfos.com
pnpm sweep resend.com
```

- [ ] **Step 3: Judge against the bar, in writing**

For each run, from the printed report and searched output check and record (a short note appended to the PR/commit message or `docs/superpowers/specs/2026-08-04-query-families-design.md` under a "## First measurement" heading):

1. `report.families` — all three families asked > 0 on every run.
2. brightdata: plain-family entities include the head-to-head scraping field (Apify, Oxylabs, Zyte, ScraperAPI or Scrapy — at least three of five).
3. brightdata: at least one agent-demand query fired (grep the queries for mcp / agent / harness).
4. grundfos: ZERO agent-demand queries (the three-slot gate held).
5. debranded contributed entities plain did not (compare per-family host sets from the searched frames).
6. Every product in the decomposition appears in `strips` (nobody unfunded).
7. `report.readPages` non-empty and catalog cards in the web UI link out.

- [ ] **Step 4: Fix what failed, re-run the failing company only, commit**

```bash
git add -A
git commit -m "test: first measurement of the family engine against the five-company bar

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: families/doctrine → T2; strip → T3 (folded into catalog call); templates → T1; opening hand + no funding contest → T3; widening per product per family → T4; tagging through foundBy → T3 steps 4–5; references (foundAt, readPages, family chips) → T3 step 2 + T5; agent-demand lens → T2 (doctrine + catalog + gate) and T6 checks 3–4; "family contributing nothing is reported" → T3 step 5; bar → T6.
- Deliberately out of scope: `sells`/`buyer` per-sentence citations beyond `readPages` (the pages-read list is the honest citation the run actually has); renaming map vocabulary labels (owner hasn't chosen new words).
- Type consistency: `SweptQuery` defined T3 step 1, consumed T3 steps 3–5 and T4; `FamilyQuery`/`openingHand` defined T1, consumed T3/T4; assess `draw` defined T4 step 2, consumed T4 step 3; `foundAt` defined T3 step 2, consumed T5.
