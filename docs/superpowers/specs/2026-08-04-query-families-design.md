# Query families and the self-widening sweep

Date: 2026-08-04. Status: approved in conversation; supersedes the query-shape section of
`prompts/agents/catalog.md` and extends `docs/swarm-spec.md` phase 3.

## The defect this fixes

The catalog prompt writes 3–5 clever de-branded queries per product and instructs the model to name
no product category at all. That de-branded the queries so hard it de-categorized them: `web
scraper` names no vendor, yet nothing in the current doctrine will ever type it. One plain Google
search for `web scraper` returns Apify, Data Miner, Oxylabs, Scrapy and the GitHub topic page — the
head-to-head field from a single boring query. v1 knew this: seven of its ten shapes were plain
searches, and the bare term came first. The clever queries find a market's edges; the plain term
finds its center, and the current engine skips the center.

The spec's branded channel (`<product> alternatives`, `<product> vs`) is also unbuilt.

## The idea

Market-research queries come in families, the way SEO classifies search intent. Each family opens a
different door into the same market, and a map built through one door reads as complete while
missing what the other doors see. So: per product, queries are dealt across families — and the mix
is the agent's call, not a quota. Flexible, however the agent wants it; what is guaranteed is that
the families exist, the agent understands what each one is for, and the plain center can never be
skipped again.

## The families (doctrine, not an enum)

Defined in prompts so they are editable without a rebuild, and open-ended — the doctrine file is
the registry, and an agent that can justify a new family may use it.

- **plain** — the stripped category term and its commercial-investigation forms: the bare term,
  `best <term>`, `<term> vs`, `<term> alternatives`, `top <term> companies`, `open source <term>`.
  SEO would call these commercial-investigation intent. Finds the CENTER: who competes head-to-head,
  and how the market talks about itself. These queries are boring on purpose; boring is the feature.
- **debranded** — the job as an outcome, the moment it breaks, the DIY route, where buyers argue.
  No vendor and no category word. Finds SUBSTITUTES and adjacent solvers that no comparison article
  lists. This is the only family the understand phase may ever use.
- **branded** — the product's own name: `<product> alternatives`, `<product> vs`, `<product>
  reviews`. Navigational/comparative intent. Finds the ecosystem that forms AROUND a name: the
  comparison posts, the migration threads, the review pages. The coinage ban is reversed for this
  family only, deliberately; it holds everywhere else.

## The agent-demand lens (the one deliberate tilt)

The map leans developer. For a product whose buyer can be an AI agent or the team building one, the
hand MUST include queries from that world: the MCP server for this job, the agent harness it plugs
into, the tool-call integration, the failure an agent run hits that a human script never did. This
is not a fourth family — it is a lens the agent applies across families (`mcp server for web
scraping` is plain; the agent-run failure is debranded). The existing three-slot gate holds: name
the new consumer, the new socket and the new failure, or skip it — a pump manufacturer cannot fill
the slots and no query should pretend it can. This tilt is the owner's chosen bias, stated here so
nobody later mistakes it for drift.

## Strip

Per product, a model step produces 1–3 terms a buyer would actually type, ordered by closeness:
`Web Scraper API` → `web scraper`, `web scraping api`, `data extraction tool`. The first term gets
the full plain-template expansion; the rest ride along as bare queries when the sweep widens. The
strip is a visible artifact on the map — the product, the terms it stripped to, and a reference to
the product page it was read from — because stripping is the method's hinge and a reader should be
able to audit it.

## Generation

- **Templates guarantee plain and branded.** Code expands them from the strip terms and the product
  name. Free, deterministic, cannot be forgotten by a model having a clever day.
- **The model writes debranded.** That is where judgement pays and templates cannot go.
- **The agent deals the hand.** Roughly five opening queries per product across the families —
  flexible in mix, and an OPENING, not a cap. No per-product seal.
- Every query carries `{ product, family, term, why }`. Every hit inherits it.

## The widening loop (the agentic part, stated plainly)

The agent's job is not writing the opening queries — templates and one model call do that. Its job
is deciding what to type NEXT after seeing what came back, which is what a human researcher does:

- queries returning the same hosts → repetition → switch family or pull the next strip term
- a family returning fresh hosts on this product → deepen it
- a product whose whole hand came back thin → it gets more, taken from nobody
- the map looks full and new queries only corroborate → say enough and stop

Per product, per family, judged on yield. Bounded by the spend ceiling underneath, never by a
per-product quota.

## Tagging and the graph

hit → query → product → market is the `foundBy` join that already exists; family joins it. The
graph is born attributed: every entity knows which product's search surfaced it and through which
door. UI shows the family on the entity and can filter by it.

## References, everywhere

- Catalog cards link `foundAt` — the company's own page that establishes each product. Captured
  today, dropped by the UI today.
- `sells` / `buyer` cite the pages they were read from.
- The strip artifact cites the product page it stripped.
- Entities keep their existing citations and gain the family chip.

Nothing on the map is unclickable, including what the anchor itself sells.

## The bar

- **The screenshot test, on ANY anchor:** the plain family must surface the head-to-head field that
  one manual search of the product's bare term returns. `web scraper` → Apify, Oxylabs, Scrapy is
  the illustration, not the benchmark; the bar is judged across the five-company spread (resend,
  clerk, brightdata, flexport, grundfos), never against one company.
- Debranded must still contribute entities the plain family missed — if it stops doing so on every
  product, its doctrine has rotted.
- A family contributing nothing across an entire run is reported, not silently absorbed.
- For developer-facing products, the agent-demand lens must actually fire: at least one query per
  such product from the agent/MCP/harness world.
- Cost is not estimated here. Every call is billed through span accounting at runtime and the run
  reports what it spent; estimates in a spec only go stale and mislead.
